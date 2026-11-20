// @vitest-environment happy-dom

import type { App } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	findToolbarForContainer,
	getActiveCalendarViews,
	getBasesLeafContainers,
	getExternalCalendarSnapshot,
	getTaskNotesPlugin,
	openTaskNotesSettings,
	subscribeExternalCalendarChanges,
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
		workspace: {
			getLeavesOfType: (viewType: string) =>
				viewType === "bases" ? leaves : [],
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
});
