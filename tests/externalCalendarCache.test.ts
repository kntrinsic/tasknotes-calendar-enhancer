// @vitest-environment happy-dom

import { App } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import {
	CACHE_STORAGE_KEYS,
	CACHE_TTL_MS,
	CACHE_VERSION,
	clearAllExternalCalendarCacheStorage,
	ExternalCalendarCacheController,
	fitPayloadToByteLimit,
	loadProviderCache,
	MAX_FUTURE_CLOCK_SKEW_MS,
	patchMethod,
	saveProviderCache,
	trimEventsForLimit,
} from "../src/externalCalendarCache";

function attachLocalStorageApp(
	app: App,
	tasknotes: Record<string, unknown>,
	refetchEvents?: () => Promise<void>,
): App {
	const mutable = app as unknown as {
		plugins?: { plugins?: Record<string, unknown> };
		workspace: { getLeavesOfType?: (viewType: string) => unknown[] };
	};
	mutable.plugins = { plugins: { tasknotes } };

	const containerEl = document.createElement("div");
	mutable.workspace.getLeavesOfType = (viewType: string) =>
		viewType === "bases" && refetchEvents
			? [
					{
						view: {
							getViewType: () => "bases",
							controller: {
								view: {
									type: "tasknotesCalendar",
									containerEl,
									config: {
										get: () => undefined,
										set: vi.fn(),
									},
									refetchEvents,
								},
							},
						},
					},
				]
			: [];

	return app;
}

function createEventEmitterService<T extends Record<string, unknown>>(
	base: T,
): T & {
	emitEvent: (name: string) => void;
	listenerCount: (name: string) => number;
} {
	const listeners = new Map<string, Set<() => void>>();
	return {
		...base,
		on: (eventName: string, cb: () => void) => {
			let set = listeners.get(eventName);
			if (!set) {
				set = new Set();
				listeners.set(eventName, set);
			}
			set.add(cb);
			return () => {
				set.delete(cb);
			};
		},
		emitEvent: (eventName: string) => {
			for (const cb of listeners.get(eventName) ?? []) {
				cb();
			}
		},
		listenerCount: (eventName: string) => listeners.get(eventName)?.size ?? 0,
	};
}

describe("externalCalendarCache", () => {
	it("patchMethod restores prototype inheritance and keeps stacked wrappers passing through on out-of-order uninstall", () => {
		class DemoService {
			prefix = "base";
			getValue(suffix: string): string {
				return `${this.prefix}:${suffix}`;
			}
		}

		const instance = new DemoService();
		expect(Object.prototype.hasOwnProperty.call(instance, "getValue")).toBe(false);

		const unpatchA = patchMethod(
			instance,
			"getValue",
			(orig) =>
				function (this: unknown, ...args: unknown[]): string {
					return `[A:${String(orig.apply(this, args))}]`;
				},
		);
		expect(Object.prototype.hasOwnProperty.call(instance, "getValue")).toBe(true);
		expect(instance.getValue("1")).toBe("[A:base:1]");

		const unpatchB = patchMethod(
			instance,
			"getValue",
			(orig) =>
				function (this: unknown, ...args: unknown[]): string {
					return `<B:${String(orig.apply(this, args))}>`;
				},
		);
		expect(instance.getValue("2")).toBe("<B:[A:base:2]>");

		// FIFO uninstall: uninstall A first while B is still stacked on top.
		unpatchA?.();
		expect(instance.getValue("3")).toBe("<B:base:3>");

		unpatchB?.();
		expect(instance.getValue("4")).toBe("base:4");
		expect(Object.prototype.hasOwnProperty.call(instance, "getValue")).toBe(false);

		// Re-patch and uninstall cleanly (LIFO).
		const unpatchC = patchMethod(
			instance,
			"getValue",
			(orig) =>
				function (this: unknown, ...args: unknown[]): string {
					return `{C:${String(orig.apply(this, args))}}`;
				},
		);
		expect(instance.getValue("5")).toBe("{C:base:5}");
		unpatchC?.();
		expect(Object.prototype.hasOwnProperty.call(instance, "getValue")).toBe(false);
		expect(instance.getValue("6")).toBe("base:6");
	});

	it("sanitizes ICS subscriptions strictly with whitelist and excludes URLs, paths, and credentials", () => {
		const app = new App();
		const ok = saveProviderCache(
			app,
			"ics",
			{
				calendars: [],
				subscriptions: [
					{
						id: "ics-1",
						name: "Team",
						type: "remote",
						color: "#ff0000",
						enabled: true,
						refreshInterval: 15,
						url: "https://private.example.com/token=secret/feed.ics",
						filePath: "/Users/secret/cal.ics",
						authType: "basic",
						username: "alice",
						filter: "confidential",
						password: "secret-password",
					},
				],
				events: [
					{
						id: "e1",
						subscriptionId: "ics-1",
						title: "Standup",
						start: "2026-11-20T09:00:00Z",
						allDay: false,
						extraSecretField: "should-not-persist",
					},
				],
			},
			1_000_000,
		);

		expect(ok).toBe(true);
		const stored = app.loadLocalStorage(CACHE_STORAGE_KEYS.ics) as Record<string, unknown>;
		expect(stored).not.toBeNull();
		const serialized = JSON.stringify(stored);
		expect(serialized).not.toContain("private.example.com");
		expect(serialized).not.toContain("filePath");
		expect(serialized).not.toContain("authType");
		expect(serialized).not.toContain("username");
		expect(serialized).not.toContain("alice");
		expect(serialized).not.toContain("secret-password");
		expect(serialized).not.toContain("extraSecretField");

		const loaded = loadProviderCache(app, "ics", 1_000_100);
		expect(loaded?.subscriptions).toEqual([
			{
				id: "ics-1",
				name: "Team",
				type: "remote",
				color: "#ff0000",
				enabled: true,
				refreshInterval: 15,
			},
		]);
		expect(loaded?.events).toEqual([
			{
				id: "e1",
				subscriptionId: "ics-1",
				title: "Standup",
				start: "2026-11-20T09:00:00Z",
				allDay: false,
			},
		]);
	});

	it("deletes corrupt, mismatched version, expired TTL, and future-skewed cache payloads on load", () => {
		const app = new App();
		const nowMs = 1_800_000_000_000;

		app.saveLocalStorage(CACHE_STORAGE_KEYS.ics, "{not-valid-json");
		expect(loadProviderCache(app, "ics", nowMs)).toBeNull();
		expect(app.loadLocalStorage(CACHE_STORAGE_KEYS.ics)).toBeNull();

		app.saveLocalStorage(CACHE_STORAGE_KEYS.ics, {
			version: CACHE_VERSION + 1,
			provider: "ics",
			savedAt: nowMs,
			calendars: [],
			subscriptions: [],
			events: [],
		});
		expect(loadProviderCache(app, "ics", nowMs)).toBeNull();
		expect(app.loadLocalStorage(CACHE_STORAGE_KEYS.ics)).toBeNull();

		app.saveLocalStorage(CACHE_STORAGE_KEYS.microsoft, {
			version: CACHE_VERSION,
			provider: "microsoft",
			savedAt: nowMs - CACHE_TTL_MS - 1,
			calendars: [],
			subscriptions: [],
			events: [],
		});
		expect(loadProviderCache(app, "microsoft", nowMs)).toBeNull();
		expect(app.loadLocalStorage(CACHE_STORAGE_KEYS.microsoft)).toBeNull();

		app.saveLocalStorage(CACHE_STORAGE_KEYS["own-google"], {
			version: CACHE_VERSION,
			provider: "own-google",
			savedAt: nowMs + MAX_FUTURE_CLOCK_SKEW_MS + 1,
			calendars: [],
			subscriptions: [],
			events: [],
		});
		expect(loadProviderCache(app, "own-google", nowMs)).toBeNull();
		expect(app.loadLocalStorage(CACHE_STORAGE_KEYS["own-google"])).toBeNull();
	});

	it("trims oversized event lists keeping events closest to now and respecting byte limits", () => {
		const nowMs = Date.parse("2026-11-20T12:00:00Z");
		const events = [
			{
				id: "old",
				subscriptionId: "google-work",
				title: "Old",
				start: "2020-01-01T10:00:00Z",
				allDay: false,
			},
			{
				id: "today",
				subscriptionId: "google-work",
				title: "Today",
				start: "2026-11-20T13:00:00Z",
				allDay: false,
			},
			{
				id: "next-week",
				subscriptionId: "google-work",
				title: "Next week",
				start: "2026-11-27T10:00:00Z",
				allDay: false,
			},
			{
				id: "far-future",
				subscriptionId: "google-work",
				title: "Far future",
				start: "2035-01-01T10:00:00Z",
				allDay: false,
			},
		];

		const trimmed = trimEventsForLimit(events, 2, nowMs);
		expect(trimmed.map((e) => e.id)).toEqual(["today", "next-week"]);

		const bulkyEvents = Array.from({ length: 40 }, (_, index) => ({
			id: `ev-${String(index)}`,
			subscriptionId: "google-work",
			title: `Event ${String(index)} ${"x".repeat(120)}`,
			start: new Date(nowMs + index * 3_600_000).toISOString(),
			allDay: false,
		}));
		const fitted = fitPayloadToByteLimit(
			{
				version: CACHE_VERSION,
				provider: "own-google",
				savedAt: nowMs,
				calendars: [],
				subscriptions: [],
				events: bulkyEvents,
			},
			1500,
			nowMs,
		);
		expect(fitted).not.toBeNull();
		expect((fitted?.events.length ?? 0) > 0 && (fitted?.events.length ?? 99) < 40).toBe(
			true,
		);
		expect(fitted?.events[0]?.id).toBe("ev-0");
	});

	it("serves cloned stale cache before sync, applies enabled calendar filters, and transitions to live passthrough on data-changed", async () => {
		const app = new App();
		saveProviderCache(app, "own-google", {
			calendars: [
				{ id: "work@group.calendar.google.com", summary: "Work", primary: true },
				{ id: "personal", summary: "Personal" },
			],
			subscriptions: [],
			events: [
				{
					id: "cached-1",
					subscriptionId: "google-work@group.calendar.google.com",
					title: "Cached Work",
					start: "2026-11-20T10:00:00Z",
					allDay: false,
				},
				{
					id: "cached-2",
					subscriptionId: "google-personal",
					title: "Cached Personal",
					start: "2026-11-20T11:00:00Z",
					allDay: false,
				},
			],
			connectionGeneration: 1,
		});

		let liveEvents: Array<Record<string, unknown>> = [];
		let liveCalendars: Array<Record<string, unknown>> = [];
		const ownGoogle = createEventEmitterService({
			getAllEvents: () => liveEvents,
			getAvailableCalendars: () => liveCalendars,
		});
		const refetchEvents = vi.fn(() => Promise.resolve());

		attachLocalStorageApp(
			app,
			{
				settings: {
					enabledGoogleCalendars: ["primary"],
				},
				oauthService: {
					isConnected: () => Promise.resolve(true),
					getConnectionGeneration: () => 1,
				},
				ownGoogleCalendarService: ownGoogle,
			},
			refetchEvents,
		);

		const controller = new ExternalCalendarCacheController(app);
		controller.enable();

		// Open calendar view was requested to paint cached startup data.
		expect(refetchEvents).toHaveBeenCalledTimes(1);

		// Respects `primary` alias filter and returns shallow clones safe against TaskNotes array mutation.
		const preSyncEvents = ownGoogle.getAllEvents();
		expect(preSyncEvents.map((e) => e.id)).toEqual(["cached-1"]);
		expect(ownGoogle.getAvailableCalendars()).toHaveLength(2);

		// Simulate GoogleCalendarService.refreshAllCalendars() mutating the array returned by getAllEvents().
		preSyncEvents.push({ id: "mutated" });
		expect(ownGoogle.getAllEvents().map((e) => e.id)).toEqual(["cached-1"]);

		// Simulate TaskNotes completing initial sync (e.g., all events removed -> live empty []).
		liveCalendars = [{ id: "work@group.calendar.google.com", summary: "Work Updated" }];
		liveEvents = [
			{
				id: "live-1",
				subscriptionId: "google-work@group.calendar.google.com",
				title: "Live Event",
				start: "2026-11-21T10:00:00Z",
				allDay: false,
			},
		];
		ownGoogle.emitEvent("data-changed");

		// Flush async isConnected check inside handleProviderDataChanged.
		await Promise.resolve();
		await Promise.resolve();

		expect(ownGoogle.getAllEvents().map((e) => e.id)).toEqual(["live-1"]);
		const updatedStorage = loadProviderCache(app, "own-google");
		expect(updatedStorage?.events.map((e) => e.id)).toEqual(["live-1"]);
		expect(updatedStorage?.calendars[0]?.summary).toBe("Work Updated");

		controller.disable();
		expect(ownGoogle.listenerCount("data-changed")).toBe(0);
	});

	it("retains OAuth cache across restarts when connectionGeneration resets, but purges on mid-session generation change, disconnected state, or disconnect methods", async () => {
		const app = new App();
		saveProviderCache(app, "own-google", {
			calendars: [{ id: "c1", summary: "Cal" }],
			subscriptions: [],
			events: [
				{
					id: "e1",
					subscriptionId: "google-c1",
					title: "Existing Account Event",
					start: "2026-11-20T10:00:00Z",
					allDay: false,
				},
			],
			connectionGeneration: 1,
		});
		saveProviderCache(app, "microsoft", {
			calendars: [{ id: "ms1", summary: "MS" }],
			subscriptions: [],
			events: [
				{
					id: "m1",
					subscriptionId: "microsoft-ms1",
					title: "MS Event",
					start: "2026-11-20T12:00:00Z",
					allDay: false,
				},
			],
		});

		const disconnectMs = vi.fn();
		let googleGen = 0; // Simulates OAuthService.connectionGenerations resetting to 0 on restart.
		const ownGoogle = createEventEmitterService({
			getAllEvents: () => [],
			getAvailableCalendars: () => [],
		});
		const microsoft = createEventEmitterService({
			getAllEvents: () => [],
			getAvailableCalendars: () => [],
			disconnect: disconnectMs,
		});

		attachLocalStorageApp(app, {
			oauthService: {
				isConnected: () => Promise.resolve(true),
				getConnectionGeneration: (provider: string) =>
					provider === "google" ? googleGen : 0,
			},
			ownGoogleCalendarService: ownGoogle,
			microsoftCalendarService: microsoft,
		});

		const controller = new ExternalCalendarCacheController(app);
		controller.enable();

		// Cross-restart generation reset (saved 1 -> startup 0) MUST preserve cache while connected.
		expect(ownGoogle.getAllEvents()).toHaveLength(1);
		expect(loadProviderCache(app, "own-google")).not.toBeNull();

		// Mid-session generation change (0 -> 1) MUST purge cache immediately.
		googleGen = 1;
		expect(ownGoogle.getAllEvents()).toEqual([]);
		expect(loadProviderCache(app, "own-google")).toBeNull();

		// Microsoft stays cached until explicit disconnect() is called.
		expect(microsoft.getAllEvents()).toHaveLength(1);
		microsoft.disconnect();
		expect(disconnectMs).toHaveBeenCalledTimes(1);
		expect(microsoft.getAllEvents()).toEqual([]);
		expect(loadProviderCache(app, "microsoft")).toBeNull();

		// Also verify startup async `isConnected === false` purges & refreshes open views.
		controller.disable();
		saveProviderCache(app, "microsoft", {
			calendars: [{ id: "ms1", summary: "MS" }],
			subscriptions: [],
			events: [
				{
					id: "m2",
					subscriptionId: "microsoft-ms1",
					title: "Stale MS",
					start: "2026-11-20T12:00:00Z",
					allDay: false,
				},
			],
		});
		const refetchEvents = vi.fn(() => Promise.resolve());
		attachLocalStorageApp(
			app,
			{
				oauthService: {
					isConnected: () => Promise.resolve(false),
				},
				microsoftCalendarService: microsoft,
			},
			refetchEvents,
		);
		controller.enable();
		await Promise.resolve();
		await Promise.resolve();
		expect(loadProviderCache(app, "microsoft")).toBeNull();
		expect(refetchEvents).toHaveBeenCalledTimes(2);

		controller.disable();
	});

	it("preserves Hosted Google cache across intermediate restore notifications and own-google startup alias, purging only on revoked/signed-out completion", async () => {
		const app = new App();
		saveProviderCache(app, "hosted-google", {
			calendars: [{ id: "hg1", summary: "Hosted", backgroundColor: "#4285F4" }],
			subscriptions: [],
			events: [
				{
					id: "h1",
					subscriptionId: "google-hg1",
					title: "Hosted Event",
					start: "2026-11-20T09:00:00Z",
					allDay: false,
				},
			],
		});

		let snapshot: Record<string, unknown> = {
			sessionId: null,
			connection: null,
			failure: null,
		};
		let hostedLiveEvents: Array<Record<string, unknown>> = [];
		const clientSubscribers = new Set<() => void>();
		const ownGoogle = createEventEmitterService({
			getAvailableCalendars: (): Array<Record<string, unknown>> => [],
			getAllEvents: (): Array<Record<string, unknown>> => [],
		});

		const hosted = createEventEmitterService({
			isSignedIn: () => snapshot.sessionId !== null,
			isConnected: () =>
				snapshot.sessionId !== null &&
				(snapshot.connection as { status?: string } | null)?.status === "active",
			getAvailableCalendars: () =>
				snapshot.sessionId !== null ? [{ id: "hg1", summary: "Hosted" }] : [],
			getAllEvents: () => hostedLiveEvents,
			signOut: vi.fn(),
			initialize: () => Promise.resolve(),
			client: {
				getSnapshot: () => snapshot,
				restore: async () => {
					// Step 1: intermediate notification before session is restored.
					for (const cb of clientSubscribers) {
						cb();
					}
					await Promise.resolve();
					// Step 2: sessionId restored while connection object is still null.
					snapshot = { sessionId: "s1", connection: null, failure: null };
					tasknotesObj.googleCalendarService = hosted;
					hosted.emitEvent("session-changed");
					for (const cb of clientSubscribers) {
						cb();
					}
					await Promise.resolve();
					// Step 3: connection becomes active.
					snapshot = {
						sessionId: "s1",
						connection: { status: "active" },
						failure: null,
					};
					for (const cb of clientSubscribers) {
						cb();
					}
				},
				subscribe: (cb: () => void) => {
					clientSubscribers.add(cb);
					return () => {
						clientSubscribers.delete(cb);
					};
				},
			},
		});

		const tasknotesObj: Record<string, unknown> = {
			oauthService: {
				isConnected: () => Promise.resolve(false),
			},
			ownGoogleCalendarService: ownGoogle,
			hostedGoogleCalendarService: hosted,
			googleCalendarService: ownGoogle,
		};
		attachLocalStorageApp(app, tasknotesObj);

		const controller = new ExternalCalendarCacheController(app);
		controller.enable();

		// T=0: before restore(), active googleCalendarService points to ownGoogle; fallback serves hosted cache!
		expect(ownGoogle.getAvailableCalendars()).toHaveLength(1);
		expect(ownGoogle.getAllEvents().map((e) => e.id)).toEqual(["h1"]);

		// Intermediate notifications during restore must NOT flash-clear hosted cache!
		await hosted.client.restore();
		expect(hosted.getAllEvents().map((e) => e.id)).toEqual(["h1"]);
		expect(loadProviderCache(app, "hosted-google")).not.toBeNull();

		// Network sync completes -> data-changed switches to live events.
		hostedLiveEvents = [
			{
				id: "h-live",
				subscriptionId: "google-hg1",
				title: "Live Hosted",
				start: "2026-11-20T10:00:00Z",
				allDay: false,
			},
		];
		hosted.emitEvent("data-changed");
		expect(hosted.getAllEvents().map((e) => e.id)).toEqual(["h-live"]);

		// Verify offline startup (`failure: "unavailable"`) preserves cache, while confirmed signed-out restore / `session_expired` / `session-changed` sign-out purge it.
		controller.disable();
		saveProviderCache(app, "hosted-google", {
			calendars: [{ id: "hg1", summary: "Hosted" }],
			subscriptions: [],
			events: [
				{
					id: "h2",
					subscriptionId: "google-hg1",
					title: "Offline Preserved",
					start: "2026-11-20T09:00:00Z",
					allDay: false,
				},
			],
		});
		hostedLiveEvents = [];
		snapshot = { sessionId: null, connection: null, failure: null };
		hosted.client.restore = () => {
			for (const cb of clientSubscribers) {
				cb();
			}
			return Promise.resolve();
		};
		controller.enable();

		// Offline error preserves cache.
		snapshot = { sessionId: null, connection: null, failure: "unavailable" };
		for (const cb of clientSubscribers) {
			cb();
		}
		expect(hosted.getAllEvents()).toHaveLength(1);

		// Restore settles signed out with no failure -> purges cache.
		snapshot = { sessionId: null, connection: null, failure: null };
		await hosted.client.restore();
		expect(hosted.getAllEvents()).toEqual([]);
		expect(loadProviderCache(app, "hosted-google")).toBeNull();

		// Re-seed signed-in then trigger `session-changed` sign-out -> purges cache.
		controller.disable();
		saveProviderCache(app, "hosted-google", {
			calendars: [],
			subscriptions: [],
			events: [
				{
					id: "h3",
					subscriptionId: "google-hg1",
					title: "SignedIn Event",
					start: "2026-11-20T10:00:00Z",
					allDay: false,
				},
			],
		});
		snapshot = {
			sessionId: "s1",
			connection: { status: "active" },
			failure: null,
		};
		controller.enable();
		expect(hosted.getAllEvents()).toHaveLength(1);

		snapshot = { sessionId: null, connection: null, failure: null };
		hosted.emitEvent("session-changed");
		expect(hosted.getAllEvents()).toEqual([]);
		expect(loadProviderCache(app, "hosted-google")).toBeNull();

		controller.disable();
	});

	it("keeps pending ICS subscriptions cached during staggered fetches until each subscription finishes", async () => {
		const app = new App();
		saveProviderCache(app, "ics", {
			calendars: [],
			subscriptions: [
				{
					id: "ics-a",
					name: "Feed A",
					type: "remote",
					color: "#111111",
					enabled: true,
					refreshInterval: 60,
				},
				{
					id: "ics-b",
					name: "Feed B",
					type: "remote",
					color: "#222222",
					enabled: true,
					refreshInterval: 60,
				},
			],
			events: [
				{
					id: "a-cached",
					subscriptionId: "ics-a",
					title: "Cached A",
					start: "2026-11-20T09:00:00Z",
					allDay: false,
				},
				{
					id: "b-cached",
					subscriptionId: "ics-b",
					title: "Cached B",
					start: "2026-11-20T14:00:00Z",
					allDay: false,
				},
			],
		});

		let liveSubs: Array<Record<string, unknown>> = [];
		let liveEvents: Array<Record<string, unknown>> = [];
		const lastFetched = new Map<string, string>();
		const icsService = createEventEmitterService({
			getSubscriptions: () => liveSubs,
			getAllEvents: () => liveEvents,
			getLastFetched: (id: string) => lastFetched.get(id),
			getLastError: () => undefined,
			initialize: async () => {
				liveSubs = [
					{ id: "ics-a", name: "Feed A", enabled: true, color: "#111111", type: "remote", refreshInterval: 60 },
					{ id: "ics-b", name: "Feed B", enabled: true, color: "#222222", type: "remote", refreshInterval: 60 },
				];
				await Promise.resolve();
			},
		});

		attachLocalStorageApp(app, {
			icsSubscriptionService: icsService,
		});

		const controller = new ExternalCalendarCacheController(app);
		controller.enable();

		// T=0: both cached feeds are visible immediately.
		expect(icsService.getSubscriptions().map((s) => s.id)).toEqual(["ics-a", "ics-b"]);
		expect(icsService.getAllEvents().map((e) => e.id)).toEqual([
			"a-cached",
			"b-cached",
		]);

		// Step 1: ics-a completes first and emits data-changed while ics-b is still fetching.
		await icsService.initialize();
		lastFetched.set("ics-a", "2026-11-20T09:01:00Z");
		liveEvents = [
			{
				id: "a-live",
				subscriptionId: "ics-a",
				title: "Live A",
				start: "2026-11-20T09:30:00Z",
				allDay: false,
			},
		];
		icsService.emitEvent("data-changed");
		await Promise.resolve();

		// Crucial: ics-b MUST remain visible alongside live ics-a events!
		expect(icsService.getAllEvents().map((e) => e.id)).toEqual([
			"a-live",
			"b-cached",
		]);
		expect(loadProviderCache(app, "ics")?.events.map((e) => e.id)).toEqual([
			"a-live",
			"b-cached",
		]);

		// Step 2: ics-b completes (even with empty live events) -> transitions cleanly to live truth.
		lastFetched.set("ics-b", "2026-11-20T09:02:00Z");
		icsService.emitEvent("data-changed");
		await Promise.resolve();

		expect(icsService.getAllEvents().map((e) => e.id)).toEqual(["a-live"]);
		expect(loadProviderCache(app, "ics")?.events.map((e) => e.id)).toEqual([
			"a-live",
		]);

		controller.disable();
	});

	it("clears all caches via controller.clearAll and clearAllExternalCalendarCacheStorage when disabled", () => {
		const app = new App();
		for (const key of ["ics", "hosted-google", "own-google", "microsoft"] as const) {
			saveProviderCache(app, key, {
				calendars: [],
				subscriptions: [],
				events: [
					{
						id: `ev-${key}`,
						subscriptionId: "sub",
						title: "Item",
						start: "2026-11-20T10:00:00Z",
						allDay: false,
					},
				],
			});
		}

		const refetchEvents = vi.fn(() => Promise.resolve());
		const icsService = createEventEmitterService({
			getSubscriptions: () => [],
			getAllEvents: () => [],
		});
		attachLocalStorageApp(
			app,
			{
				icsSubscriptionService: icsService,
			},
			refetchEvents,
		);

		const controller = new ExternalCalendarCacheController(app);
		controller.enable();
		expect(icsService.getAllEvents()).toHaveLength(1);

		controller.clearAll();
		expect(icsService.getAllEvents()).toEqual([]);
		expect(refetchEvents).toHaveBeenCalledTimes(2);
		for (const storageKey of Object.values(CACHE_STORAGE_KEYS)) {
			expect(app.loadLocalStorage(storageKey)).toBeNull();
		}

		// Disable and seed again; standalone helper clears storage even while feature is OFF.
		controller.disable();
		saveProviderCache(app, "ics", {
			calendars: [],
			subscriptions: [],
			events: [],
		});
		expect(app.loadLocalStorage(CACHE_STORAGE_KEYS.ics)).not.toBeNull();
		clearAllExternalCalendarCacheStorage(app);
		expect(app.loadLocalStorage(CACHE_STORAGE_KEYS.ics)).toBeNull();
	});
});
