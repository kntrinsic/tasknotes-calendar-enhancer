import type { App } from "obsidian";
import {
	asCallable,
	type CacheableProviderKey,
	type CacheableProviderTarget,
	getActiveGoogleCalendarService,
	getCacheableCalendarProviders,
	getEnabledProviderCalendarIds,
	getHostedGoogleConnectionState,
	getIcsSubscriptionSyncState,
	getOAuthConnectionGeneration,
	getTaskNotesPlugin,
	hasAnyEnabledIcsSubscription,
	type HostedGoogleConnectionState,
	isOAuthProviderConnected,
	isRecord,
	refreshOpenCalendarViews,
	safeCall,
	subscribeHostedGoogleClient,
	subscribeSingleProviderEvent,
} from "./tasknotesBridge";

export const CACHE_VERSION = 1;
export const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_FUTURE_CLOCK_SKEW_MS = 60_000;
export const MAX_CACHED_EVENTS_PER_PROVIDER = 1500;
export const MAX_PAYLOAD_BYTES = 512 * 1024;

export const CACHE_STORAGE_KEYS: Readonly<Record<CacheableProviderKey, string>> = {
	ics: "tnce:external-calendar-cache:ics:v1",
	"hosted-google": "tnce:external-calendar-cache:hosted-google:v1",
	"own-google": "tnce:external-calendar-cache:own-google:v1",
	microsoft: "tnce:external-calendar-cache:microsoft:v1",
};

export interface CachedProviderCalendar {
	id: string;
	summary: string;
	description?: string;
	backgroundColor?: string;
	primary?: boolean;
	canWrite?: boolean;
}

export interface CachedIcsSubscription {
	id: string;
	name: string;
	type: "remote" | "local";
	color: string;
	enabled: boolean;
	refreshInterval: number;
}

export interface CachedCalendarEvent {
	id: string;
	subscriptionId: string;
	title: string;
	description?: string;
	start: string;
	end?: string;
	allDay: boolean;
	location?: string;
	url?: string;
	rrule?: string;
	recurringEventId?: string;
	color?: string;
}

export interface ExternalCalendarCachePayload {
	version: number;
	provider: CacheableProviderKey;
	savedAt: number;
	connectionGeneration?: number;
	calendars: CachedProviderCalendar[];
	subscriptions: CachedIcsSubscription[];
	events: CachedCalendarEvent[];
}

interface ProviderRuntimeState {
	key: CacheableProviderKey;
	service: Record<string, unknown>;
	kind: "ics" | "oauth-calendar";
	liveSynced: boolean;
	syncSeq: number;
	disposed: boolean;
	sawHostedSignedIn: boolean;
	initialOAuthGeneration: number | null;
	ownOAuthConnected: boolean | null;
	icsPendingSubIds: Set<string>;
	icsInitializeFinished: boolean;
	cachedCalendars: CachedProviderCalendar[];
	cachedSubscriptions: CachedIcsSubscription[];
	cachedEvents: CachedCalendarEvent[];
	getLiveCalendars: (() => unknown) | null;
	getLiveSubscriptions: (() => unknown) | null;
	getLiveEvents: (() => unknown) | null;
	disposers: Array<() => void>;
}

interface PatchWrapperMeta {
	hadOwn: boolean;
	ownDescriptor: PropertyDescriptor | undefined;
	originalFn: (...args: unknown[]) => unknown;
	uninstalled: boolean;
}

const patchWrapperRegistry = new WeakMap<
	(...args: unknown[]) => unknown,
	PatchWrapperMeta
>();

/**
 * Installs a reversible wrapper on `target[methodName]`.
 * Supports stacked wrappers via passthrough if uninstalled out of order and
 * restores prototype lookup cleanly when the patched method was inherited.
 */
export function patchMethod<T extends object>(
	target: T,
	methodName: keyof T,
	wrapperFactory: (
		original: (...args: unknown[]) => unknown,
	) => (this: unknown, ...args: unknown[]) => unknown,
): (() => void) | null {
	const record = target as Record<PropertyKey, unknown>;
	const currentValue = record[methodName];
	if (typeof currentValue !== "function") {
		return null;
	}

	const hadOwn = Object.prototype.hasOwnProperty.call(target, methodName);
	const ownDescriptor = hadOwn ? Object.getOwnPropertyDescriptor(target, methodName) : undefined;
	if (hadOwn && ownDescriptor && !ownDescriptor.configurable && !ownDescriptor.writable) {
		return null;
	}

	const originalFn = currentValue as (...args: unknown[]) => unknown;
	const meta: PatchWrapperMeta = {
		hadOwn,
		ownDescriptor,
		originalFn,
		uninstalled: false,
	};

	const passthrough = function (this: unknown, ...args: unknown[]): unknown {
		return originalFn.apply(this ?? target, args);
	};

	const customWrapper = wrapperFactory(passthrough);
	const installed = function (this: unknown, ...args: unknown[]): unknown {
		if (meta.uninstalled) {
			return originalFn.apply(this ?? target, args);
		}
		return customWrapper.apply(this ?? target, args);
	};

	patchWrapperRegistry.set(installed, meta);
	record[methodName] = installed;

	return () => {
		if (meta.uninstalled) {
			return;
		}
		meta.uninstalled = true;

		if (record[methodName] === installed) {
			let restoreMeta = meta;
			for (
				let prevMeta = patchWrapperRegistry.get(restoreMeta.originalFn);
				prevMeta?.uninstalled;
				prevMeta = patchWrapperRegistry.get(restoreMeta.originalFn)
			) {
				restoreMeta = prevMeta;
			}
			if (restoreMeta.hadOwn && restoreMeta.ownDescriptor) {
				Object.defineProperty(target, methodName, restoreMeta.ownDescriptor);
			} else {
				Reflect.deleteProperty(target, methodName);
			}
		}
	};
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function readOptionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
	const value = record[key];
	return typeof value === "boolean" ? value : undefined;
}

export function sanitizeProviderCalendars(rawList: unknown): CachedProviderCalendar[] {
	if (!Array.isArray(rawList)) {
		return [];
	}

	const sanitized: CachedProviderCalendar[] = [];
	for (const entry of rawList) {
		if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.length === 0) {
			continue;
		}
		const summary =
			typeof entry.summary === "string"
				? entry.summary
				: typeof entry.name === "string"
					? entry.name
					: entry.id;
		const item: CachedProviderCalendar = {
			id: entry.id,
			summary,
		};
		const description = readOptionalString(entry, "description");
		if (description !== undefined) {
			item.description = description;
		}
		const backgroundColor = readOptionalString(entry, "backgroundColor");
		if (backgroundColor !== undefined) {
			item.backgroundColor = backgroundColor;
		}
		const primary = readOptionalBoolean(entry, "primary");
		if (primary !== undefined) {
			item.primary = primary;
		}
		const canWrite = readOptionalBoolean(entry, "canWrite");
		if (canWrite !== undefined) {
			item.canWrite = canWrite;
		}
		sanitized.push(item);
	}
	return sanitized;
}

/**
 * Sanitizes ICS subscription metadata using a strict field whitelist.
 * Never retains `url`, `filePath`, `authType`, `username`, `filter`, or credentials.
 */
export function sanitizeIcsSubscriptions(rawList: unknown): CachedIcsSubscription[] {
	if (!Array.isArray(rawList)) {
		return [];
	}

	const sanitized: CachedIcsSubscription[] = [];
	for (const entry of rawList) {
		if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.length === 0) {
			continue;
		}
		const name = typeof entry.name === "string" ? entry.name : entry.id;
		const type = entry.type === "local" ? "local" : "remote";
		const color = typeof entry.color === "string" ? entry.color : "";
		const enabled = entry.enabled === true;
		const refreshInterval =
			typeof entry.refreshInterval === "number" && Number.isFinite(entry.refreshInterval)
				? entry.refreshInterval
				: 60;

		sanitized.push({
			id: entry.id,
			name,
			type,
			color,
			enabled,
			refreshInterval,
		});
	}
	return sanitized;
}

export function sanitizeCalendarEvents(rawList: unknown): CachedCalendarEvent[] {
	if (!Array.isArray(rawList)) {
		return [];
	}

	const sanitized: CachedCalendarEvent[] = [];
	for (const entry of rawList) {
		if (
			!isRecord(entry) ||
			typeof entry.id !== "string" ||
			entry.id.length === 0 ||
			typeof entry.subscriptionId !== "string" ||
			entry.subscriptionId.length === 0 ||
			typeof entry.title !== "string" ||
			typeof entry.start !== "string" ||
			entry.start.length === 0
		) {
			continue;
		}

		const item: CachedCalendarEvent = {
			id: entry.id,
			subscriptionId: entry.subscriptionId,
			title: entry.title,
			start: entry.start,
			allDay: entry.allDay === true,
		};

		const description = readOptionalString(entry, "description");
		if (description !== undefined) {
			item.description = description;
		}
		const end = readOptionalString(entry, "end");
		if (end !== undefined) {
			item.end = end;
		}
		const location = readOptionalString(entry, "location");
		if (location !== undefined) {
			item.location = location;
		}
		const url = readOptionalString(entry, "url");
		if (url !== undefined) {
			item.url = url;
		}
		const rrule = readOptionalString(entry, "rrule");
		if (rrule !== undefined) {
			item.rrule = rrule;
		}
		const recurringEventId = readOptionalString(entry, "recurringEventId");
		if (recurringEventId !== undefined) {
			item.recurringEventId = recurringEventId;
		}
		const color = readOptionalString(entry, "color");
		if (color !== undefined) {
			item.color = color;
		}

		sanitized.push(item);
	}
	return sanitized;
}

function prioritizeEventIndicesByProximity(
	events: readonly CachedCalendarEvent[],
	nowMs: number,
): number[] {
	const ranked = events.map((event, index) => {
		const startMs = Date.parse(event.start);
		const distance = Number.isFinite(startMs)
			? Math.abs(startMs - nowMs)
			: Number.MAX_SAFE_INTEGER;
		return { index, distance };
	});

	ranked.sort((a, b) => a.distance - b.distance || a.index - b.index);
	return ranked.map((entry) => entry.index);
}

/**
 * Caps cached events to `maxCount`, keeping events closest in time to `nowMs`
 * while preserving the retained items' original ordering.
 */
export function trimEventsForLimit(
	events: readonly CachedCalendarEvent[],
	maxCount = MAX_CACHED_EVENTS_PER_PROVIDER,
	nowMs = Date.now(),
): CachedCalendarEvent[] {
	if (maxCount <= 0) {
		return [];
	}
	if (events.length <= maxCount) {
		return events.slice();
	}

	const selectedIndices = prioritizeEventIndicesByProximity(events, nowMs)
		.slice(0, maxCount)
		.sort((a, b) => a - b);

	return selectedIndices.map((index) => events[index]).filter(isDefined);
}

function isDefined<T>(value: T | undefined): value is T {
	return value !== undefined;
}

export function measureJsonBytes(value: unknown): number {
	const serialized = JSON.stringify(value);
	if (typeof TextEncoder !== "undefined") {
		return new TextEncoder().encode(serialized).byteLength;
	}
	return serialized.length * 2;
}

/**
 * Fits a cache payload within the per-provider JSON UTF-8 byte budget by trimming
 * farthest-from-now events first, and dropping calendar descriptions only as a last resort.
 */
export function fitPayloadToByteLimit(
	payload: ExternalCalendarCachePayload,
	maxBytes = MAX_PAYLOAD_BYTES,
	nowMs = Date.now(),
): ExternalCalendarCachePayload | null {
	const baseEvents = trimEventsForLimit(
		payload.events,
		MAX_CACHED_EVENTS_PER_PROVIDER,
		nowMs,
	);
	let candidate: ExternalCalendarCachePayload = {
		...payload,
		events: baseEvents,
	};

	if (measureJsonBytes(candidate) <= maxBytes) {
		return candidate;
	}

	const rankedIndices = prioritizeEventIndicesByProximity(baseEvents, nowMs);
	let keepCount = baseEvents.length;

	while (keepCount > 0 && measureJsonBytes(candidate) > maxBytes) {
		keepCount = keepCount === 1 ? 0 : Math.floor(keepCount * 0.6);
		const keptIndices = rankedIndices.slice(0, keepCount).sort((a, b) => a - b);
		candidate = {
			...candidate,
			events: keptIndices.map((index) => baseEvents[index]).filter(isDefined),
		};
	}

	if (measureJsonBytes(candidate) <= maxBytes) {
		return candidate;
	}

	candidate = {
		...candidate,
		calendars: candidate.calendars.map(({ description: _desc, ...rest }) => rest),
	};
	return measureJsonBytes(candidate) <= maxBytes ? candidate : null;
}

export function parseCachePayload(
	raw: unknown,
	expectedProvider: CacheableProviderKey,
	nowMs = Date.now(),
): ExternalCalendarCachePayload | null {
	let parsed: unknown = raw;
	if (typeof raw === "string") {
		try {
			parsed = JSON.parse(raw) as unknown;
		} catch {
			return null;
		}
	}

	if (!isRecord(parsed)) {
		return null;
	}
	if (parsed.version !== CACHE_VERSION || parsed.provider !== expectedProvider) {
		return null;
	}
	if (typeof parsed.savedAt !== "number" || !Number.isFinite(parsed.savedAt)) {
		return null;
	}

	// Reject corrupted future timestamps and stale expired entries.
	if (parsed.savedAt - nowMs > MAX_FUTURE_CLOCK_SKEW_MS) {
		return null;
	}
	if (nowMs - parsed.savedAt > CACHE_TTL_MS) {
		return null;
	}

	if (
		!Array.isArray(parsed.calendars) ||
		!Array.isArray(parsed.subscriptions) ||
		!Array.isArray(parsed.events)
	) {
		return null;
	}

	const payload: ExternalCalendarCachePayload = {
		version: CACHE_VERSION,
		provider: expectedProvider,
		savedAt: parsed.savedAt,
		calendars: sanitizeProviderCalendars(parsed.calendars),
		subscriptions: sanitizeIcsSubscriptions(parsed.subscriptions),
		events: sanitizeCalendarEvents(parsed.events),
	};

	if (
		typeof parsed.connectionGeneration === "number" &&
		Number.isFinite(parsed.connectionGeneration)
	) {
		payload.connectionGeneration = parsed.connectionGeneration;
	}

	return payload;
}

function readLocalStorageRaw(app: App, key: string): unknown {
	try {
		return safeCall(app, "loadLocalStorage", key);
	} catch {
		return null;
	}
}

function writeLocalStorageRaw(app: App, key: string, value: unknown): boolean {
	try {
		const appRecord = app as unknown as Record<string, unknown>;
		const saveFn = asCallable(appRecord.saveLocalStorage);
		if (!saveFn) {
			return false;
		}
		saveFn.call(app, key, value);
		return true;
	} catch (error) {
		console.warn("Failed to access device-local calendar cache storage:", error);
		return false;
	}
}

export function clearProviderCacheStorage(
	app: App,
	providerKey: CacheableProviderKey,
): void {
	writeLocalStorageRaw(app, CACHE_STORAGE_KEYS[providerKey], null);
}

/**
 * Deletes all device-local external calendar cache entries created by this plugin.
 * Safe to invoke even when `enableExternalCalendarCache` is disabled.
 */
export function clearAllExternalCalendarCacheStorage(app: App): void {
	for (const storageKey of Object.values(CACHE_STORAGE_KEYS)) {
		writeLocalStorageRaw(app, storageKey, null);
	}
}

export function loadProviderCache(
	app: App,
	providerKey: CacheableProviderKey,
	nowMs = Date.now(),
): ExternalCalendarCachePayload | null {
	const storageKey = CACHE_STORAGE_KEYS[providerKey];
	const raw = readLocalStorageRaw(app, storageKey);
	if (raw === null || raw === undefined) {
		return null;
	}

	const payload = parseCachePayload(raw, providerKey, nowMs);
	if (!payload) {
		clearProviderCacheStorage(app, providerKey);
		return null;
	}

	return payload;
}

export function saveProviderCache(
	app: App,
	providerKey: CacheableProviderKey,
	input: {
		calendars: unknown;
		subscriptions: unknown;
		events: unknown;
		connectionGeneration?: number | null;
	},
	nowMs = Date.now(),
): boolean {
	const payload: ExternalCalendarCachePayload = {
		version: CACHE_VERSION,
		provider: providerKey,
		savedAt: nowMs,
		calendars: sanitizeProviderCalendars(input.calendars),
		subscriptions: sanitizeIcsSubscriptions(input.subscriptions),
		events: sanitizeCalendarEvents(input.events),
	};

	if (
		typeof input.connectionGeneration === "number" &&
		Number.isFinite(input.connectionGeneration)
	) {
		payload.connectionGeneration = input.connectionGeneration;
	}

	const fitted = fitPayloadToByteLimit(payload, MAX_PAYLOAD_BYTES, nowMs);
	if (!fitted) {
		clearProviderCacheStorage(app, providerKey);
		return false;
	}

	const ok = writeLocalStorageRaw(app, CACHE_STORAGE_KEYS[providerKey], fitted);
	if (!ok) {
		clearProviderCacheStorage(app, providerKey);
	}
	return ok;
}

function cloneItems<T extends object>(items: readonly T[]): T[] {
	return items.map((item) => ({ ...item }));
}

function filterCachedEventsForProvider(
	app: App,
	state: ProviderRuntimeState,
	events: readonly CachedCalendarEvent[],
): CachedCalendarEvent[] {
	if (state.key === "ics") {
		const disabledSubIds = collectDisabledIcsSubscriptionIds(app, state.service);
		if (disabledSubIds.size === 0) {
			return cloneItems(events);
		}
		return events
			.filter((event) => !disabledSubIds.has(event.subscriptionId))
			.map((event) => ({ ...event }));
	}

	const enabledIds = getEnabledProviderCalendarIds(app, state.key);
	if (enabledIds === null) {
		return cloneItems(events);
	}

	const prefix = state.key === "microsoft" ? "microsoft-" : "google-";
	const allowedSubscriptionIds = new Set(enabledIds.map((id) => `${prefix}${id}`));
	if (enabledIds.includes("primary")) {
		for (const cal of state.cachedCalendars) {
			if (cal.primary === true) {
				allowedSubscriptionIds.add(`${prefix}${cal.id}`);
			}
		}
	}

	return events
		.filter((event) => allowedSubscriptionIds.has(event.subscriptionId))
		.map((event) => ({ ...event }));
}

function collectDisabledIcsSubscriptionIds(
	app: App,
	service: Record<string, unknown>,
): Set<string> {
	const disabledIds = new Set<string>();
	const tasknotes = getTaskNotesPlugin(app);
	const settings = tasknotes?.settings;
	const settingsList =
		isRecord(settings) && Array.isArray(settings.icsSubscriptions)
			? settings.icsSubscriptions
			: null;
	const rawList =
		settingsList ??
		(asCallable(service.getSubscriptions) ? safeCall(service, "getSubscriptions") : null);

	if (!Array.isArray(rawList)) {
		return disabledIds;
	}
	for (const entry of rawList) {
		if (isRecord(entry) && typeof entry.id === "string" && entry.enabled === false) {
			disabledIds.add(entry.id);
		}
	}
	return disabledIds;
}

function isHostedAuthRevoked(conn: HostedGoogleConnectionState): boolean {
	return (
		conn.failureCode === "session_expired" ||
		conn.failureCode === "reconnect_required" ||
		conn.connectionStatus === "disconnected" ||
		conn.connectionStatus === "reconnect_required"
	);
}

function hasHostedTransientFailure(conn: HostedGoogleConnectionState): boolean {
	return conn.hasFailure && !isHostedAuthRevoked(conn);
}

function hasThenMethod(value: unknown): value is PromiseLike<unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		asCallable((value as { then?: unknown }).then) !== null
	);
}

/**
 * Stale-While-Revalidate cache controller wrapping TaskNotes' external calendar
 * services (`getAllEvents`, `getAvailableCalendars`, `getSubscriptions`) cleanly at runtime.
 */
export class ExternalCalendarCacheController {
	private enabled = false;
	private enableToken = 0;
	private readonly providers = new Map<CacheableProviderKey, ProviderRuntimeState>();

	constructor(private readonly app: App) {}

	enable(): void {
		if (this.enabled) {
			return;
		}
		this.enabled = true;
		const token = ++this.enableToken;

		if (this.attachMissingProviders()) {
			refreshOpenCalendarViews(this.app);
		}

		const workspace = this.app.workspace as unknown as Record<string, unknown>;
		const onLayoutReadyFn = asCallable(workspace.onLayoutReady);
		if (onLayoutReadyFn) {
			try {
				onLayoutReadyFn.call(this.app.workspace, () => {
					if (!this.enabled || this.enableToken !== token) {
						return;
					}
					if (this.attachMissingProviders()) {
						refreshOpenCalendarViews(this.app);
					}
				});
			} catch {
				// Ignore mock workspaces without functional onLayoutReady.
			}
		}
	}

	disable(): void {
		if (!this.enabled) {
			return;
		}
		this.enabled = false;
		this.enableToken += 1;

		for (const state of this.providers.values()) {
			state.disposed = true;
			for (const dispose of state.disposers) {
				try {
					dispose();
				} catch {
					// Ignore individual cleanup errors during teardown.
				}
			}
			state.disposers.length = 0;
			state.icsPendingSubIds.clear();
			state.cachedCalendars = [];
			state.cachedSubscriptions = [];
			state.cachedEvents = [];
		}
		this.providers.clear();
	}

	/**
	 * Wipes both in-memory stale caches and device-local persistent storage immediately.
	 */
	clearAll(): void {
		let hadStalePreSyncData = false;
		for (const state of this.providers.values()) {
			state.syncSeq += 1;
			state.icsPendingSubIds.clear();
			if (
				!state.liveSynced &&
				(state.cachedEvents.length > 0 ||
					state.cachedCalendars.length > 0 ||
					state.cachedSubscriptions.length > 0)
			) {
				hadStalePreSyncData = true;
			}
			state.cachedCalendars = [];
			state.cachedSubscriptions = [];
			state.cachedEvents = [];
		}

		clearAllExternalCalendarCacheStorage(this.app);

		if (this.enabled && hadStalePreSyncData) {
			refreshOpenCalendarViews(this.app);
		}
	}

	private attachMissingProviders(): boolean {
		const targets = getCacheableCalendarProviders(this.app);
		let shouldRefreshViews = false;

		for (const target of targets) {
			if (this.providers.has(target.key)) {
				continue;
			}
			const attached = this.attachProvider(target);
			if (
				!attached.liveSynced &&
				(attached.cachedEvents.length > 0 ||
					attached.cachedCalendars.length > 0 ||
					attached.cachedSubscriptions.length > 0)
			) {
				shouldRefreshViews = true;
			}
		}

		return shouldRefreshViews;
	}

	private attachProvider(target: CacheableProviderTarget): ProviderRuntimeState {
		const loaded = loadProviderCache(this.app, target.key);
		const pendingSubIds = new Set<string>();
		if (target.key === "ics" && loaded) {
			for (const ev of loaded.events) {
				pendingSubIds.add(ev.subscriptionId);
			}
			for (const sub of loaded.subscriptions) {
				if (sub.enabled) {
					pendingSubIds.add(sub.id);
				}
			}
		}

		const initialOAuthGeneration =
			target.key === "own-google"
				? getOAuthConnectionGeneration(this.app, "google")
				: target.key === "microsoft"
					? getOAuthConnectionGeneration(this.app, "microsoft")
					: null;

		const state: ProviderRuntimeState = {
			key: target.key,
			service: target.service,
			kind: target.kind,
			liveSynced: false,
			syncSeq: 0,
			disposed: false,
			sawHostedSignedIn: false,
			initialOAuthGeneration,
			ownOAuthConnected: null,
			icsPendingSubIds: pendingSubIds,
			icsInitializeFinished: false,
			cachedCalendars: loaded ? cloneItems(loaded.calendars) : [],
			cachedSubscriptions: loaded ? cloneItems(loaded.subscriptions) : [],
			cachedEvents: loaded ? cloneItems(loaded.events) : [],
			getLiveCalendars: null,
			getLiveSubscriptions: null,
			getLiveEvents: null,
			disposers: [],
		};

		this.providers.set(target.key, state);
		this.validateInitialConnectionState(state, loaded);
		this.installProviderMethodWrappers(state);
		this.installDisconnectHooks(state);
		this.installProviderSubscriptions(state);
		return state;
	}

	private validateInitialConnectionState(
		state: ProviderRuntimeState,
		loaded: ExternalCalendarCachePayload | null,
	): void {
		if (state.key === "ics") {
			if (loaded && hasAnyEnabledIcsSubscription(this.app, state.service) === false) {
				this.purgeProviderCache(state, false);
			}
			return;
		}

		if (state.key === "hosted-google") {
			const conn = getHostedGoogleConnectionState(state.service);
			if (conn.signedIn) {
				state.sawHostedSignedIn = true;
			}
			if (
				loaded &&
				(isHostedAuthRevoked(conn) ||
					(conn.settled && !conn.signedIn && !hasHostedTransientFailure(conn)))
			) {
				this.purgeProviderCache(state, false);
			}
			return;
		}

		const oauthProvider = state.key === "own-google" ? "google" : "microsoft";
		const seqAtStart = state.syncSeq;
		void isOAuthProviderConnected(this.app, oauthProvider).then((connected) => {
			if (!this.isProviderActive(state, seqAtStart)) {
				return;
			}
			state.ownOAuthConnected = connected;
			if (connected === false && loaded) {
				const hadStale = state.cachedEvents.length > 0 || state.cachedCalendars.length > 0;
				this.purgeProviderCache(state, hadStale && !state.liveSynced);
			}
		});
	}

	private checkMidSessionOAuthGeneration(state: ProviderRuntimeState): boolean {
		if (state.key !== "own-google" && state.key !== "microsoft") {
			return false;
		}
		if (state.initialOAuthGeneration === null) {
			return false;
		}
		const oauthProvider = state.key === "own-google" ? "google" : "microsoft";
		const currentGen = getOAuthConnectionGeneration(this.app, oauthProvider);
		if (currentGen !== null && currentGen !== state.initialOAuthGeneration) {
			state.initialOAuthGeneration = currentGen;
			this.purgeProviderCache(state, false);
			return true;
		}
		return false;
	}

	private getHostedFallbackForOwnGoogle(
		ownState: ProviderRuntimeState,
	): ProviderRuntimeState | null {
		if (ownState.key !== "own-google" || ownState.ownOAuthConnected === true) {
			return null;
		}
		if (getActiveGoogleCalendarService(this.app) !== ownState.service) {
			return null;
		}
		const hosted = this.providers.get("hosted-google");
		if (!hosted || hosted.disposed || hosted.liveSynced) {
			return null;
		}
		return hosted;
	}

	private resolveIcsEventsWithPendingCache(
		state: ProviderRuntimeState,
		live: unknown,
	): unknown {
		if (state.liveSynced || state.cachedEvents.length === 0) {
			return live;
		}

		if (asCallable(state.service.getLastFetched) === null) {
			if (Array.isArray(live) && live.length > 0) {
				return live;
			}
			return filterCachedEventsForProvider(this.app, state, state.cachedEvents);
		}

		const liveEvents: unknown[] = Array.isArray(live) ? live : [];
		const fetchedOrPresentSubIds = new Set<string>();
		for (const entry of liveEvents) {
			if (isRecord(entry) && typeof entry.subscriptionId === "string") {
				fetchedOrPresentSubIds.add(entry.subscriptionId);
			}
		}
		for (const subId of state.icsPendingSubIds) {
			if (getIcsSubscriptionSyncState(state.service, subId).fetched) {
				fetchedOrPresentSubIds.add(subId);
			}
		}

		const liveSubsRaw = state.getLiveSubscriptions
			? state.getLiveSubscriptions()
			: safeCall(state.service, "getSubscriptions");
		let enabledLiveSubIds: Set<string> | null = null;
		if (Array.isArray(liveSubsRaw) && liveSubsRaw.length > 0) {
			enabledLiveSubIds = new Set<string>();
			for (const entry of liveSubsRaw) {
				if (isRecord(entry) && typeof entry.id === "string" && entry.enabled === true) {
					enabledLiveSubIds.add(entry.id);
				}
			}
		}

		const disabledIds = collectDisabledIcsSubscriptionIds(this.app, state.service);
		const remainingCached = state.cachedEvents.filter(
			(ev) =>
				state.icsPendingSubIds.has(ev.subscriptionId) &&
				!fetchedOrPresentSubIds.has(ev.subscriptionId) &&
				!disabledIds.has(ev.subscriptionId) &&
				(enabledLiveSubIds === null || enabledLiveSubIds.has(ev.subscriptionId)),
		);

		if (remainingCached.length === 0) {
			return live;
		}
		return [...liveEvents, ...cloneItems(remainingCached)];
	}

	private installProviderMethodWrappers(state: ProviderRuntimeState): void {
		const { service } = state;
		const app = this.app;

		if (asCallable(service.getAllEvents)) {
			const unpatchEvents = patchMethod(service, "getAllEvents", (original) => {
				state.getLiveEvents = () => original.call(service);
				return (...args: unknown[]): unknown => {
					if (this.checkMidSessionOAuthGeneration(state)) {
						return original.apply(service, args);
					}
					const live = original.apply(service, args);
					if (state.liveSynced) {
						return live;
					}
					if (state.key === "ics") {
						return this.resolveIcsEventsWithPendingCache(state, live);
					}
					if (Array.isArray(live) && live.length > 0) {
						return live;
					}
					if (state.cachedEvents.length > 0) {
						return filterCachedEventsForProvider(app, state, state.cachedEvents);
					}
					const hostedFallback = this.getHostedFallbackForOwnGoogle(state);
					if (hostedFallback && hostedFallback.cachedEvents.length > 0) {
						return filterCachedEventsForProvider(
							app,
							hostedFallback,
							hostedFallback.cachedEvents,
						);
					}
					return live;
				};
			});
			if (unpatchEvents) {
				state.disposers.push(unpatchEvents);
			}
		}

		if (asCallable(service.getAvailableCalendars)) {
			const unpatchCalendars = patchMethod(
				service,
				"getAvailableCalendars",
				(original) => {
					state.getLiveCalendars = () => original.call(service);
					return (...args: unknown[]): unknown => {
						if (this.checkMidSessionOAuthGeneration(state)) {
							return original.apply(service, args);
						}
						const live = original.apply(service, args);
						if (state.liveSynced) {
							return live;
						}
						if (Array.isArray(live) && live.length > 0) {
							return live;
						}
						if (state.cachedCalendars.length > 0) {
							return cloneItems(state.cachedCalendars);
						}
						const hostedFallback = this.getHostedFallbackForOwnGoogle(state);
						if (hostedFallback && hostedFallback.cachedCalendars.length > 0) {
							return cloneItems(hostedFallback.cachedCalendars);
						}
						return live;
					};
				},
			);
			if (unpatchCalendars) {
				state.disposers.push(unpatchCalendars);
			}
		}

		if (state.kind === "ics" && asCallable(service.getSubscriptions)) {
			const unpatchSubscriptions = patchMethod(
				service,
				"getSubscriptions",
				(original) => {
					state.getLiveSubscriptions = () => original.call(service);
					return function (this: unknown, ...args: unknown[]): unknown {
						const live = original.apply(this, args);
						if (state.liveSynced) {
							return live;
						}
						if (Array.isArray(live) && live.length > 0) {
							return live;
						}
						if (state.cachedSubscriptions.length > 0) {
							return cloneItems(state.cachedSubscriptions);
						}
						return live;
					};
				},
			);
			if (unpatchSubscriptions) {
				state.disposers.push(unpatchSubscriptions);
			}
		}
	}

	private hookMethodCompletion(
		target: Record<string, unknown>,
		methodName: string,
		state: ProviderRuntimeState,
		onComplete: () => void,
	): void {
		if (!asCallable(target[methodName])) {
			return;
		}
		const unpatch = patchMethod(target, methodName, (original) => (...args: unknown[]): unknown => {
			const result = original.apply(target, args);
			if (hasThenMethod(result)) {
				return Promise.resolve(result).finally(() => {
					if (this.enabled && !state.disposed) {
						onComplete();
					}
				});
			}
			if (this.enabled && !state.disposed) {
				onComplete();
			}
			return result;
		});
		if (unpatch) {
			state.disposers.push(unpatch);
		}
	}

	private installDisconnectHooks(state: ProviderRuntimeState): void {
		const purgeMethods =
			state.key === "hosted-google"
				? ["signOut", "handleDisconnect", "deleteAccount", "clearCache"]
				: state.key === "ics"
					? ["clearCache"]
					: ["handleDisconnect", "disconnect", "clearCache"];

		for (const methodName of purgeMethods) {
			if (!asCallable(state.service[methodName])) {
				continue;
			}
			const unpatch = patchMethod(
				state.service,
				methodName,
				(original) =>
					(...args: unknown[]): unknown => {
						if (state.key === "hosted-google") {
							this.purgeHostedCacheAndRefresh(state);
						} else {
							const shouldRefresh =
								!state.liveSynced &&
								(state.cachedEvents.length > 0 || state.cachedCalendars.length > 0);
							this.purgeProviderCache(state, shouldRefresh);
						}
						const result = original.apply(state.service, args);
						if (hasThenMethod(result)) {
							return Promise.resolve(result).finally(() => {
								if (!state.disposed) {
									clearProviderCacheStorage(this.app, state.key);
								}
							});
						}
						return result;
					},
			);
			if (unpatch) {
				state.disposers.push(unpatch);
			}
		}

		if (state.key === "hosted-google") {
			for (const restoreMethod of ["initialize", "resume"]) {
				this.hookMethodCompletion(state.service, restoreMethod, state, () => {
					this.evaluateHostedClientTransition(state, true);
				});
			}
			if (isRecord(state.service.client)) {
				this.hookMethodCompletion(state.service.client, "restore", state, () => {
					this.evaluateHostedClientTransition(state, true);
				});
			}
		}

		if (state.key === "ics") {
			this.hookMethodCompletion(state.service, "initialize", state, () => {
				state.icsInitializeFinished = true;
				const liveSubs = state.getLiveSubscriptions
					? state.getLiveSubscriptions()
					: safeCall(state.service, "getSubscriptions");
				if (Array.isArray(liveSubs) && liveSubs.length === 0) {
					this.purgeProviderCache(state, !state.liveSynced);
				}
			});
			for (const mutationMethod of ["removeSubscription", "updateSubscription"]) {
				this.hookMethodCompletion(state.service, mutationMethod, state, () => {
					this.reconcileIcsSubscriptionsWithLiveState(state);
				});
			}
		}
	}

	private reconcileIcsSubscriptionsWithLiveState(state: ProviderRuntimeState): void {
		const liveSubs = state.getLiveSubscriptions
			? state.getLiveSubscriptions()
			: safeCall(state.service, "getSubscriptions");
		if (!Array.isArray(liveSubs)) {
			return;
		}
		if (liveSubs.length === 0) {
			if (state.icsInitializeFinished) {
				this.purgeProviderCache(state, false);
			}
			return;
		}

		const enabledIds = new Set<string>();
		for (const entry of liveSubs) {
			if (isRecord(entry) && typeof entry.id === "string" && entry.enabled === true) {
				enabledIds.add(entry.id);
			}
		}
		for (const subId of Array.from(state.icsPendingSubIds)) {
			if (!enabledIds.has(subId)) {
				state.icsPendingSubIds.delete(subId);
			}
		}
		state.cachedEvents = state.cachedEvents.filter((ev) => enabledIds.has(ev.subscriptionId));
		state.cachedSubscriptions = state.cachedSubscriptions.filter((sub) => enabledIds.has(sub.id));

		if (enabledIds.size === 0) {
			this.purgeProviderCache(state, !state.liveSynced);
		}
	}

	private installProviderSubscriptions(state: ProviderRuntimeState): void {
		const dataDisposer = subscribeSingleProviderEvent(
			state.service,
			"data-changed",
			() => {
				void this.handleProviderDataChanged(state);
			},
		);
		if (dataDisposer) {
			state.disposers.push(dataDisposer);
		}

		if (state.key === "hosted-google") {
			const sessionDisposer = subscribeSingleProviderEvent(
				state.service,
				"session-changed",
				() => {
					if (!this.enabled || state.disposed) {
						return;
					}
					const conn = getHostedGoogleConnectionState(state.service);
					if (conn.signedIn) {
						state.sawHostedSignedIn = true;
						return;
					}
					if (!hasHostedTransientFailure(conn)) {
						this.purgeHostedCacheAndRefresh(state);
					}
				},
			);
			if (sessionDisposer) {
				state.disposers.push(sessionDisposer);
			}

			const clientDisposer = subscribeHostedGoogleClient(state.service, () => {
				if (!this.enabled || state.disposed) {
					return;
				}
				this.evaluateHostedClientTransition(state, false);
			});
			if (clientDisposer) {
				state.disposers.push(clientDisposer);
			}
		}
	}

	private evaluateHostedClientTransition(
		state: ProviderRuntimeState,
		afterRestoreCompleted: boolean,
	): void {
		const conn = getHostedGoogleConnectionState(state.service);
		if (conn.signedIn) {
			state.sawHostedSignedIn = true;
		}
		if (isHostedAuthRevoked(conn)) {
			this.purgeHostedCacheAndRefresh(state);
			return;
		}
		if (hasHostedTransientFailure(conn)) {
			return;
		}

		const lostSession = state.sawHostedSignedIn && !conn.signedIn;
		const settledSignedOut = (afterRestoreCompleted || conn.settled) && !conn.signedIn;

		if (lostSession || settledSignedOut) {
			this.purgeHostedCacheAndRefresh(state);
		}
	}

	private purgeHostedCacheAndRefresh(state: ProviderRuntimeState): void {
		const activeGoogle = getActiveGoogleCalendarService(this.app);
		const ownGoogle = this.providers.get("own-google");
		const actingAsFallback =
			activeGoogle !== null && ownGoogle !== undefined && activeGoogle === ownGoogle.service;
		const hadStale =
			!state.liveSynced &&
			(state.cachedEvents.length > 0 ||
				state.cachedCalendars.length > 0 ||
				actingAsFallback);
		this.purgeProviderCache(state, hadStale);
	}

	private handleIcsDataChanged(state: ProviderRuntimeState): void {
		const liveSubs = state.getLiveSubscriptions
			? state.getLiveSubscriptions()
			: safeCall(state.service, "getSubscriptions");
		const liveEvents = state.getLiveEvents
			? state.getLiveEvents()
			: safeCall(state.service, "getAllEvents");

		const liveSubsArray: unknown[] = Array.isArray(liveSubs) ? liveSubs : [];
		const liveEventsArray: unknown[] = Array.isArray(liveEvents) ? liveEvents : [];
		const hasSyncTracker = asCallable(state.service.getLastFetched) !== null;

		if (hasSyncTracker && state.icsPendingSubIds.size > 0) {
			let liveSubEnabledMap: Map<string, boolean> | null = null;
			if (liveSubsArray.length > 0) {
				liveSubEnabledMap = new Map<string, boolean>();
				for (const entry of liveSubsArray) {
					if (isRecord(entry) && typeof entry.id === "string") {
						liveSubEnabledMap.set(entry.id, entry.enabled === true);
					}
				}
			}

			for (const subId of Array.from(state.icsPendingSubIds)) {
				const syncState = getIcsSubscriptionSyncState(state.service, subId);
				const removedOrDisabled =
					(liveSubEnabledMap !== null && liveSubEnabledMap.get(subId) !== true) ||
					(state.icsInitializeFinished && liveSubsArray.length === 0);
				if (syncState.fetched || removedOrDisabled) {
					state.icsPendingSubIds.delete(subId);
				}
			}

			state.cachedEvents = state.cachedEvents.filter((ev) =>
				state.icsPendingSubIds.has(ev.subscriptionId),
			);
			state.cachedSubscriptions =
				liveSubsArray.length > 0
					? []
					: state.cachedSubscriptions.filter((sub) => state.icsPendingSubIds.has(sub.id));

			if (state.icsPendingSubIds.size === 0) {
				state.liveSynced = true;
				state.cachedSubscriptions = [];
				state.cachedEvents = [];
			}

			const liveEventSubIds = new Set<string>();
			for (const entry of liveEventsArray) {
				if (isRecord(entry) && typeof entry.subscriptionId === "string") {
					liveEventSubIds.add(entry.subscriptionId);
				}
			}
			const remainingCachedEvents = state.cachedEvents.filter(
				(ev) => !liveEventSubIds.has(ev.subscriptionId),
			);
			const combinedEvents = [
				...sanitizeCalendarEvents(liveEventsArray),
				...remainingCachedEvents,
			];
			const combinedSubs = liveSubsArray.length > 0 ? liveSubsArray : state.cachedSubscriptions;

			if (
				hasAnyEnabledIcsSubscription(this.app, state.service) === false &&
				combinedEvents.length === 0
			) {
				this.purgeProviderCache(state, false);
				return;
			}

			saveProviderCache(this.app, state.key, {
				calendars: [],
				subscriptions: combinedSubs,
				events: combinedEvents,
			});
			return;
		}

		state.liveSynced = true;
		state.icsPendingSubIds.clear();
		state.cachedCalendars = [];
		state.cachedSubscriptions = [];
		state.cachedEvents = [];
		state.syncSeq += 1;

		if (
			hasAnyEnabledIcsSubscription(this.app, state.service) === false &&
			liveEventsArray.length === 0
		) {
			this.purgeProviderCache(state, false);
			return;
		}
		saveProviderCache(this.app, state.key, {
			calendars: [],
			subscriptions: liveSubsArray,
			events: liveEventsArray,
		});
	}

	private async handleProviderDataChanged(state: ProviderRuntimeState): Promise<void> {
		if (!this.enabled || state.disposed) {
			return;
		}

		if (state.key === "ics") {
			this.handleIcsDataChanged(state);
			return;
		}

		// Flip passthrough first so subsequent CalendarView reads see live state immediately.
		state.liveSynced = true;
		state.cachedCalendars = [];
		state.cachedSubscriptions = [];
		state.cachedEvents = [];

		const seq = ++state.syncSeq;

		const liveCalendars = state.getLiveCalendars
			? state.getLiveCalendars()
			: safeCall(state.service, "getAvailableCalendars");
		const liveEvents = state.getLiveEvents
			? state.getLiveEvents()
			: safeCall(state.service, "getAllEvents");

		if (state.key === "hosted-google") {
			const conn = getHostedGoogleConnectionState(state.service);
			if (conn.signedIn) {
				state.sawHostedSignedIn = true;
			}
			if (isHostedAuthRevoked(conn) || (!conn.signedIn && !hasHostedTransientFailure(conn))) {
				this.purgeProviderCache(state, false);
				return;
			}
			saveProviderCache(this.app, state.key, {
				calendars: liveCalendars,
				subscriptions: [],
				events: liveEvents,
			});
			return;
		}

		this.checkMidSessionOAuthGeneration(state);
		const seqAfterGenCheck = state.syncSeq;
		const oauthProvider = state.key === "own-google" ? "google" : "microsoft";
		const connected = await isOAuthProviderConnected(this.app, oauthProvider);

		if (!this.isProviderActive(state, Math.max(seq, seqAfterGenCheck))) {
			return;
		}

		state.ownOAuthConnected = connected;
		if (connected === false) {
			this.purgeProviderCache(state, false);
			return;
		}

		saveProviderCache(this.app, state.key, {
			calendars: liveCalendars,
			subscriptions: [],
			events: liveEvents,
		});
	}

	private isProviderActive(state: ProviderRuntimeState, expectedSeq: number): boolean {
		return this.enabled && !state.disposed && state.syncSeq === expectedSeq;
	}

	private purgeProviderCache(state: ProviderRuntimeState, refreshViews: boolean): void {
		state.syncSeq += 1;
		state.icsPendingSubIds.clear();
		state.cachedCalendars = [];
		state.cachedSubscriptions = [];
		state.cachedEvents = [];
		clearProviderCacheStorage(this.app, state.key);
		if (refreshViews && this.enabled) {
			refreshOpenCalendarViews(this.app);
		}
	}
}
