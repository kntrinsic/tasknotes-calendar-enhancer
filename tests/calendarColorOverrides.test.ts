// @vitest-environment happy-dom

import { App } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildCalendarColorKey,
	CALENDAR_COLOR_KEY_PATTERN,
	CalendarColorOverridesController,
	MAX_CALENDAR_COLOR_OVERRIDES,
	normalizeHexColor,
	sanitizeCalendarColorOverrides,
} from "../src/calendarColorOverrides";
import {
	ExternalCalendarCacheController,
	loadProviderCache,
	saveProviderCache,
} from "../src/externalCalendarCache";

function createEventEmitterService<T extends Record<string, unknown>>(
	base: T,
): T & {
	emitEvent: (name: string) => void;
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
	};
}

function attachAppWithCalendarView(
	app: App,
	tasknotes: Record<string, unknown>,
	refetchEvents = vi.fn(() => Promise.resolve()),
) {
	const configSetSpy = vi.fn();
	const containerEl = document.createElement("div");
	document.body.appendChild(containerEl);

	const mutable = app as unknown as {
		plugins?: { plugins?: Record<string, unknown> };
		workspace: { getLeavesOfType?: (viewType: string) => unknown[] };
	};
	mutable.plugins = { plugins: { tasknotes } };
	mutable.workspace.getLeavesOfType = (viewType: string) =>
		viewType === "bases"
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
										set: configSetSpy,
									},
									refetchEvents,
								},
							},
						},
					},
				]
			: [];

	return { refetchEvents, configSetSpy };
}

describe("calendarColorOverrides", () => {
	afterEach(() => {
		document.body.replaceChildren();
		vi.restoreAllMocks();
	});

	it("normalizes 3-digit and 6-digit hex colors and rejects invalid inputs", () => {
		expect(normalizeHexColor("#AbC")).toBe("#aabbcc");
		expect(normalizeHexColor("  #4285F4 ")).toBe("#4285f4");
		expect(normalizeHexColor("#12345")).toBeNull();
		expect(normalizeHexColor("red")).toBeNull();
		expect(normalizeHexColor("javascript:alert(1)")).toBeNull();
		expect(normalizeHexColor(123)).toBeNull();
	});

	it("hashes calendar identifiers deterministically without leaking raw email or calendar IDs", () => {
		const rawId = "alice.private@example.com";
		const keyA = buildCalendarColorKey("google", rawId);
		const keyB = buildCalendarColorKey("google", rawId);
		const keyMs = buildCalendarColorKey("microsoft", rawId);

		expect(keyA).toBe(keyB);
		expect(keyA).toMatch(CALENDAR_COLOR_KEY_PATTERN);
		expect(keyMs).not.toBe(keyA);
		expect(keyA).not.toContain("alice");
		expect(keyA).not.toContain("example.com");
	});

	it("sanitizes override maps, strips invalid keys/colors, and enforces the max entry cap", () => {
		const validKey = buildCalendarColorKey("ics", "holidays");
		const rawMap: Record<string, unknown> = {
			[validKey]: "#ABC",
			"google:alice@example.com": "#112233",
			[buildCalendarColorKey("google", "bad-color")]: "not-a-hex",
		};
		for (let index = 0; index < MAX_CALENDAR_COLOR_OVERRIDES + 25; index += 1) {
			rawMap[buildCalendarColorKey("microsoft", `cal-${String(index)}`)] = "#123456";
		}

		const sanitized = sanitizeCalendarColorOverrides(rawMap);
		expect(Object.keys(sanitized)).toHaveLength(MAX_CALENDAR_COLOR_OVERRIDES);
		expect(sanitized[validKey]).toBe("#aabbcc");
		expect("google:alice@example.com" in sanitized).toBe(false);
	});

	it("overrides Google (including primary alias), Microsoft, and ICS colors without mutating source objects", () => {
		const rawGoogleCal = {
			id: "alice@example.com",
			summary: "Primary",
			primary: true,
			backgroundColor: "#4285f4",
		};
		const rawGoogleEventByEmail = {
			id: "g-1",
			subscriptionId: "google-alice@example.com",
			title: "Direct",
			start: "2026-11-20T10:00:00",
			allDay: false,
			color: "#4285f4",
		};
		const rawGoogleEventByPrimary = {
			id: "g-2",
			subscriptionId: "google-primary",
			title: "Alias",
			start: "2026-11-20T11:00:00",
			allDay: false,
			color: "#4285f4",
		};
		const rawMsCalWork = {
			id: "ms-work",
			summary: "Work",
			backgroundColor: "#0078d4",
			color: "#0078d4",
		};
		const rawMsCalPersonal = {
			id: "ms-personal",
			summary: "Personal",
			backgroundColor: "#0078d4",
			color: "#0078d4",
		};
		const rawMsEvents = [
			{
				id: "m-1",
				subscriptionId: "microsoft-ms-work",
				title: "Standup",
				start: "2026-11-20T09:00:00",
				allDay: false,
				color: "#0078D4",
			},
			{
				id: "m-2",
				subscriptionId: "microsoft-ms-personal",
				title: "Dentist",
				start: "2026-11-20T15:00:00",
				allDay: false,
				color: "#0078D4",
			},
		];
		const rawIcsSub = {
			id: "ics-holidays",
			name: "Holidays",
			type: "remote" as const,
			color: "#3788d8",
			enabled: true,
			refreshInterval: 60,
		};
		const rawIcsEvent = {
			id: "i-1",
			subscriptionId: "ics-holidays",
			title: "Holiday",
			start: "2026-11-23",
			allDay: true,
			color: "#3788d8",
		};

		const googleService = createEventEmitterService({
			getAvailableCalendars: () => [rawGoogleCal],
			getAllEvents: () => [rawGoogleEventByEmail, rawGoogleEventByPrimary],
		});
		const microsoftService = createEventEmitterService({
			getAvailableCalendars: () => [rawMsCalWork, rawMsCalPersonal],
			getAllEvents: () => rawMsEvents,
		});
		const icsService = createEventEmitterService({
			getSubscriptions: () => [rawIcsSub],
			getAllEvents: () => [rawIcsEvent],
		});

		const overrides: Record<string, string> = {
			[buildCalendarColorKey("google", "alice@example.com")]: "#e05252",
			[buildCalendarColorKey("microsoft", "ms-work")]: "#4caf6a",
			[buildCalendarColorKey("ics", "ics-holidays")]: "#9b6be8",
		};

		const app = new App();
		const { refetchEvents } = attachAppWithCalendarView(app, {
			googleCalendarService: googleService,
			hostedGoogleCalendarService: googleService,
			microsoftCalendarService: microsoftService,
			icsSubscriptionService: icsService,
		});

		const controller = new CalendarColorOverridesController(app, () => overrides);
		controller.enable();

		expect(refetchEvents).toHaveBeenCalledTimes(1);

		const calsGoogle = googleService.getAvailableCalendars();
		expect(calsGoogle[0]?.backgroundColor).toBe("#e05252");
		expect(rawGoogleCal.backgroundColor).toBe("#4285f4");

		const eventsGoogle = googleService.getAllEvents();
		expect(eventsGoogle.map((ev) => ev.color)).toEqual(["#e05252", "#e05252"]);
		expect(rawGoogleEventByEmail.color).toBe("#4285f4");
		expect(rawGoogleEventByPrimary.color).toBe("#4285f4");

		const calsMs = microsoftService.getAvailableCalendars();
		expect(calsMs.map((cal) => [cal.backgroundColor, cal.color])).toEqual([
			["#4caf6a", "#4caf6a"],
			["#0078d4", "#0078d4"],
		]);
		const eventsMs = microsoftService.getAllEvents();
		expect(eventsMs.map((ev) => ev.color)).toEqual(["#4caf6a", "#0078D4"]);
		expect(rawMsEvents[0]?.color).toBe("#0078D4");

		const subsIcs = icsService.getSubscriptions();
		expect(subsIcs[0]?.color).toBe("#9b6be8");
		expect(rawIcsSub.color).toBe("#3788d8");

		const eventsIcs = icsService.getAllEvents();
		expect(eventsIcs[0]?.color).toBe("#9b6be8");
		expect(rawIcsEvent.color).toBe("#3788d8");
	});

	it("stacks cleanly above ExternalCalendarCacheController so cache stores true upstream colors while UI sees overrides", async () => {
		const app = new App();
		saveProviderCache(app, "microsoft", {
			calendars: [
				{
					id: "ms-1",
					summary: "Outlook",
					backgroundColor: "#0078d4",
				},
			],
			subscriptions: [],
			events: [
				{
					id: "ms-cached-1",
					subscriptionId: "microsoft-ms-1",
					title: "Cached Meeting",
					start: "2026-11-20T09:00:00",
					allDay: false,
					color: "#0078D4",
				},
			],
		});

		let liveCals: Array<Record<string, unknown>> = [];
		let liveEvents: Array<Record<string, unknown>> = [];
		const msService = createEventEmitterService({
			getAvailableCalendars: () => liveCals,
			getAllEvents: () => liveEvents,
		});

		attachAppWithCalendarView(app, {
			microsoftCalendarService: msService,
			oauthService: {
				isConnected: () => Promise.resolve(true),
			},
		});

		const cacheController = new ExternalCalendarCacheController(app);
		cacheController.enable();

		const overrides: Record<string, string> = {
			[buildCalendarColorKey("microsoft", "ms-1")]: "#e8833a",
		};
		const colorController = new CalendarColorOverridesController(app, () => overrides);
		colorController.enable();

		// Pre-sync reads cached event with overridden color applied on top.
		const cachedEvents = msService.getAllEvents();
		expect(cachedEvents).toHaveLength(1);
		expect(cachedEvents[0]?.color).toBe("#e8833a");

		// Live sync finishes: cache must persist original #0078D4, while views read #e8833a.
		liveCals = [
			{
				id: "ms-1",
				summary: "Outlook",
				backgroundColor: "#0078d4",
				color: "#0078d4",
			},
		];
		liveEvents = [
			{
				id: "ms-live-1",
				subscriptionId: "microsoft-ms-1",
				title: "Live Meeting",
				start: "2026-11-20T10:00:00",
				allDay: false,
				color: "#0078D4",
			},
		];
		msService.emitEvent("data-changed");
		await Promise.resolve();
		await Promise.resolve();

		const persisted = loadProviderCache(app, "microsoft");
		expect(persisted?.calendars[0]?.backgroundColor).toBe("#0078d4");
		expect(persisted?.events[0]?.color).toBe("#0078D4");

		const liveViewedEvents = msService.getAllEvents();
		expect(liveViewedEvents[0]?.color).toBe("#e8833a");

		// Simulate toggling cache off then back on and reattaching color wrappers on top.
		colorController.disable({ refreshViews: false });
		expect(msService.getAllEvents()[0]?.color).toBe("#0078D4");

		colorController.enable();
		expect(msService.getAllEvents()[0]?.color).toBe("#e8833a");

		cacheController.disable();
		cacheController.enable();
		colorController.reattach();
		expect(msService.getAllEvents()[0]?.color).toBe("#e8833a");

		colorController.disable({ refreshViews: false });
		cacheController.disable();
	});

	it("restores prototype methods cleanly on disable and respects refreshViews: false without calling config.set", () => {
		class ProtoMicrosoftService {
			getAvailableCalendars() {
				return [{ id: "ms-1", summary: "Calendar", backgroundColor: "#0078d4" }];
			}
			getAllEvents() {
				return [
					{
						id: "ev-1",
						subscriptionId: "microsoft-ms-1",
						title: "Event",
						start: "2026-11-20T10:00:00",
						allDay: false,
						color: "#0078D4",
					},
				];
			}
		}

		const service = new ProtoMicrosoftService();
		const app = new App();
		const { refetchEvents, configSetSpy } = attachAppWithCalendarView(app, {
			microsoftCalendarService: service,
		});

		const controller = new CalendarColorOverridesController(app, () => ({
			[buildCalendarColorKey("microsoft", "ms-1")]: "#d9a426",
		}));
		controller.enable();

		expect(Object.prototype.hasOwnProperty.call(service, "getAllEvents")).toBe(true);
		expect(service.getAllEvents()[0]?.color).toBe("#d9a426");
		expect(refetchEvents).toHaveBeenCalledTimes(1);

		refetchEvents.mockClear();
		controller.disable({ refreshViews: false });

		expect(refetchEvents).not.toHaveBeenCalled();
		expect(configSetSpy).not.toHaveBeenCalled();
		expect(Object.prototype.hasOwnProperty.call(service, "getAllEvents")).toBe(false);
		expect(service.getAllEvents()[0]?.color).toBe("#0078D4");

		controller.enable();
		refetchEvents.mockClear();
		controller.disable({ refreshViews: true });
		expect(refetchEvents).toHaveBeenCalledTimes(1);
		expect(configSetSpy).not.toHaveBeenCalled();
	});
});
