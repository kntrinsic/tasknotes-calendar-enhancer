import type { App } from "obsidian";
import { patchMethod } from "./externalCalendarCache";
import {
	asCallable,
	type CacheableProviderKey,
	type CacheableProviderTarget,
	type ExternalCalendarProviderId,
	getCacheableCalendarProviders,
	isRecord,
	refreshOpenCalendarViews,
	safeCall,
} from "./tasknotesBridge";

export const MAX_CALENDAR_COLOR_OVERRIDES = 200;
export const CALENDAR_COLOR_KEY_PATTERN = /^(google|microsoft|ics):[0-9a-f]{16}$/;

export const CALENDAR_COLOR_PRESETS: ReadonlyArray<{
	readonly name: string;
	readonly hex: string;
}> = [
	{ name: "Red", hex: "#e05252" },
	{ name: "Coral", hex: "#e8833a" },
	{ name: "Amber", hex: "#d9a426" },
	{ name: "Green", hex: "#4caf6a" },
	{ name: "Teal", hex: "#2ba6a4" },
	{ name: "Sky", hex: "#3898ec" },
	{ name: "Blue", hex: "#4285f4" },
	{ name: "Indigo", hex: "#6366f1" },
	{ name: "Purple", hex: "#9b6be8" },
	{ name: "Pink", hex: "#df5c9c" },
	{ name: "Brown", hex: "#9c6b4e" },
	{ name: "Slate", hex: "#788496" },
];

const SHORT_OR_FULL_HEX_PATTERN = /^#([0-9a-f]{3}|[0-9a-f]{6})$/;

/**
 * Normalizes a `#rgb` or `#rrggbb` hex string into lowercase `#rrggbb`, returning `null` otherwise.
 */
export function normalizeHexColor(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim().toLowerCase();
	const match = SHORT_OR_FULL_HEX_PATTERN.exec(trimmed);
	const body = match?.[1];
	if (!body) {
		return null;
	}
	if (body.length === 3) {
		const [r = "0", g = "0", b = "0"] = body;
		return `#${r}${r}${g}${g}${b}${b}`;
	}
	return `#${body}`;
}

/**
 * Returns TaskNotes' fallback hex color for the given external calendar provider.
 */
export function getDefaultProviderColor(provider: ExternalCalendarProviderId): string {
	switch (provider) {
		case "google":
			return "#4285f4";
		case "microsoft":
			return "#0078d4";
		case "ics":
			return "#3788d8";
	}
}

function encodeUtf8Bytes(text: string): Uint8Array {
	if (typeof TextEncoder !== "undefined") {
		return new TextEncoder().encode(text);
	}
	const bytes: number[] = [];
	for (let i = 0; i < text.length; i += 1) {
		const code = text.charCodeAt(i);
		bytes.push((code >> 8) & 0xff, code & 0xff);
	}
	return new Uint8Array(bytes);
}

function fnv1a32Hex(input: string, initialSeed: number): string {
	const bytes = encodeUtf8Bytes(input);
	let hash = initialSeed >>> 0;
	for (const byte of bytes) {
		hash ^= byte;
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

/**
 * Builds an opaque deterministic storage key (`<provider>:<16-hex>`) so raw calendar IDs
 * (which can contain email addresses or subscription identifiers) are never persisted in `data.json`.
 */
export function buildCalendarColorKey(
	provider: ExternalCalendarProviderId,
	calendarId: string,
): string {
	const hi = fnv1a32Hex(`${provider}\0${calendarId}`, 0x811c9dc5);
	const lo = fnv1a32Hex(`tnce-color-v1\0${provider}\0${calendarId}`, 0x9e3779b1);
	return `${provider}:${hi}${lo}`;
}

/**
 * Sanitizes persisted calendar color override maps into a fresh validated dictionary.
 */
export function sanitizeCalendarColorOverrides(raw: unknown): Record<string, string> {
	if (!isRecord(raw)) {
		return {};
	}

	const sanitized: Record<string, string> = {};
	let count = 0;
	for (const [key, value] of Object.entries(raw)) {
		if (count >= MAX_CALENDAR_COLOR_OVERRIDES) {
			break;
		}
		if (!CALENDAR_COLOR_KEY_PATTERN.test(key)) {
			continue;
		}
		const normalizedColor = normalizeHexColor(value);
		if (!normalizedColor) {
			continue;
		}
		sanitized[key] = normalizedColor;
		count += 1;
	}
	return sanitized;
}

interface AttachedColorProviderState {
	key: CacheableProviderKey;
	service: Record<string, unknown>;
	provider: ExternalCalendarProviderId;
	disposed: boolean;
	disposers: Array<() => void>;
	getUnderlyingCalendars: () => unknown;
}

function getDirectOverride(
	overrides: Readonly<Record<string, string>>,
	provider: ExternalCalendarProviderId,
	calendarId: string,
): string | null {
	if (!calendarId) {
		return null;
	}
	const raw = overrides[buildCalendarColorKey(provider, calendarId)];
	return normalizeHexColor(raw);
}

function findPrimaryGoogleCalendarId(rawCalendars: unknown): string | null {
	if (!Array.isArray(rawCalendars)) {
		return null;
	}
	for (const entry of rawCalendars) {
		if (
			isRecord(entry) &&
			entry.primary === true &&
			typeof entry.id === "string" &&
			entry.id.length > 0
		) {
			return entry.id;
		}
	}
	return null;
}

function hasAnyEntries(overrides: Readonly<Record<string, string>>): boolean {
	for (const key in overrides) {
		if (Object.prototype.hasOwnProperty.call(overrides, key)) {
			return true;
		}
	}
	return false;
}

/**
 * Applies user-configured display color overrides cleanly on top of TaskNotes'
 * external calendar services (Google, Microsoft, ICS) without mutating upstream data.
 *
 * Must be layered ABOVE `ExternalCalendarCacheController` so startup local cache
 * always stores true upstream colors while UI views receive overridden colors.
 */
export class CalendarColorOverridesController {
	private enabled = false;
	private enableToken = 0;
	private readonly providers = new Map<CacheableProviderKey, AttachedColorProviderState>();

	constructor(
		private readonly app: App,
		private readonly getOverrides: () => Readonly<Record<string, string>>,
	) {}

	isEnabled(): boolean {
		return this.enabled;
	}

	enable(): void {
		if (this.enabled) {
			return;
		}
		this.enabled = true;
		const token = ++this.enableToken;

		const attachedAny = this.attachMissingProviders();
		if (attachedAny && hasAnyEntries(this.getOverrides())) {
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
					const lateAttached = this.attachMissingProviders();
					if (lateAttached && hasAnyEntries(this.getOverrides())) {
						refreshOpenCalendarViews(this.app);
					}
				});
			} catch {
				// Ignore mock workspaces without functional onLayoutReady.
			}
		}
	}

	disable(options?: { refreshViews?: boolean }): void {
		const hadAttached = this.providers.size > 0;
		if (!this.enabled && !hadAttached) {
			return;
		}
		this.enabled = false;
		this.enableToken += 1;
		this.detachAllProviders();

		if (options?.refreshViews !== false && hadAttached) {
			refreshOpenCalendarViews(this.app);
		}
	}

	/**
	 * Re-stacks wrappers above newly attached lower layers (such as `ExternalCalendarCacheController`).
	 */
	reattach(): void {
		if (!this.enabled) {
			return;
		}
		this.detachAllProviders();
		this.attachMissingProviders();
	}

	notifyOverridesChanged(): void {
		if (!this.enabled) {
			return;
		}
		this.attachMissingProviders();
		refreshOpenCalendarViews(this.app);
	}

	/**
	 * Looks up the active normalized override color for a calendar, resolving Google's `primary` alias.
	 */
	getOverrideColor(provider: ExternalCalendarProviderId, calendarId: string): string | null {
		if (!this.enabled) {
			return null;
		}
		const overrides = this.getOverrides();
		const direct = getDirectOverride(overrides, provider, calendarId);
		if (direct) {
			return direct;
		}
		if (provider !== "google") {
			return null;
		}

		for (const state of this.providers.values()) {
			if (state.disposed || state.provider !== "google") {
				continue;
			}
			const primaryId = findPrimaryGoogleCalendarId(state.getUnderlyingCalendars());
			if (!primaryId) {
				continue;
			}
			if (calendarId === "primary") {
				const primaryOverride = getDirectOverride(overrides, "google", primaryId);
				if (primaryOverride) {
					return primaryOverride;
				}
			} else if (calendarId === primaryId) {
				const aliasOverride = getDirectOverride(overrides, "google", "primary");
				if (aliasOverride) {
					return aliasOverride;
				}
			}
		}
		return null;
	}

	private detachAllProviders(): void {
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
		}
		this.providers.clear();
	}

	private attachMissingProviders(): boolean {
		const targets = getCacheableCalendarProviders(this.app);
		let attachedAny = false;

		for (const target of targets) {
			const existing = this.providers.get(target.key);
			if (existing) {
				if (existing.service === target.service) {
					continue;
				}
				existing.disposed = true;
				for (const dispose of existing.disposers) {
					try {
						dispose();
					} catch {
						// Ignore cleanup errors when swapping provider instances.
					}
				}
				this.providers.delete(target.key);
			}

			this.attachProvider(target);
			attachedAny = true;
		}

		return attachedAny;
	}

	private attachProvider(target: CacheableProviderTarget): void {
		const provider: ExternalCalendarProviderId =
			target.key === "ics"
				? "ics"
				: target.key === "microsoft"
					? "microsoft"
					: "google";

		const state: AttachedColorProviderState = {
			key: target.key,
			service: target.service,
			provider,
			disposed: false,
			disposers: [],
			getUnderlyingCalendars: () => safeCall(target.service, "getAvailableCalendars"),
		};
		this.providers.set(target.key, state);

		if (target.kind === "ics") {
			this.attachIcsWrappers(state);
		} else {
			this.attachOAuthWrappers(state);
		}
	}

	private attachIcsWrappers(state: AttachedColorProviderState): void {
		const { service } = state;

		if (asCallable(service.getSubscriptions)) {
			const unpatchSubs = patchMethod(service, "getSubscriptions", (original) => {
				return (...args: unknown[]): unknown => {
					const rawList = original.apply(service, args);
					if (!this.enabled || state.disposed || !Array.isArray(rawList)) {
						return rawList;
					}
					const overrides = this.getOverrides();
					if (!hasAnyEntries(overrides)) {
						return rawList;
					}
					return rawList.map((entry: unknown): unknown => {
						if (!isRecord(entry) || typeof entry.id !== "string") {
							return entry;
						}
						const override = getDirectOverride(overrides, "ics", entry.id);
						return override ? { ...entry, color: override } : entry;
					});
				};
			});
			if (unpatchSubs) {
				state.disposers.push(unpatchSubs);
			}
		}

		if (asCallable(service.getAllEvents)) {
			const unpatchEvents = patchMethod(service, "getAllEvents", (original) => {
				return (...args: unknown[]): unknown => {
					const rawList = original.apply(service, args);
					if (!this.enabled || state.disposed || !Array.isArray(rawList)) {
						return rawList;
					}
					const overrides = this.getOverrides();
					if (!hasAnyEntries(overrides)) {
						return rawList;
					}
					return rawList.map((entry: unknown): unknown => {
						if (!isRecord(entry) || typeof entry.subscriptionId !== "string") {
							return entry;
						}
						const override = getDirectOverride(overrides, "ics", entry.subscriptionId);
						return override ? { ...entry, color: override } : entry;
					});
				};
			});
			if (unpatchEvents) {
				state.disposers.push(unpatchEvents);
			}
		}
	}

	private attachOAuthWrappers(state: AttachedColorProviderState): void {
		const { service, provider } = state;
		const prefix = provider === "microsoft" ? "microsoft-" : "google-";

		if (asCallable(service.getAvailableCalendars)) {
			const unpatchCalendars = patchMethod(
				service,
				"getAvailableCalendars",
				(original) => {
					state.getUnderlyingCalendars = () => original.apply(service);
					return (...args: unknown[]): unknown => {
						const rawList = original.apply(service, args);
						if (!this.enabled || state.disposed || !Array.isArray(rawList)) {
							return rawList;
						}
						const overrides = this.getOverrides();
						if (!hasAnyEntries(overrides)) {
							return rawList;
						}
						return rawList.map((entry: unknown): unknown => {
							if (!isRecord(entry) || typeof entry.id !== "string") {
								return entry;
							}
							let override = getDirectOverride(overrides, provider, entry.id);
							if (!override && provider === "google" && entry.primary === true) {
								override = getDirectOverride(overrides, "google", "primary");
							}
							if (!override) {
								return entry;
							}
							return {
								...entry,
								backgroundColor: override,
								...(provider === "microsoft" || typeof entry.color === "string"
									? { color: override }
									: {}),
							};
						});
					};
				},
			);
			if (unpatchCalendars) {
				state.disposers.push(unpatchCalendars);
			}
		}

		if (asCallable(service.getAllEvents)) {
			const unpatchEvents = patchMethod(service, "getAllEvents", (original) => {
				return (...args: unknown[]): unknown => {
					const rawList = original.apply(service, args);
					if (!this.enabled || state.disposed || !Array.isArray(rawList)) {
						return rawList;
					}
					const overrides = this.getOverrides();
					if (!hasAnyEntries(overrides)) {
						return rawList;
					}

					let primaryResolved = false;
					let cachedPrimaryId: string | null = null;
					const getPrimaryCalendarId = (): string | null => {
						if (primaryResolved) {
							return cachedPrimaryId;
						}
						primaryResolved = true;
						if (provider !== "google") {
							return null;
						}
						cachedPrimaryId = findPrimaryGoogleCalendarId(state.getUnderlyingCalendars());
						return cachedPrimaryId;
					};

					return rawList.map((entry: unknown): unknown => {
						if (
							!isRecord(entry) ||
							typeof entry.subscriptionId !== "string" ||
							!entry.subscriptionId.startsWith(prefix)
						) {
							return entry;
						}
						const rawCalId = entry.subscriptionId.slice(prefix.length);
						let override = getDirectOverride(overrides, provider, rawCalId);
						if (!override && provider === "google") {
							const primaryId = getPrimaryCalendarId();
							if (primaryId) {
								if (rawCalId === "primary") {
									override = getDirectOverride(overrides, "google", primaryId);
								} else if (rawCalId === primaryId) {
									override = getDirectOverride(overrides, "google", "primary");
								}
							}
						}
						return override ? { ...entry, color: override } : entry;
					});
				};
			});
			if (unpatchEvents) {
				state.disposers.push(unpatchEvents);
			}
		}
	}
}
