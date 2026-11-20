// @vitest-environment happy-dom

import type { App } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	layoutWeekChips,
	MONTH_CHIP_SPANNING_BODY_CLASS,
	MonthChipSpanningController,
	planWeekChipVisibility,
	resolveWeekChipLimit,
	type SpanningChipItem,
} from "../src/monthChipSpanning";
import { formatDayNumber, parseDayNumber } from "../src/tasknotesBridge";

interface MockItemRecord {
	id: string;
	startDay: number;
	endDay: number;
	allDay: boolean;
	title: string;
	display?: string;
	preview?: boolean;
	sig?: string;
}

function makeItem(
	id: string,
	startIso: string,
	endIso: string,
	options: { allDay?: boolean; title?: string; display?: string; preview?: boolean } = {},
): MockItemRecord {
	const startDay = parseDayNumber(startIso);
	const endDay = parseDayNumber(endIso);
	if (startDay === null || endDay === null) {
		throw new Error(`Invalid test date range ${startIso}..${endIso}`);
	}
	return {
		id,
		startDay,
		endDay,
		allDay: options.allDay ?? true,
		title: options.title ?? id,
		display: options.display,
		preview: options.preview,
		sig: `${id}:${String(startDay)}:${String(endDay)}`,
	};
}

function toNormalizedItem(rec: MockItemRecord): SpanningChipItem & {
	sig: string;
	item: { title: string; display?: string; preview?: boolean };
} {
	return {
		id: rec.id,
		startDay: rec.startDay,
		endDay: rec.endDay,
		allDay: rec.allDay,
		sig: rec.sig ?? rec.id,
		item: {
			title: rec.title,
			display: rec.display,
			preview: rec.preview,
		},
	};
}

class MockItemPool {
	container: HTMLElement;
	recs = new Map<string, { el: HTMLElement; sig: string }>();
	used = new Set<string>();
	createEl: (meta: Record<string, unknown>) => HTMLElement;
	destroyCount = 0;
	reuseCount = 0;

	constructor(
		container: HTMLElement,
		createEl: (meta: Record<string, unknown>) => HTMLElement,
	) {
		this.container = container;
		this.createEl = createEl;
	}

	begin(): void {
		this.used = new Set<string>();
	}

	place(key: string, meta: Record<string, unknown>): HTMLElement {
		const n = meta.n as { sig?: string; id?: string };
		const sig = `${n.sig ?? n.id ?? key}|${String(meta.variant)}|${
			meta.isStart ? "1" : "0"
		}${meta.isEnd ? "1" : "0"}|${meta.mirror ? "1" : "0"}`;
		let rec = this.recs.get(key);
		if (rec && rec.sig !== sig) {
			rec.el.remove();
			this.destroyCount += 1;
			rec = undefined;
		}
		if (!rec) {
			rec = { el: this.createEl(meta), sig };
			this.recs.set(key, rec);
			this.container.append(rec.el);
		} else {
			this.reuseCount += 1;
			if (rec.el.parentNode !== this.container) {
				this.container.append(rec.el);
			}
		}
		this.used.add(key);
		return rec.el;
	}

	end(): void {
		for (const [key, rec] of this.recs) {
			if (this.used.has(key)) {
				continue;
			}
			rec.el.remove();
			this.destroyCount += 1;
			this.recs.delete(key);
		}
	}

	clear(): void {
		this.begin();
		this.end();
	}
}

interface DayGridHarnessOptions {
	monthDisplay?: "chips" | "dots" | "full";
	compact?: boolean;
	dayMaxEvents?: boolean | number;
	availableHeightPx?: number;
	showMonthDayPanel?: boolean;
	weekItems?: MockItemRecord[][];
}

function createDayGridHarness(options: DayGridHarnessOptions = {}) {
	const parentEl = document.createElement("div");
	const basesViewEl = document.createElement("div");
	basesViewEl.className = "bases-view";
	const containerEl = document.createElement("div");
	const rootEl = document.createElement("div");
	rootEl.className = "tn-bases-integration tasknotes-plugin advanced-calendar-view";
	const calendarEl = document.createElement("div");
	calendarEl.id = "bases-calendar";
	if (options.showMonthDayPanel) {
		calendarEl.classList.add("tn-calendar-composition");
	}
	rootEl.appendChild(calendarEl);
	containerEl.appendChild(rootEl);
	basesViewEl.appendChild(containerEl);
	parentEl.appendChild(basesViewEl);
	document.body.appendChild(parentEl);

	const sun1 = parseDayNumber("2026-11-15");
	const sun2 = parseDayNumber("2026-11-22");
	if (sun1 === null || sun2 === null) {
		throw new Error("Invalid harness start dates");
	}
	const weekStarts = [sun1, sun2];

	let weekItems = options.weekItems ?? [[], []];
	let monthDisplay = options.monthDisplay ?? "chips";
	let dayMaxEvents: boolean | number = options.dayMaxEvents ?? 4;
	const boxHeight = options.availableHeightPx ?? 112; // fits 5 rows at 20px + 3px gap

	const openMoreSpy = vi.fn();
	const syncMonthChipControlsSpy = vi.fn();
	const metaMap = new WeakMap<HTMLElement, Record<string, unknown>>();
	const winObj = window;

	const ctx: Record<string, unknown> = {
		get opts() {
			return {
				monthDisplay,
				dayMaxEvents,
			};
		},
		draggingId: null,
		doc: document,
		win: {
			getComputedStyle: () =>
				({
					getPropertyValue: (name: string) => {
						if (name === "--tnc-chip-h") {
							return "20px";
						}
						if (name === "--tnc-dot-gap") {
							return "3px";
						}
						return "";
					},
				}) as unknown as CSSStyleDeclaration,
		},
		fmt: {
			longDate: (day: number) => `Date:${formatDayNumber(day) ?? String(day)}`,
		},
		text: {
			itemCount: (count: number) => `${String(count)} items`,
			more: (count: number) => `+${String(count)} more`,
		},
		order: (a: MockItemRecord, b: MockItemRecord) => a.title.localeCompare(b.title),
		openMore: openMoreSpy,
	};

	const createItemEl = (meta: Record<string, unknown>): HTMLElement => {
		const n = meta.n as { id: string; item: { title: string; preview?: boolean } };
		const el = document.createElement("div");
		el.className = `tnc-item tnc-item--${String(meta.variant)}`;
		if (!meta.isStart) {
			el.classList.add("is-cont-start");
		}
		if (!meta.isEnd) {
			el.classList.add("is-cont-end");
		}
		if (n.item.preview) {
			el.classList.add("is-mirror");
		}
		el.dataset.id = n.id;
		const titleSpan = document.createElement("span");
		titleSpan.className = "tnc-item-title";
		titleSpan.textContent = n.item.title;
		el.appendChild(titleSpan);
		metaMap.set(el, meta);
		return el;
	};

	const buildDayGrid = (startDays: number[]) => {
		const el = document.createElement("div");
		el.className = "tnc-dg";
		calendarEl.replaceChildren(el);

		const weeks = startDays.map((weekStart, weekIdx) => {
			const days = Array.from({ length: 7 }, (_, i) => weekStart + i);
			const row = document.createElement("div");
			row.className = "tnc-dg-week";
			const dates = document.createElement("div");
			dates.className = "tnc-dg-dates";

			const cells: HTMLElement[] = [];
			const dots: Array<{ box: HTMLElement; pool: MockItemPool; count: HTMLElement }> = [];

			for (const day of days) {
				const cell = document.createElement("div");
				cell.className = "tnc-dg-day";
				cell.dataset.date = formatDayNumber(day) ?? "";

				const box = document.createElement("div");
				box.className = "tnc-dg-dots";
				Object.defineProperty(box, "clientHeight", {
					configurable: true,
					get: () => boxHeight,
				});
				const count = document.createElement("span");
				count.className = "tnc-dg-dots-more";
				cell.appendChild(box);

				cells.push(cell);
				dots.push({ box, pool: new MockItemPool(box, createItemEl), count });
				dates.appendChild(cell);
			}

			const layer = document.createElement("div");
			layer.className = "tnc-dg-layer";
			const content = document.createElement("div");
			content.className = "tnc-dg-content";
			const more = document.createElement("div");
			more.className = "tnc-more-layer";
			content.appendChild(more);
			layer.appendChild(content);
			row.append(dates, layer);
			el.appendChild(row);

			return {
				weekIdx,
				days,
				row,
				cells,
				layer,
				more,
				pool: new MockItemPool(content, createItemEl),
				dots,
			};
		});

		const itemsOn = (day: number) => {
			const normalized = weekItems.flat().map(toNormalizedItem);
			return normalized.filter((item) => item.startDay <= day && item.endDay > day);
		};

		const view = {
			el,
			weeks,
			topPx: 24,
			dotsMode: monthDisplay !== "full" || Boolean(options.compact),
			ctx,
			itemsFor: (week: { weekIdx: number; days: number[] }) => {
				const list = weekItems[week.weekIdx] ?? [];
				const first = week.days[0] ?? 0;
				const last = week.days[week.days.length - 1] ?? 0;
				return list
					.map(toNormalizedItem)
					.filter((item) => item.startDay <= last && item.endDay > first);
			},
			renderDots: (week: (typeof weeks)[number]) => {
				const chips = el.classList.contains("tnc-dg--chips");
				const fits = 5;
				const cap =
					typeof dayMaxEvents === "number" && dayMaxEvents > 0
						? Math.min(dayMaxEvents, fits)
						: fits;
				week.row.style.setProperty("--tnc-levels", "0");
				week.row.style.removeProperty("--tnc-dg-need");
				week.days.forEach((day, i) => {
					const cell = week.dots[i];
					if (!cell) {
						return;
					}
					const dayItems = itemsOn(day);
					const shown =
						dayItems.length <= cap
							? dayItems.length
							: cap >= fits
								? Math.max(1, cap - (chips ? 1 : 2))
								: Math.max(1, cap);
					cell.pool.begin();
					for (const n of dayItems.slice(0, shown)) {
						cell.pool.place(n.id, {
							n,
							day,
							isStart: n.startDay >= day,
							isEnd: n.endDay <= day + 1,
							variant: "indicator",
							mirror: false,
						});
					}
					cell.pool.end();
					const rest = dayItems.length - shown;
					cell.count.textContent = rest > 0 ? `+${String(rest)}` : "";
					if (rest > 0) {
						cell.box.append(cell.count);
					} else {
						cell.count.remove();
					}
				});
			},
			render: function render(_change: unknown) {
				this.dotsMode = monthDisplay !== "full" || Boolean(options.compact);
				this.el.classList.toggle("tnc-dg--dots", this.dotsMode);
				this.el.classList.toggle(
					"tnc-dg--compact",
					this.dotsMode && monthDisplay === "full",
				);
				this.el.classList.toggle(
					"tnc-dg--chips",
					monthDisplay === "chips" && boxHeight >= 44,
				);
				for (const w of this.weeks) {
					for (const cell of w.dots) {
						cell.box.hidden = !this.dotsMode;
					}
					if (this.dotsMode) {
						w.pool.begin();
						w.pool.end();
						w.more.replaceChildren();
						this.renderDots(w);
					}
				}
			},
		};

		view.render(null);
		return view;
	};

	let currentView = buildDayGrid(weekStarts);

	class FakeCalendar {
		meta = metaMap;
		destroyed = false;
		current: ReturnType<typeof buildDayGrid> = currentView;

		get view() {
			return { type: "month" };
		}

		getOptions() {
			return { monthDisplay, dayMaxEvents };
		}

		createView() {
			currentView = buildDayGrid(weekStarts);
			return currentView;
		}

		rebuild() {
			this.current = this.createView();
			this.current.render(null);
		}
	}

	const rawCalendar = new FakeCalendar();

	const leaf = {
		view: {
			getViewType: () => "bases",
			containerEl: parentEl,
			controller: {
				view: {
					type: "tasknotesCalendar",
					containerEl,
					config: {
						get: () => undefined,
						set: vi.fn(),
					},
					viewOptions: {
						showMonthDayPanel: options.showMonthDayPanel ?? false,
					},
					calendar: rawCalendar,
					syncMonthChipControls: syncMonthChipControlsSpy,
				},
			},
		},
	};

	const app = {
		workspace: {
			getLeavesOfType: (viewType: string) => (viewType === "bases" ? [leaf] : []),
			on: () => ({ id: "ref" }),
			offref: () => {},
			onLayoutReady: (cb: () => void) => {
				cb();
			},
		},
	} as unknown as App;

	return {
		app,
		winObj,
		calendarEl,
		rawCalendar,
		getCurrentView: () => rawCalendar.current,
		openMoreSpy,
		syncMonthChipControlsSpy,
		setMonthDisplay: (next: "chips" | "dots" | "full") => {
			monthDisplay = next;
		},
		setDayMaxEvents: (next: boolean | number) => {
			dayMaxEvents = next;
		},
		setWeekItems: (next: MockItemRecord[][]) => {
			weekItems = next;
		},
	};
}

describe("monthChipSpanning layout & visibility helpers", () => {
	it("packs multi-day spans above shorter items, packs single-day items around them, and handles week boundaries & hidden days", () => {
		const days = [10, 11, 12, 13, 14, 15, 16];
		const weekItems: SpanningChipItem[] = [
			{ id: "short-mon", startDay: 11, endDay: 12, allDay: true, item: {} },
			{ id: "span-prev-tue", startDay: 8, endDay: 13, allDay: true, item: {} },
			{ id: "span-wed-next", startDay: 13, endDay: 20, allDay: true, item: {} },
			{ id: "tue-timed", startDay: 12, endDay: 13, allDay: false, item: {} },
			{ id: "bg", startDay: 10, endDay: 15, allDay: true, item: { display: "background" } },
			{ id: "none", startDay: 10, endDay: 15, allDay: true, item: { display: "none" } },
		];

		const layout = layoutWeekChips(weekItems, days);
		expect(layout.placements).toHaveLength(4);

		// Column 0 starts with span-prev-tue (col 0..3)
		expect(layout.placements[0]).toMatchObject({
			item: { id: "span-prev-tue" },
			startCol: 0,
			endCol: 3,
			level: 0,
			isStart: false,
			isEnd: true,
		});
		// Column 1 has short-mon at level 1 because level 0 is occupied by span-prev-tue
		expect(layout.placements[1]).toMatchObject({
			item: { id: "short-mon" },
			startCol: 1,
			endCol: 2,
			level: 1,
			isStart: true,
			isEnd: true,
		});
		// Column 2 has tue-timed at level 1
		expect(layout.placements[2]).toMatchObject({
			item: { id: "tue-timed" },
			startCol: 2,
			endCol: 3,
			level: 1,
			isStart: true,
			isEnd: true,
		});
		// Column 3 reuses level 0 for span-wed-next cleanly without collision
		expect(layout.placements[3]).toMatchObject({
			item: { id: "span-wed-next" },
			startCol: 3,
			endCol: 7,
			level: 0,
			isStart: true,
			isEnd: false,
		});
		expect(layout.countByCol).toEqual([1, 2, 2, 1, 1, 1, 1]);

		// 5-day work week (weekends: false skips days 10 and 16)
		const weekdayLayout = layoutWeekChips(
			[{ id: "weekend-bridge", startDay: 10, endDay: 17, allDay: true, item: {} }],
			[11, 12, 13, 14, 15],
		);
		expect(weekdayLayout.placements[0]).toMatchObject({
			startCol: 0,
			endCol: 5,
			isStart: false,
			isEnd: false,
		});
	});

	it("handles 4-event limit cleanly at fits=5 (4 direct + '+1') and fits=4 (3 direct + '+2'), plus cascading multi-day overflow", () => {
		const days = [100, 101, 102, 103, 104, 105, 106];

		// Case 1: fits = 5 (avail 112px at 23px/row), dayMaxEvents = 4
		const limitFits5 = resolveWeekChipLimit(4, 112, 20, 3);
		expect(limitFits5).toEqual({ fit: 4, withMore: 4, fits: 5 });

		// Day 0 has 5 events -> 4 direct + '+1' at row 4
		const fiveEvents: SpanningChipItem[] = Array.from({ length: 5 }, (_, idx) => ({
			id: `e-${String(idx)}`,
			startDay: 100,
			endDay: 101,
			allDay: true,
			item: {},
		}));
		const plan5 = planWeekChipVisibility(layoutWeekChips(fiveEvents, days), limitFits5);
		expect(plan5.visible).toHaveLength(4);
		expect(plan5.hiddenByCol[0]).toHaveLength(1);
		expect(plan5.moreRowByCol[0]).toBe(4);

		// Case 2: fits = 4 (avail 89px at 23px/row), dayMaxEvents = 4
		const limitFits4 = resolveWeekChipLimit(4, 89, 20, 3);
		expect(limitFits4).toEqual({ fit: 4, withMore: 3, fits: 4 });

		const plan4At5 = planWeekChipVisibility(layoutWeekChips(fiveEvents, days), limitFits4);
		expect(plan4At5.visible).toHaveLength(3);
		expect(plan4At5.hiddenByCol[0]).toHaveLength(2);
		expect(plan4At5.moreRowByCol[0]).toBe(3);

		// Exactly 4 events still fit directly at fits=4
		const fourEvents = fiveEvents.slice(0, 4);
		const plan4At4 = planWeekChipVisibility(layoutWeekChips(fourEvents, days), limitFits4);
		expect(plan4At4.visible).toHaveLength(4);
		expect(plan4At4.hiddenByCol[0]).toHaveLength(0);

		// Case 3: Cascading multi-day overflow across columns
		// Col 0..1 have 4 spanning items at levels 0..3; col 1..2 have 1 spanning item pushed to level 4 ->
		// With fits=5, level 4 item overflows on BOTH col 1 and col 2 (even though col 2 has only 1 event),
		// so both col 1 and col 2 get "+1" instead of stranding the hidden multi-day event.
		const cascadeItems: SpanningChipItem[] = [
			{ id: "c0-1", startDay: 100, endDay: 102, allDay: true, item: {} },
			{ id: "c0-2", startDay: 100, endDay: 102, allDay: true, item: {} },
			{ id: "c0-3", startDay: 100, endDay: 102, allDay: true, item: {} },
			{ id: "c0-4", startDay: 100, endDay: 102, allDay: true, item: {} },
			{ id: "span-1-2", startDay: 101, endDay: 103, allDay: true, item: {} },
		];
		const cascadeLayout = layoutWeekChips(cascadeItems, days);
		const cascadePlan = planWeekChipVisibility(cascadeLayout, limitFits5);
		expect(cascadePlan.visible).toHaveLength(4);
		expect(cascadePlan.hiddenByCol[0]).toHaveLength(0);
		expect(cascadePlan.hiddenByCol[1]?.map((i) => i.id)).toEqual(["span-1-2"]);
		expect(cascadePlan.hiddenByCol[2]?.map((i) => i.id)).toEqual(["span-1-2"]);
		expect(cascadePlan.moreRowByCol[1]).toBe(4);
		expect(cascadePlan.moreRowByCol[2]).toBe(0);

		// Unlimited mode (dayMaxEvents: false) renders everything
		expect(resolveWeekChipLimit(false, 89, 20, 3)).toBeNull();
		const unlimitedPlan = planWeekChipVisibility(cascadeLayout, null);
		expect(unlimitedPlan.visible).toHaveLength(5);
		expect(unlimitedPlan.maxLevel).toBe(4);
	});
});

describe("MonthChipSpanningController", () => {
	let controller: MonthChipSpanningController | null = null;

	beforeEach(() => {
		document.body.replaceChildren();
		document.body.className = "";
	});

	afterEach(() => {
		controller?.disable();
		controller = null;
		vi.restoreAllMocks();
	});

	it("renders spanning chips in week layers, preserves ItemPool reuse and box visibility, and restores cleanly on disable", () => {
		const multiWeek = [
			makeItem("trip", "2026-11-16", "2026-11-24", { title: "Week-crossing trip" }),
			makeItem("mon-1", "2026-11-16", "2026-11-17", { title: "Mon 1" }),
			makeItem("mon-2", "2026-11-16", "2026-11-17", { title: "Mon 2" }),
			makeItem("mon-3", "2026-11-16", "2026-11-17", { title: "Mon 3" }),
			makeItem("mon-4", "2026-11-16", "2026-11-17", { title: "Mon 4" }),
			makeItem("tue-timed", "2026-11-17", "2026-11-18", { allDay: false, title: "Timed Tue" }),
		];

		const harness = createDayGridHarness({
			monthDisplay: "chips",
			dayMaxEvents: 4,
			weekItems: [multiWeek, multiWeek],
		});
		controller = new MonthChipSpanningController(harness.app);
		controller.enable();

		expect(document.body.classList.contains(MONTH_CHIP_SPANNING_BODY_CLASS)).toBe(true);

		const view = harness.getCurrentView();
		const week0 = view.weeks[0];
		const week1 = view.weeks[1];
		if (!week0 || !week1) {
			throw new Error("Expected 2 week rows");
		}

		// Dots boxes must stay mounted and NOT hidden so @tasknotes/calendar keeps .tnc-dg--chips active!
		expect(week0.dots[1]?.box.hidden).toBe(false);
		expect(week0.dots[1]?.box.querySelectorAll(".tnc-item")).toHaveLength(0);

		// Week 0: "trip" spans Mon (col 1) through Sat (col 7), cont-end across Sunday boundary
		const week0Trip = week0.layer.querySelector<HTMLElement>('.tnc-item[data-id="trip"]');
		expect(week0Trip).not.toBeNull();
		expect(week0Trip?.classList.contains("tnc-item--indicator")).toBe(true);
		expect(week0Trip?.classList.contains("is-cont-end")).toBe(true);
		expect(week0Trip?.classList.contains("is-cont-start")).toBe(false);
		expect(week0Trip?.dataset.tnceSpanCols).toBe("6");
		expect(week0Trip?.dataset.tnceStartDate).toBe("2026-11-16");
		expect(week0Trip?.style.left).toBe("calc(14.29% + 2px)");
		expect(week0Trip?.style.width).toBe("calc(85.71% - 4px)");

		// Week 1: "trip" continues Sunday (col 0) through Mon (col 2, end Nov 24 exclusive -> ends Nov 23)
		const week1Trip = week1.layer.querySelector<HTMLElement>('.tnc-item[data-id="trip"]');
		expect(week1Trip).not.toBeNull();
		expect(week1Trip?.classList.contains("is-cont-start")).toBe(true);
		expect(week1Trip?.classList.contains("is-cont-end")).toBe(false);
		expect(week1Trip?.dataset.tnceSpanCols).toBe("2");
		expect(week1Trip?.dataset.tnceStartDate).toBe("2026-11-22");

		// Covered cells carry data-tnce-has-events="true" even in middle columns
		expect(week0.cells[1]?.dataset.tnceHasEvents).toBe("true");
		expect(week0.cells[4]?.dataset.tnceHasEvents).toBe("true");
		expect(week0.cells[0]?.dataset.tnceHasEvents).toBeUndefined();

		// Monday (col 1) has 5 events ("trip" + mon-1..4) -> 4 direct + "+1" button in week0.more
		const moreBtn = week0.more.querySelector<HTMLButtonElement>(
			'button.tnc-more.tnce-chip-more[data-day]',
		);
		expect(moreBtn).not.toBeNull();
		expect(moreBtn?.textContent).toBe("+1");
		expect(moreBtn?.getAttribute("aria-label")).toBe("+1 more");
		expect(moreBtn?.style.top).toBe("calc(var(--tnc-dg-top-h) + 4 * (var(--tnc-chip-h, 20px) + var(--tnc-dot-gap, 3px)))");

		const clickEv = new MouseEvent("click", { bubbles: true, cancelable: true });
		moreBtn?.dispatchEvent(clickEv);
		expect(harness.openMoreSpy).toHaveBeenCalledWith(
			parseDayNumber("2026-11-16"),
			moreBtn,
			clickEv,
		);

		// Re-rendering without changing "trip" reuses its DOM element in ItemPool instead of recreating it
		view.render(null);
		const reusedWeek0Trip = week0.layer.querySelector<HTMLElement>('.tnc-item[data-id="trip"]');
		expect(reusedWeek0Trip).toBe(week0Trip);
		expect(week0.pool.reuseCount).toBeGreaterThan(0);

		// Rebuilds via calendar.createView (e.g. navigating months) stay patched automatically
		harness.rawCalendar.rebuild();
		const rebuiltView = harness.getCurrentView();
		expect(
			rebuiltView.weeks[0]?.layer.querySelector<HTMLElement>('.tnc-item[data-id="trip"]')
				?.dataset.tnceSpanCols,
		).toBe("6");

		// Disabling restores stock day-by-day dots/chips cleanly and removes body class + attributes
		controller.disable();
		expect(document.body.classList.contains(MONTH_CHIP_SPANNING_BODY_CLASS)).toBe(false);
		expect(rebuiltView.weeks[0]?.layer.querySelector(".tnc-item")).toBeNull();
		expect(rebuiltView.weeks[0]?.more.querySelector(".tnce-chip-more")).toBeNull();
		expect(rebuiltView.weeks[0]?.cells[1]?.dataset.tnceHasEvents).toBeUndefined();
		expect(
			rebuiltView.weeks[0]?.dots[1]?.box.querySelectorAll(".tnc-item--indicator").length,
		).toBeGreaterThan(0);
		expect(harness.syncMonthChipControlsSpy).toHaveBeenCalled();
	});

	it("leaves non-chips views untouched and skips opening +more popover inside day-panel composition", () => {
		const multiWeek = [
			makeItem("a", "2026-11-16", "2026-11-18", { title: "A" }),
			makeItem("b", "2026-11-16", "2026-11-17", { title: "B" }),
			makeItem("c", "2026-11-16", "2026-11-17", { title: "C" }),
			makeItem("d", "2026-11-16", "2026-11-17", { title: "D" }),
			makeItem("e", "2026-11-16", "2026-11-17", { title: "E" }),
		];

		const dotsHarness = createDayGridHarness({
			monthDisplay: "dots",
			weekItems: [multiWeek, []],
		});
		controller = new MonthChipSpanningController(dotsHarness.app);
		controller.enable();

		const dotsView = dotsHarness.getCurrentView();
		expect(dotsView.weeks[0]?.layer.querySelector(".tnc-item")).toBeNull();
		expect(dotsView.weeks[0]?.cells[1]?.dataset.tnceHasEvents).toBeUndefined();
		controller.disable();
		document.body.replaceChildren();

		const compositionHarness = createDayGridHarness({
			monthDisplay: "chips",
			showMonthDayPanel: true,
			dayMaxEvents: 4,
			weekItems: [multiWeek, []],
		});
		controller = new MonthChipSpanningController(compositionHarness.app);
		controller.enable();
		const compView = compositionHarness.getCurrentView();
		const compMore = compView.weeks[0]?.more.querySelector<HTMLButtonElement>(".tnce-chip-more");
		compMore?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(compositionHarness.openMoreSpy).not.toHaveBeenCalled();
	});

	it("degrades gracefully by falling back to stock chip rendering when spanning render fails", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const harness = createDayGridHarness({
			monthDisplay: "chips",
			weekItems: [[makeItem("x", "2026-11-16", "2026-11-18", { title: "X" })], []],
		});
		const view = harness.getCurrentView();
		const origItemsFor = view.itemsFor.bind(view);
		let shouldThrow = true;
		view.itemsFor = (week) => {
			if (shouldThrow) {
				throw new Error("Simulated itemsFor failure");
			}
			return origItemsFor(week);
		};

		controller = new MonthChipSpanningController(harness.app);
		controller.enable();

		expect(warnSpy).toHaveBeenCalled();
		expect(view.weeks[0]?.dots[1]?.box.querySelector(".tnc-item--indicator")).not.toBeNull();

		shouldThrow = false;
	});
});
