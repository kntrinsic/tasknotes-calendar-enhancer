// @vitest-environment happy-dom

import { type App, TFile } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	findToolbarForContainer,
	getActiveCalendarViews,
	getActiveGoogleCalendarService,
	getBasesLeafContainers,
	getCacheableCalendarProviders,
	getEnabledProviderCalendarIds,
	getExternalCalendarSnapshot,
	getHostedGoogleConnectionState,
	getIcsSubscriptionSyncState,
	getOAuthConnectionGeneration,
	getTaskNotesPlugin,
	hasAnyEnabledIcsSubscription,
	isOAuthProviderConnected,
	openTaskNotesSettings,
	parseDayNumber,
	refreshOpenCalendarViews,
	subscribeExternalCalendarChanges,
	subscribeHostedGoogleClient,
	subscribeSingleProviderEvent,
} from "../src/tasknotesBridge";

interface MockLeafSpec {
	viewType: string;
	controllerViewType?: string;
	containerEl?: HTMLElement;
	configGet?: (key: string) => unknown;
	configSet?: (key: string, value: unknown) => void;
	readEventToggles?: () => void;
	refresh?: () => void;
	refetchEvents?: () => Promise<void>;
	viewOptions?: Record<string, unknown>;
	calendar?: Record<string, unknown>;
}

function createBasesDom(connected = true): {
	parentEl: HTMLDivElement;
	toolbarEl: HTMLDivElement;
	containerEl: HTMLDivElement;
} {
	const parentEl = document.createElement("div");
	const toolbarEl = document.createElement("div");
	toolbarEl.className = "bases-toolbar";
	const basesViewEl = document.createElement("div");
	basesViewEl.className = "bases-view";
	const containerEl = document.createElement("div");
	basesViewEl.appendChild(containerEl);
	parentEl.append(toolbarEl, basesViewEl);
	if (connected) {
		document.body.appendChild(parentEl);
	}
	return { parentEl, toolbarEl, containerEl };
}

function createMockApp(options: {
	tasknotes?: unknown;
	leaves?: MockLeafSpec[];
	setting?: Record<string, unknown>;
	vaultFiles?: Map<string, TFile>;
	openFileSpy?: (file: TFile) => Promise<void>;
}): App {
	const leaves = (options.leaves ?? []).map((spec) => ({
		view: {
			getViewType: () => spec.viewType,
			containerEl: spec.containerEl,
			controller: spec.controllerViewType
				? {
						view: {
							type: spec.controllerViewType,
							containerEl: spec.containerEl,
							config:
								spec.configGet && spec.configSet
									? { get: spec.configGet, set: spec.configSet }
									: undefined,
							readEventToggles: spec.readEventToggles,
							refresh: spec.refresh,
							refetchEvents: spec.refetchEvents,
							viewOptions: spec.viewOptions,
							calendar: spec.calendar,
						},
					}
				: undefined,
		},
	}));

	return {
		plugins: {
			plugins:
				options.tasknotes === undefined ? {} : { tasknotes: options.tasknotes },
		},
		vault: {
			getAbstractFileByPath: (filePath: string) =>
				options.vaultFiles?.get(filePath) ?? null,
		},
		workspace: {
			getLeavesOfType: (viewType: string) =>
				viewType === "bases" ? leaves : [],
			getLeaf: () => ({
				openFile: options.openFileSpy ?? (() => Promise.resolve()),
			}),
		},
		setting: options.setting,
	} as unknown as App;
}

describe("tasknotesBridge", () => {
	beforeEach(() => {
		document.body.replaceChildren();
	});

	it("returns null safely when TaskNotes plugin is missing or malformed", () => {
		expect(getTaskNotesPlugin(createMockApp({}))).toBeNull();
		expect(getTaskNotesPlugin(createMockApp({ tasknotes: "invalid" }))).toBeNull();
		expect(getExternalCalendarSnapshot(createMockApp({}))).toEqual({
			groups: [],
			hostedGoogle: null,
		});
	});

	it("finds toolbar across .bases-view parent", () => {
		const { toolbarEl, containerEl } = createBasesDom();
		expect(findToolbarForContainer(containerEl)).toBe(toolbarEl);
	});

	it("detects only tasknotesCalendar views and ignores mini calendar and non-bases views", () => {
		const mainDom = createBasesDom();
		const miniDom = createBasesDom();
		const listDom = createBasesDom();

		const app = createMockApp({
			leaves: [
				{
					viewType: "bases",
					controllerViewType: "tasknotesCalendar",
					containerEl: mainDom.containerEl,
					configGet: () => undefined,
					configSet: vi.fn(),
				},
				{
					viewType: "bases",
					controllerViewType: "tasknotesMiniCalendar",
					containerEl: miniDom.containerEl,
					configGet: () => undefined,
					configSet: vi.fn(),
				},
				{
					viewType: "markdown",
					controllerViewType: "tasknotesCalendar",
					containerEl: listDom.containerEl,
					configGet: () => undefined,
					configSet: vi.fn(),
				},
			],
		});

		const handles = getActiveCalendarViews(app);
		expect(handles).toHaveLength(1);
		expect(handles[0]?.containerEl).toBe(mainDom.containerEl);
		expect(handles[0]?.toolbarEl).toBe(mainDom.toolbarEl);
		expect(getBasesLeafContainers(app)).toEqual([mainDom.containerEl, miniDom.containerEl]);
	});

	it("guards config.set on disconnected views (Bases #1397) and refreshes connected views", () => {
		const connectedDom = createBasesDom(true);
		const detachedDom = createBasesDom(false);

		const connectedValues = new Map<string, unknown>();
		const readEventToggles = vi.fn();
		const refresh = vi.fn();
		const detachedSet = vi.fn();

		const fallbackDom = createBasesDom(true);
		const refetchEvents = vi.fn(() => Promise.resolve());
		const fallbackSet = vi.fn();

		const app = createMockApp({
			leaves: [
				{
					viewType: "bases",
					controllerViewType: "tasknotesCalendar",
					containerEl: connectedDom.containerEl,
					configGet: (key) => connectedValues.get(key),
					configSet: (key, val) => {
						connectedValues.set(key, val);
					},
					readEventToggles,
					refresh,
				},
				{
					viewType: "bases",
					controllerViewType: "tasknotesCalendar",
					containerEl: detachedDom.containerEl,
					configGet: () => true,
					configSet: detachedSet,
				},
				{
					viewType: "bases",
					controllerViewType: "tasknotesCalendar",
					containerEl: fallbackDom.containerEl,
					configGet: () => true,
					configSet: fallbackSet,
					refetchEvents,
				},
			],
		});

		const [connectedHandle, detachedHandle, fallbackHandle] = getActiveCalendarViews(app);
		expect(connectedHandle?.getBooleanConfig("showICS_work", true)).toBe(true);
		expect(connectedHandle?.setCalendarToggle("showICS_work", false)).toBe(true);
		expect(connectedHandle?.getBooleanConfig("showICS_work", true)).toBe(false);
		expect(readEventToggles).toHaveBeenCalledTimes(1);
		expect(refresh).toHaveBeenCalledTimes(1);

		expect(detachedHandle?.setCalendarToggle("showICS_work", false)).toBe(false);
		expect(detachedSet).not.toHaveBeenCalled();

		expect(fallbackHandle?.setCalendarToggle("showGoogleCalendar_primary", false)).toBe(true);
		expect(fallbackSet).toHaveBeenCalledWith("showGoogleCalendar_primary", false);
		expect(refetchEvents).toHaveBeenCalledTimes(1);
	});

	it("collects grouped external calendars, skips disabled ICS, deduplicates, and isolates broken providers", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const hostedService = {
			isSignedIn: () => true,
			isConnected: () => true,
			getAvailableCalendars: () => [
				{ id: "primary", summary: "Personal", primary: true, backgroundColor: "#4285F4" },
				{ id: "primary", summary: "Duplicate Personal", primary: true },
			],
			getAllCalendars: () =>
				Array.from({ length: 8 }, (_, index) => ({ id: `x-${String(index)}` })),
		};

		const app = createMockApp({
			tasknotes: {
				googleCalendarService: hostedService,
				hostedGoogleCalendarService: hostedService,
				microsoftCalendarService: {
					getAvailableCalendars: () => {
						throw new Error("microsoft unavailable");
					},
				},
				icsSubscriptionService: {
					getSubscriptions: () => [
						{ id: "team", name: "Team", enabled: true, color: "#00aa88" },
						{ id: "disabled", name: "Disabled", enabled: false, color: "#999999" },
					],
				},
			},
		});

		const snapshot = getExternalCalendarSnapshot(app);
		expect(snapshot.groups).toEqual([
			{
				provider: "google",
				title: "Google Calendar",
				items: [
					{
						provider: "google",
						id: "primary",
						configKey: "showGoogleCalendar_primary",
						name: "Personal",
						color: "#4285F4",
						primary: true,
					},
				],
			},
			{
				provider: "ics",
				title: "ICS Subscriptions",
				items: [
					{
						provider: "ics",
						id: "team",
						configKey: "showICS_team",
						name: "Team",
						color: "#00aa88",
					},
				],
			},
		]);
		expect(snapshot.hostedGoogle).toEqual({
			isHostedActive: true,
			isSignedIn: true,
			isConnected: true,
			shownCount: 1,
			totalCount: 8,
		});
		warnSpy.mockRestore();
	});

	it("subscribes to provider data-changed and hosted session-changed and unsubscribes cleanly", () => {
		const listeners = new Map<string, Set<() => void>>();
		const makeEmitter = () => ({
			on: (event: string, cb: () => void) => {
				let set = listeners.get(event);
				if (!set) {
					set = new Set();
					listeners.set(event, set);
				}
				set.add(cb);
				return () => {
					set.delete(cb);
				};
			},
		});

		const hosted = makeEmitter();
		const ics = makeEmitter();
		const app = createMockApp({
			tasknotes: {
				googleCalendarService: hosted,
				hostedGoogleCalendarService: hosted,
				icsSubscriptionService: ics,
			},
		});

		const onChange = vi.fn();
		const dispose = subscribeExternalCalendarChanges(app, onChange);

		for (const cb of listeners.get("data-changed") ?? []) {
			cb();
		}
		for (const cb of listeners.get("session-changed") ?? []) {
			cb();
		}
		expect(onChange).toHaveBeenCalledTimes(3);

		dispose();
		dispose();
		for (const cb of listeners.get("data-changed") ?? []) {
			cb();
		}
		for (const cb of listeners.get("session-changed") ?? []) {
			cb();
		}
		expect(onChange).toHaveBeenCalledTimes(3);
	});

	it("opens TaskNotes settings tab safely without modifying config", () => {
		const open = vi.fn();
		const openTabById = vi.fn();
		const app = createMockApp({
			setting: { open, openTabById },
		});

		expect(openTaskNotesSettings(app)).toBe(true);
		expect(open).toHaveBeenCalledTimes(1);
		expect(openTabById).toHaveBeenCalledWith("tasknotes");
		expect(openTaskNotesSettings(createMockApp({}))).toBe(false);
	});

	it("parses valid ISO dates into UTC epoch day numbers and rejects invalid dates", () => {
		expect(parseDayNumber("1970-01-01")).toBe(0);
		expect(parseDayNumber("2024-02-29")).toBe(
			Math.floor(Date.UTC(2024, 1, 29) / 86_400_000),
		);
		expect(parseDayNumber("2026-11-20")).toBe(
			Math.floor(Date.UTC(2026, 10, 20) / 86_400_000),
		);
		expect(parseDayNumber("2026-02-31")).toBeNull();
		expect(parseDayNumber("2026-13-01")).toBeNull();
		expect(parseDayNumber("")).toBeNull();
		expect(parseDayNumber("not-a-date")).toBeNull();
	});

	it("exposes month-tap state helpers, openDayMorePopover, and openTaskFromPath", async () => {
		const dom = createBasesDom(true);
		const chipEl = document.createElement("div");
		const meta = new WeakMap<HTMLElement, unknown>([[chipEl, { id: "1" }]]);
		const openMore = vi.fn();
		const openTaskEditModal = vi.fn();
		const openFileSpy = vi.fn(() => Promise.resolve());
		const taskFile = new TFile();
		taskFile.path = "TaskNotes/Tasks/demo.md";
		taskFile.extension = "md";

		let singleClickAction = "edit";
		let selectionActive = false;

		const app = createMockApp({
			tasknotes: {
				settings: {
					get singleClickAction() {
						return singleClickAction;
					},
				},
				taskSelectionService: {
					isSelectionModeActive: () => selectionActive,
				},
				cacheManager: {
					getTaskInfo: (taskPath: string) =>
						Promise.resolve(
							taskPath === taskFile.path ? { path: taskPath, title: "Demo" } : null,
						),
				},
				openTaskEditModal,
			},
			vaultFiles: new Map([[taskFile.path, taskFile]]),
			openFileSpy,
			leaves: [
				{
					viewType: "bases",
					controllerViewType: "tasknotesCalendar",
					containerEl: dom.containerEl,
					configGet: () => undefined,
					configSet: vi.fn(),
					viewOptions: { showMonthDayPanel: false },
					calendar: {
						meta,
						session: { active: false },
						openMore,
					},
				},
			],
		});

		const [handle] = getActiveCalendarViews(app);
		expect(handle).toBeDefined();
		expect(handle?.isMonthDayPanelEnabled()).toBe(false);
		expect(handle?.isSelectionModeActive()).toBe(false);
		selectionActive = true;
		expect(handle?.isSelectionModeActive()).toBe(true);
		selectionActive = false;

		expect(handle?.isCalendarEngineDragging()).toBe(false);
		const draggingEl = document.createElement("div");
		draggingEl.className = "tnc-dragging";
		dom.containerEl.appendChild(draggingEl);
		expect(handle?.isCalendarEngineDragging()).toBe(true);
		draggingEl.remove();

		expect(handle?.hasEngineItemMeta(chipEl)).toBe(true);
		expect(handle?.hasEngineItemMeta(document.createElement("div"))).toBe(false);

		const clickEvent = new MouseEvent("click");
		expect(handle?.openDayMorePopover("2026-11-20", chipEl, clickEvent)).toBe(true);
		expect(openMore).toHaveBeenCalledWith(
			Math.floor(Date.UTC(2026, 10, 20) / 86_400_000),
			chipEl,
			clickEvent,
		);
		expect(handle?.openDayMorePopover("invalid", chipEl, clickEvent)).toBe(false);

		expect(await handle?.openTaskFromPath(taskFile.path)).toBe(true);
		expect(openTaskEditModal).toHaveBeenCalledWith({
			path: taskFile.path,
			title: "Demo",
		});

		singleClickAction = "openNote";
		expect(await handle?.openTaskFromPath(taskFile.path)).toBe(true);
		expect(openFileSpy).toHaveBeenCalledWith(taskFile);
		expect(await handle?.openTaskFromPath("TaskNotes/Tasks/missing.md")).toBe(false);
	});

	it("discovers cacheable external calendar providers without duplicating aliased google services", () => {
		const icsService = { getSubscriptions: () => [], getAllEvents: () => [] };
		const hostedGoogle = {
			isSignedIn: () => true,
			isConnected: () => true,
			getAvailableCalendars: () => [],
			getAllEvents: () => [],
			client: { getSnapshot: () => ({ sessionId: "s1", connection: { status: "active" } }) },
		};
		const ownGoogle = { getAvailableCalendars: () => [], getAllEvents: () => [] };
		const microsoft = { getAvailableCalendars: () => [], getAllEvents: () => [] };

		const app = createMockApp({
			tasknotes: {
				icsSubscriptionService: icsService,
				hostedGoogleCalendarService: hostedGoogle,
				ownGoogleCalendarService: ownGoogle,
				googleCalendarService: hostedGoogle, // alias pointing to hosted
				microsoftCalendarService: microsoft,
			},
		});

		const targets = getCacheableCalendarProviders(app);
		expect(targets.map((t) => [t.key, t.kind])).toEqual([
			["ics", "ics"],
			["hosted-google", "oauth-calendar"],
			["own-google", "oauth-calendar"],
			["microsoft", "oauth-calendar"],
		]);
		expect(targets[1]?.service).toBe(hostedGoogle);
	});

	it("supports fallback googleCalendarService when distinct from own/hosted properties", () => {
		const fallbackGoogle = { getAvailableCalendars: () => [], getAllEvents: () => [] };
		const app = createMockApp({
			tasknotes: {
				googleCalendarService: fallbackGoogle,
			},
		});

		const targets = getCacheableCalendarProviders(app);
		expect(targets).toHaveLength(1);
		expect(targets[0]?.key).toBe("own-google");
		expect(targets[0]?.service).toBe(fallbackGoogle);
	});

	it("reads enabled calendar filters respecting TaskNotes empty-array-means-all semantics", () => {
		const app = createMockApp({
			tasknotes: {
				settings: {
					enabledGoogleCalendars: [],
					enabledMicrosoftCalendars: ["ms-1", "", "ms-2"],
				},
				hostedGoogleCalendarService: {
					client: {
						getSnapshot: () => ({ selected: ["hg-1"] }),
					},
				},
			},
		});

		expect(getEnabledProviderCalendarIds(app, "own-google")).toBeNull();
		expect(getEnabledProviderCalendarIds(app, "microsoft")).toEqual(["ms-1", "ms-2"]);
		expect(getEnabledProviderCalendarIds(app, "hosted-google")).toEqual(["hg-1"]);
		expect(getEnabledProviderCalendarIds(app, "ics")).toBeNull();
	});

	it("evaluates ICS enabled subscription status safely from service or settings", () => {
		const serviceWithDisabled = {
			getSubscriptions: () => [{ id: "sub1", enabled: false }],
		};
		const serviceBeforeInit = { getSubscriptions: () => [] };
		const app = createMockApp({
			tasknotes: {
				settings: {
					icsSubscriptions: [{ id: "sub2", enabled: true }],
				},
			},
		});

		expect(hasAnyEnabledIcsSubscription(app, serviceWithDisabled)).toBe(false);
		expect(hasAnyEnabledIcsSubscription(app, serviceBeforeInit)).toBe(true);
	});

	it("reads OAuth connection state and generation counters defensively", async () => {
		const app = createMockApp({
			tasknotes: {
				oauthService: {
					isConnected: (provider: string) => Promise.resolve(provider === "google"),
					getConnectionGeneration: (provider: string) =>
						provider === "google" ? 3 : "invalid",
				},
			},
		});

		expect(await isOAuthProviderConnected(app, "google")).toBe(true);
		expect(await isOAuthProviderConnected(app, "microsoft")).toBe(false);
		expect(getOAuthConnectionGeneration(app, "google")).toBe(3);
		expect(getOAuthConnectionGeneration(app, "microsoft")).toBeNull();

		const appMissing = createMockApp({ tasknotes: {} });
		expect(await isOAuthProviderConnected(appMissing, "google")).toBeNull();
		expect(getOAuthConnectionGeneration(appMissing, "google")).toBeNull();
	});

	it("reads Hosted Google state, subscribes to client updates, and refreshes open calendar views", () => {
		const pendingHosted = {
			isSignedIn: () => false,
			isConnected: () => false,
			client: {
				getSnapshot: () => ({ sessionId: null, connection: null, failure: null }),
			},
		};
		expect(getHostedGoogleConnectionState(pendingHosted)).toEqual({
			signedIn: false,
			connected: false,
			settled: false,
			hasFailure: false,
			connectionStatus: null,
			failureCode: null,
		});

		const sessionExpiredHosted = {
			isSignedIn: () => false,
			isConnected: () => false,
			client: {
				getSnapshot: () => ({
					sessionId: null,
					connection: { status: "reconnect_required" },
					failure: "session_expired",
				}),
			},
		};
		expect(getHostedGoogleConnectionState(sessionExpiredHosted)).toEqual({
			signedIn: false,
			connected: false,
			settled: true,
			hasFailure: true,
			connectionStatus: "reconnect_required",
			failureCode: "session_expired",
		});

		const unavailableHosted = {
			isSignedIn: () => false,
			isConnected: () => false,
			client: {
				getSnapshot: () => ({
					sessionId: null,
					connection: null,
					failure: { code: "unavailable" },
				}),
			},
		};
		expect(getHostedGoogleConnectionState(unavailableHosted)).toEqual({
			signedIn: false,
			connected: false,
			settled: true,
			hasFailure: true,
			connectionStatus: null,
			failureCode: "unavailable",
		});

		const clientSubscribers = new Set<() => void>();
		const clientUnsub = vi.fn();
		const activeHosted = {
			isSignedIn: () => true,
			isConnected: () => true,
			client: {
				getSnapshot: () => ({
					sessionId: "sess-1",
					connection: { status: "active" },
					failure: null,
				}),
				subscribe: (cb: () => void) => {
					clientSubscribers.add(cb);
					return clientUnsub;
				},
			},
		};
		expect(getHostedGoogleConnectionState(activeHosted)).toEqual({
			signedIn: true,
			connected: true,
			settled: true,
			hasFailure: false,
			connectionStatus: "active",
			failureCode: null,
		});

		const onClientChange = vi.fn();
		const disposeClient = subscribeHostedGoogleClient(activeHosted, onClientChange);
		expect(disposeClient).not.toBeNull();
		for (const cb of clientSubscribers) {
			cb();
		}
		expect(onClientChange).toHaveBeenCalledTimes(1);
		disposeClient?.();
		disposeClient?.();
		expect(clientUnsub).toHaveBeenCalledTimes(1);

		const providerUnsub = vi.fn();
		const providerSubscribers = new Set<() => void>();
		const provider = {
			on: (_event: string, cb: () => void) => {
				providerSubscribers.add(cb);
				return providerUnsub;
			},
		};
		const onProviderEvent = vi.fn();
		const disposeProvider = subscribeSingleProviderEvent(
			provider,
			"data-changed",
			onProviderEvent,
		);
		for (const cb of providerSubscribers) {
			cb();
		}
		expect(onProviderEvent).toHaveBeenCalledTimes(1);
		disposeProvider?.();
		expect(providerUnsub).toHaveBeenCalledTimes(1);

		const callOrder: string[] = [];
		const readEventToggles = vi.fn(() => {
			callOrder.push("readEventToggles");
		});
		const dom = createBasesDom();
		const refetchEvents = vi.fn(() => {
			callOrder.push("refetchEvents");
			return Promise.resolve();
		});
		const app = createMockApp({
			tasknotes: {
				googleCalendarService: activeHosted,
			},
			leaves: [
				{
					viewType: "bases",
					controllerViewType: "tasknotesCalendar",
					containerEl: dom.containerEl,
					configGet: () => undefined,
					configSet: vi.fn(),
					readEventToggles,
					refetchEvents,
				},
			],
		});
		expect(getActiveGoogleCalendarService(app)).toBe(activeHosted);
		refreshOpenCalendarViews(app);
		expect(readEventToggles).toHaveBeenCalledTimes(1);
		expect(refetchEvents).toHaveBeenCalledTimes(1);
		expect(callOrder).toEqual(["readEventToggles", "refetchEvents"]);

		const icsService = {
			getLastFetched: (id: string) =>
				id === "sub-done" ? "2026-11-20T09:00:00Z" : undefined,
			getLastError: (id: string) => (id === "sub-err" ? "Network error" : undefined),
		};
		expect(getIcsSubscriptionSyncState(icsService, "sub-done")).toEqual({
			hasSyncTracker: true,
			fetched: true,
			hasError: false,
		});
		expect(getIcsSubscriptionSyncState(icsService, "sub-err")).toEqual({
			hasSyncTracker: true,
			fetched: false,
			hasError: true,
		});
		expect(getIcsSubscriptionSyncState({}, "sub-any")).toEqual({
			hasSyncTracker: false,
			fetched: false,
			hasError: false,
		});
	});
});
