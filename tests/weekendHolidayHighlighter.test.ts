// @vitest-environment happy-dom

import type { App } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCalendarColorKey } from "../src/calendarColorOverrides";
import {
	collectExternalHolidayDateMap,
	DAY_KIND_ATTR,
	HOLIDAY_LABEL_CLASS,
	HOLIDAY_TOOLTIP_ATTR,
	sanitizeHolidayCalendarKeys,
	WEEKEND_HOLIDAY_BODY_CLASS,
	WeekendHolidayHighlighter,
	type WeekendHolidayOptions,
} from "../src/weekendHolidayHighlighter";

function createBasesHarness(options?: {
	googleCalendars?: Array<Record<string, unknown>>;
	googleEvents?: Array<Record<string, unknown>>;
	microsoftCalendars?: Array<Record<string, unknown>>;
	microsoftEvents?: Array<Record<string, unknown>>;
	icsSubscriptions?: Array<Record<string, unknown>>;
	icsEvents?: Array<Record<string, unknown>>;
}) {
	const rootEl = document.createElement("div");
	rootEl.className = "tn-bases-integration tasknotes-plugin advanced-calendar-view";
	const calendarEl = document.createElement("div");
	calendarEl.id = "bases-calendar";
	rootEl.appendChild(calendarEl);
	document.body.appendChild(rootEl);

	const workspaceListeners = new Map<string, Set<() => void>>();
	const providerListeners = new Set<() => void>();
	const configSetSpy = vi.fn();

	const createService = (base: Record<string, unknown>) => ({
		...base,
		on: (_event: string, cb: () => void) => {
			providerListeners.add(cb);
			return () => {
				providerListeners.delete(cb);
			};
		},
	});

	const googleService = createService({
		getAvailableCalendars: () => options?.googleCalendars ?? [],
		getAllEvents: () => options?.googleEvents ?? [],
	});
	const microsoftService = createService({
		getAvailableCalendars: () => options?.microsoftCalendars ?? [],
		getAllEvents: () => options?.microsoftEvents ?? [],
	});
	const icsService = createService({
		getSubscriptions: () => options?.icsSubscriptions ?? [],
		getAllEvents: () => options?.icsEvents ?? [],
	});

	const leaf = {
		view: {
			getViewType: () => "bases",
			containerEl: rootEl,
			controller: {
				view: {
					type: "tasknotesCalendar",
					containerEl: rootEl,
					config: {
						get: () => undefined,
						set: configSetSpy,
					},
				},
			},
		},
	};

	const app = {
		plugins: {
			plugins: {
				tasknotes: {
					googleCalendarService: googleService,
					hostedGoogleCalendarService: googleService,
					microsoftCalendarService: microsoftService,
					icsSubscriptionService: icsService,
				},
			},
		},
		workspace: {
			getLeavesOfType: (viewType: string) => (viewType === "bases" ? [leaf] : []),
			on: (name: string, cb: () => void) => {
				let set = workspaceListeners.get(name);
				if (!set) {
					set = new Set();
					workspaceListeners.set(name, set);
				}
				set.add(cb);
				return { name, cb };
			},
			offref: (ref: { name: string; cb: () => void }) => {
				workspaceListeners.get(ref.name)?.delete(ref.cb);
			},
			onLayoutReady: (cb: () => void) => {
				cb();
			},
		},
	} as unknown as App;

	return {
		app,
		rootEl,
		calendarEl,
		configSetSpy,
		emitProviderDataChanged: () => {
			for (const cb of providerListeners) {
				cb();
			}
		},
	};
}

function appendMonthGrid(
	calendarEl: HTMLElement,
	headers: string[],
	rows: string[][],
): { headEls: HTMLElement[]; cellEls: HTMLElement[] } {
	const gridEl = document.createElement("div");
	gridEl.className = "tnc-dg-grid";

	const headRow = document.createElement("div");
	headRow.className = "tnc-dg-head";
	const headEls = headers.map((label) => {
		const dow = document.createElement("div");
		dow.className = "tnc-dg-dow";
		dow.textContent = label;
		headRow.appendChild(dow);
		return dow;
	});
	gridEl.appendChild(headRow);

	const cellEls: HTMLElement[] = [];
	for (const rowDates of rows) {
		const rowEl = document.createElement("div");
		rowEl.className = "tnc-dg-row";
		for (const dateStr of rowDates) {
			const cell = document.createElement("div");
			cell.className = "tnc-dg-day";
			cell.setAttribute("data-date", dateStr);
			cell.setAttribute("aria-label", `Full ${dateStr}`);
			const top = document.createElement("div");
			top.className = "tnc-dg-top";
			const num = document.createElement("span");
			num.className = "tnc-dg-num";
			num.textContent = dateStr.slice(8).replace(/^0/, "");
			top.appendChild(num);
			cell.appendChild(top);
			rowEl.appendChild(cell);
			cellEls.push(cell);
		}
		gridEl.appendChild(rowEl);
	}

	calendarEl.appendChild(gridEl);
	return { headEls, cellEls };
}

describe("weekendHolidayHighlighter", () => {
	let highlighter: WeekendHolidayHighlighter | null = null;

	beforeEach(() => {
		document.body.replaceChildren();
		document.body.className = "";
	});

	afterEach(() => {
		highlighter?.disable();
		highlighter = null;
		vi.restoreAllMocks();
	});

	it("sanitizes holiday calendar keys, removing duplicates and invalid formats", () => {
		const keyA = buildCalendarColorKey("google", "holidays@example.com");
		expect(
			sanitizeHolidayCalendarKeys([keyA, keyA, "google:raw-email", 42, null]),
		).toEqual([keyA]);
	});

	it("marks month, week/day, year, list, and strip elements while keeping Saturday holidays red and preserving outer aria-labels", () => {
		const { app, calendarEl } = createBasesHarness();
		const { headEls, cellEls } = appendMonthGrid(
			calendarEl,
			["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
			[
				// Week around Constitution Memorial Day on Saturday 2025-05-03
				[
					"2025-04-28",
					"2025-04-29",
					"2025-04-30",
					"2025-05-01",
					"2025-05-02",
					"2025-05-03",
					"2025-05-04",
				],
				[
					"2025-05-05",
					"2025-05-06",
					"2025-05-07",
					"2025-05-08",
					"2025-05-09",
					"2025-05-10",
					"2025-05-11",
				],
			],
		);

		// Year view sub-grid with Monday firstDay and 5 pad cells for Nov 2026 (2026-11-01 is Sunday at col 6)
		const ymDays = document.createElement("div");
		ymDays.className = "tnc-ym-days";
		const ymHeaders = ["M", "T", "W", "T", "F", "S", "S"].map((ch) => {
			const h = document.createElement("div");
			h.className = "tnc-ym-dow";
			h.textContent = ch;
			ymDays.appendChild(h);
			return h;
		});
		for (let i = 0; i < 6; i += 1) {
			const pad = document.createElement("div");
			pad.className = "tnc-ym-pad";
			ymDays.appendChild(pad);
		}
		const ymNov01 = document.createElement("button");
		ymNov01.className = "tnc-ym-day";
		ymNov01.setAttribute("data-date", "2026-11-01");
		const ymNov01Num = document.createElement("span");
		ymNov01Num.className = "tnc-ym-num";
		ymNov01Num.textContent = "1";
		ymNov01.appendChild(ymNov01Num);
		const ymNov23 = document.createElement("button");
		ymNov23.className = "tnc-ym-day";
		ymNov23.setAttribute("data-date", "2026-11-23");
		const ymNov23Num = document.createElement("span");
		ymNov23Num.className = "tnc-ym-num";
		ymNov23Num.textContent = "23";
		ymNov23.appendChild(ymNov23Num);
		ymDays.append(ymNov01, ymNov23);
		calendarEl.appendChild(ymDays);

		// Week/day header (.tnc-dh), strip day (.tnc-strip-day), and list day (.tnc-list-day)
		const dhSat = document.createElement("div");
		dhSat.className = "tnc-dh";
		dhSat.setAttribute("data-date", "2026-11-21");
		dhSat.setAttribute("aria-label", "Saturday, November 21, 2026");
		const dhLabel = document.createElement("span");
		dhLabel.className = "tnc-dh-label";
		dhSat.appendChild(dhLabel);

		const stripHoliday = document.createElement("button");
		stripHoliday.className = "tnc-strip-day";
		stripHoliday.setAttribute("data-date", "2026-11-23");
		const stripNum = document.createElement("span");
		stripNum.className = "tnc-strip-num";
		stripNum.textContent = "23";
		stripHoliday.appendChild(stripNum);

		const listHoliday = document.createElement("div");
		listHoliday.className = "tnc-list-day";
		listHoliday.setAttribute("data-date", "2026-11-03");
		listHoliday.textContent = "Tuesday, November 3, 2026";

		calendarEl.append(dhSat, stripHoliday, listHoliday);

		const opts: WeekendHolidayOptions = {
			enableJapaneseHolidays: true,
			holidayCalendarKeys: [],
		};
		highlighter = new WeekendHolidayHighlighter(app, () => opts);
		highlighter.enable();

		expect(document.body.classList.contains(WEEKEND_HOLIDAY_BODY_CLASS)).toBe(true);

		// Monday-first month headers: Sat at index 5, Sun at index 6
		expect(headEls[0]?.hasAttribute(DAY_KIND_ATTR)).toBe(false);
		expect(headEls[5]?.getAttribute(DAY_KIND_ATTR)).toBe("saturday");
		expect(headEls[6]?.getAttribute(DAY_KIND_ATTR)).toBe("sunday");

		// 2025-04-29 (Tue) = Showa Day, 2025-05-03 (Sat) = Constitution Memorial Day ("holiday" wins over "saturday")
		const showaNum = cellEls[1]?.querySelector<HTMLElement>(".tnc-dg-num");
		const showaLabel = cellEls[1]?.querySelector<HTMLElement>(`.${HOLIDAY_LABEL_CLASS}`);
		expect(cellEls[1]?.getAttribute(DAY_KIND_ATTR)).toBe("holiday");
		expect(cellEls[1]?.getAttribute("aria-label")).toBe("Full 2025-04-29");
		expect(showaNum?.getAttribute(HOLIDAY_TOOLTIP_ATTR)).toBe("昭和の日");
		expect(showaLabel?.textContent).toBe("昭和の日");
		expect(showaLabel?.classList.contains(`${HOLIDAY_LABEL_CLASS}--month`)).toBe(true);
		expect(showaLabel?.nextElementSibling).toBe(showaNum);

		expect(cellEls[5]?.getAttribute(DAY_KIND_ATTR)).toBe("holiday");
		expect(
			cellEls[5]?.querySelector(".tnc-dg-num")?.getAttribute(HOLIDAY_TOOLTIP_ATTR),
		).toBe("憲法記念日");
		expect(cellEls[5]?.querySelector(`.${HOLIDAY_LABEL_CLASS}`)?.textContent).toBe("憲法記念日");

		expect(cellEls[6]?.getAttribute(DAY_KIND_ATTR)).toBe("holiday");
		expect(
			cellEls[6]?.querySelector(".tnc-dg-num")?.getAttribute(HOLIDAY_TOOLTIP_ATTR),
		).toBe("みどりの日");
		expect(cellEls[0]?.hasAttribute(DAY_KIND_ATTR)).toBe(false);
		expect(cellEls[0]?.querySelector(`.${HOLIDAY_LABEL_CLASS}`)).toBeNull();
		expect(cellEls[8]?.getAttribute(DAY_KIND_ATTR)).toBe("holiday");
		expect(
			cellEls[8]?.querySelector(".tnc-dg-num")?.getAttribute(HOLIDAY_TOOLTIP_ATTR),
		).toBe("振替休日");
		expect(cellEls[8]?.querySelector(`.${HOLIDAY_LABEL_CLASS}`)?.textContent).toBe("振替休日");
		expect(cellEls[12]?.getAttribute(DAY_KIND_ATTR)).toBe("saturday");
		expect(cellEls[13]?.getAttribute(DAY_KIND_ATTR)).toBe("sunday");

		// Year headers: Saturday index 5, Sunday index 6; Nov 1 is Sunday, Nov 23 is Labor Thanksgiving Day
		expect(ymHeaders[5]?.getAttribute(DAY_KIND_ATTR)).toBe("saturday");
		expect(ymHeaders[6]?.getAttribute(DAY_KIND_ATTR)).toBe("sunday");
		expect(ymNov01.getAttribute(DAY_KIND_ATTR)).toBe("sunday");
		expect(ymNov23.getAttribute(DAY_KIND_ATTR)).toBe("holiday");
		expect(ymNov23Num.getAttribute(HOLIDAY_TOOLTIP_ATTR)).toBe("勤労感謝の日");

		expect(dhSat.getAttribute(DAY_KIND_ATTR)).toBe("saturday");
		expect(dhSat.getAttribute("aria-label")).toBe("Saturday, November 21, 2026");
		expect(stripHoliday.getAttribute(DAY_KIND_ATTR)).toBe("holiday");
		expect(stripNum.getAttribute(HOLIDAY_TOOLTIP_ATTR)).toBe("勤労感謝の日");
		expect(listHoliday.getAttribute(DAY_KIND_ATTR)).toBe("holiday");
		expect(listHoliday.getAttribute(HOLIDAY_TOOLTIP_ATTR)).toBe("文化の日");
		expect(
			listHoliday.querySelector(`.${HOLIDAY_LABEL_CLASS}--list`)?.textContent,
		).toBe("文化の日");

		// Week/day header (.tnc-dh) on holiday also renders inline label cleanly
		const dhHoliday = document.createElement("div");
		dhHoliday.className = "tnc-dh";
		dhHoliday.setAttribute("data-date", "2026-11-23");
		const dhHolidayLabelWrap = document.createElement("span");
		dhHolidayLabelWrap.className = "tnc-dh-label";
		dhHoliday.appendChild(dhHolidayLabelWrap);
		calendarEl.appendChild(dhHoliday);
		highlighter.refresh();
		expect(
			dhHoliday.querySelector(`.${HOLIDAY_LABEL_CLASS}--dh`)?.textContent,
		).toBe("勤労感謝の日");
	});

	it("collects external Google (with primary alias), Microsoft, and ICS holiday events without extra fetches", async () => {
		const googlePrimaryId = "user@gmail.com";
		const holidayIcsKey = buildCalendarColorKey("ics", "us-holidays");
		const googleHolidayKey = buildCalendarColorKey("google", googlePrimaryId);
		const msHolidayKey = buildCalendarColorKey("microsoft", "ms-holidays");

		const { app, calendarEl, emitProviderDataChanged } = createBasesHarness({
			googleCalendars: [{ id: googlePrimaryId, summary: "Main", primary: true }],
			googleEvents: [
				{
					id: "g-1",
					subscriptionId: "google-primary",
					title: "Company Retreat",
					start: "2026-11-24",
					end: "2026-11-26",
					allDay: true,
				},
			],
			microsoftCalendars: [{ id: "ms-holidays", summary: "UK Holidays" }],
			microsoftEvents: [
				{
					id: "m-1",
					subscriptionId: "microsoft-ms-holidays",
					title: "Bank Holiday",
					start: "2026-11-27T09:00:00",
					end: "2026-11-27T17:00:00",
					allDay: false,
				},
			],
			icsSubscriptions: [{ id: "us-holidays", name: "US Holidays", enabled: true }],
			icsEvents: [
				{
					id: "i-1",
					subscriptionId: "us-holidays",
					title: "Thanksgiving",
					start: "2026-11-26",
					end: "2026-11-27",
					allDay: true,
				},
				{
					id: "i-other",
					subscriptionId: "other-ics",
					title: "Regular Dentist",
					start: "2026-11-18",
					end: "2026-11-19",
					allDay: true,
				},
			],
		});

		const dateMap = collectExternalHolidayDateMap(app, [
			googleHolidayKey,
			msHolidayKey,
			holidayIcsKey,
		]);
		expect(dateMap.get("2026-11-24")).toBe("Company Retreat");
		expect(dateMap.get("2026-11-25")).toBe("Company Retreat");
		// Exclusive all-day end (2026-11-26) does not bleed into 26th from Company Retreat
		expect(dateMap.get("2026-11-26")).toBe("Thanksgiving");
		expect(dateMap.get("2026-11-27")).toBe("Bank Holiday");
		expect(dateMap.has("2026-11-18")).toBe(false);

		const { cellEls } = appendMonthGrid(
			calendarEl,
			["Mon", "Tue", "Wed", "Thu", "Fri"],
			[["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27"]],
		);

		let jpEnabled = false;
		let selectedKeys: string[] = [googleHolidayKey, msHolidayKey];

		highlighter = new WeekendHolidayHighlighter(app, () => ({
			enableJapaneseHolidays: jpEnabled,
			holidayCalendarKeys: selectedKeys,
		}));
		highlighter.enable();

		// Japanese holidays disabled, Nov 23 is normal weekday, Nov 24 & 25 are Company Retreat, Nov 27 is Bank Holiday
		expect(cellEls[0]?.hasAttribute(DAY_KIND_ATTR)).toBe(false);
		expect(cellEls[1]?.getAttribute(DAY_KIND_ATTR)).toBe("holiday");
		expect(cellEls[1]?.querySelector(".tnc-dg-num")?.getAttribute(HOLIDAY_TOOLTIP_ATTR)).toBe(
			"Company Retreat",
		);
		expect(cellEls[4]?.getAttribute(DAY_KIND_ATTR)).toBe("holiday");

		// Turn on Japanese holidays & refresh
		jpEnabled = true;
		highlighter.refresh();
		expect(cellEls[0]?.getAttribute(DAY_KIND_ATTR)).toBe("holiday");
		expect(cellEls[0]?.querySelector(".tnc-dg-num")?.getAttribute(HOLIDAY_TOOLTIP_ATTR)).toBe(
			"勤労感謝の日",
		);

		// Deselect external calendars & emit data-changed -> clears external holidays while preserving JP holiday
		selectedKeys = [];
		emitProviderDataChanged();
		await new Promise((resolve) => setTimeout(resolve, 15));
		expect(cellEls[1]?.hasAttribute(DAY_KIND_ATTR)).toBe(false);
		expect(
			cellEls[1]?.querySelector(".tnc-dg-num")?.hasAttribute(HOLIDAY_TOOLTIP_ATTR),
		).toBe(false);
		expect(cellEls[1]?.querySelector(`.${HOLIDAY_LABEL_CLASS}`)).toBeNull();
		expect(cellEls[0]?.getAttribute(DAY_KIND_ATTR)).toBe("holiday");
	});

	it("renders untrusted holiday titles safely without HTML injection and converges without observer loops", async () => {
		const holidayIcsKey = buildCalendarColorKey("ics", "custom-ics");
		const xssTitle = "<img src=x onerror=alert(1)>";
		const { app, calendarEl } = createBasesHarness({
			icsSubscriptions: [{ id: "custom-ics", name: "Custom", enabled: true }],
			icsEvents: [
				{
					id: "xss-1",
					subscriptionId: "custom-ics",
					title: xssTitle,
					start: "2026-11-18",
					end: "2026-11-19",
					allDay: true,
				},
			],
		});
		const { cellEls } = appendMonthGrid(
			calendarEl,
			["Wed"],
			[["2026-11-18"]],
		);

		highlighter = new WeekendHolidayHighlighter(app, () => ({
			enableJapaneseHolidays: false,
			holidayCalendarKeys: [holidayIcsKey],
		}));
		const syncSpy = vi.spyOn(highlighter, "syncAllViews");
		highlighter.enable();

		expect(syncSpy.mock.calls.length).toBeLessThanOrEqual(2);
		syncSpy.mockClear();
		await new Promise((resolve) => setTimeout(resolve, 30));

		expect(syncSpy).not.toHaveBeenCalled();
		expect(calendarEl.querySelector("img")).toBeNull();
		expect(cellEls[0]?.querySelector(`.${HOLIDAY_LABEL_CLASS}`)?.textContent).toBe(xssTitle);
	});

	it("matches direct ICS subscriptionId as used by TaskNotes ICSSubscriptionService", () => {
		const holidayIcsKey = buildCalendarColorKey("ics", "ics_jp_official");
		const { app } = createBasesHarness({
			icsSubscriptions: [{ id: "ics_jp_official", name: "JP", enabled: true }],
			icsEvents: [
				{
					id: "sub-ev-1",
					subscriptionId: "ics_jp_official",
					title: "Culture Day",
					start: "2026-11-03",
					end: "2026-11-04",
					allDay: true,
				},
			],
		});

		const dateMap = collectExternalHolidayDateMap(app, [holidayIcsKey]);
		expect(dateMap.get("2026-11-03")).toBe("Culture Day");
		expect(dateMap.has("2026-11-04")).toBe(false);
	});

	it("removes all body classes, attributes, and tooltips on disable() without touching Bases config.set", () => {
		const { app, calendarEl, configSetSpy } = createBasesHarness();
		const { headEls, cellEls } = appendMonthGrid(
			calendarEl,
			["Sat", "Sun", "Mon"],
			[["2026-11-21", "2026-11-22", "2026-11-23"]],
		);

		highlighter = new WeekendHolidayHighlighter(app, () => ({
			enableJapaneseHolidays: true,
			holidayCalendarKeys: [],
		}));
		highlighter.enable();

		expect(document.body.classList.contains(WEEKEND_HOLIDAY_BODY_CLASS)).toBe(true);
		expect(headEls[0]?.getAttribute(DAY_KIND_ATTR)).toBe("saturday");
		expect(cellEls[2]?.querySelector(".tnc-dg-num")?.getAttribute(HOLIDAY_TOOLTIP_ATTR)).toBe(
			"勤労感謝の日",
		);
		expect(cellEls[2]?.querySelector(`.${HOLIDAY_LABEL_CLASS}`)?.textContent).toBe("勤労感謝の日");

		highlighter.disable();

		expect(document.body.classList.contains(WEEKEND_HOLIDAY_BODY_CLASS)).toBe(false);
		expect(calendarEl.querySelector(`[${DAY_KIND_ATTR}]`)).toBeNull();
		expect(calendarEl.querySelector(`[${HOLIDAY_TOOLTIP_ATTR}]`)).toBeNull();
		expect(calendarEl.querySelector(`.${HOLIDAY_LABEL_CLASS}`)).toBeNull();
		expect(cellEls[2]?.getAttribute("aria-label")).toBe("Full 2026-11-23");
		expect(cellEls[2]?.querySelector(".tnc-dg-num")?.hasAttribute("aria-label")).toBe(false);
		expect(configSetSpy).not.toHaveBeenCalled();
	});
});
