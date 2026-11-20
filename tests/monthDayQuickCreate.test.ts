// @vitest-environment happy-dom

import { type App, TFile } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileMonthTapController } from "../src/mobileMonthTap";
import {
	LONG_PRESS_DELAY_MS,
	MONTH_QUICK_CREATE_BODY_CLASS,
	MonthDayQuickCreateController,
	POST_LONG_PRESS_SUPPRESS_MS,
} from "../src/monthDayQuickCreate";
import { formatLocalDateString, parseDayNumber } from "../src/tasknotesBridge";

interface QuickCreateHarnessOptions {
	gridMode?: "full" | "chips" | "dots" | "compact";
	showMonthDayPanel?: boolean;
	selectionModeActive?: boolean;
	draggingActive?: boolean;
	includeMoreLink?: boolean;
	includeFullMoreButton?: boolean;
}

function createTouchPointerEvent(
	type: string,
	options: {
		pointerId?: number;
		pointerType?: string;
		button?: number;
		clientX?: number;
		clientY?: number;
	} = {},
): PointerEvent {
	return new PointerEvent(type, {
		bubbles: true,
		cancelable: true,
		pointerId: options.pointerId ?? 1,
		pointerType: options.pointerType ?? "touch",
		button: options.button ?? 0,
		clientX: options.clientX ?? 120,
		clientY: options.clientY ?? 220,
	});
}

function createQuickCreateHarness(options: QuickCreateHarnessOptions = {}) {
	const parentEl = document.createElement("div");
	const toolbarEl = document.createElement("div");
	toolbarEl.className = "tnc-toolbar";
	const basesViewEl = document.createElement("div");
	basesViewEl.className = "bases-view";
	const containerEl = document.createElement("div");
	const rootEl = document.createElement("div");
	rootEl.className = "tn-bases-integration tasknotes-plugin advanced-calendar-view";
	if (options.selectionModeActive) {
		rootEl.classList.add("tn-selection-mode");
	}

	const calendarEl = document.createElement("div");
	calendarEl.id = "bases-calendar";
	if (options.showMonthDayPanel) {
		calendarEl.classList.add("tn-calendar-composition");
	}

	const gridEl = document.createElement("div");
	const mode = options.gridMode ?? "chips";
	if (mode === "chips") {
		gridEl.className = "tnc-dg tnc-dg--dots tnc-dg--chips";
	} else if (mode === "dots") {
		gridEl.className = "tnc-dg tnc-dg--dots";
	} else if (mode === "compact") {
		gridEl.className = "tnc-dg tnc-dg--dots tnc-dg--compact";
	} else {
		gridEl.className = "tnc-dg";
	}

	const dayCell = document.createElement("div");
	dayCell.className = "tnc-dg-day";
	dayCell.dataset.date = "2026-11-20";

	const navLink = document.createElement("a");
	navLink.className = "tnc-navlink tnc-dg-num";
	navLink.textContent = "20";
	dayCell.appendChild(navLink);

	const dotsEl = document.createElement("div");
	dotsEl.className = "tnc-dg-dots";

	const chipIndicator = document.createElement("div");
	chipIndicator.className = "tnc-item tnc-item--indicator";
	chipIndicator.dataset.icsEvent = "true";
	dotsEl.appendChild(chipIndicator);

	const fullLayerEl = document.createElement("div");
	fullLayerEl.className = "tnc-dg-layer";
	const fullEventBar = document.createElement("div");
	fullEventBar.className = "tnc-item";
	fullEventBar.dataset.taskPath = "TaskNotes/Tasks/full.md";
	fullLayerEl.appendChild(fullEventBar);
	dayCell.appendChild(fullLayerEl);

	let moreLink: HTMLSpanElement | null = null;
	if (options.includeMoreLink) {
		moreLink = document.createElement("span");
		moreLink.className = "tnc-dg-dots-more";
		moreLink.setAttribute("role", "button");
		moreLink.textContent = "+2 more";
		dotsEl.appendChild(moreLink);
	}

	let fullMoreButton: HTMLButtonElement | null = null;
	if (options.includeFullMoreButton) {
		const moreLayerEl = document.createElement("div");
		moreLayerEl.className = "tnc-more-layer";
		fullMoreButton = document.createElement("button");
		fullMoreButton.type = "button";
		fullMoreButton.className = "tnc-more";
		const dayNum = parseDayNumber("2026-11-20");
		if (dayNum !== null) {
			fullMoreButton.dataset.day = String(dayNum);
		}
		fullMoreButton.textContent = "+3 more";
		moreLayerEl.appendChild(fullMoreButton);
		fullLayerEl.appendChild(moreLayerEl);
	}

	dayCell.appendChild(dotsEl);
	gridEl.appendChild(dayCell);

	if (options.draggingActive) {
		const dragging = document.createElement("div");
		dragging.className = "tnc-dragging";
		gridEl.appendChild(dragging);
	}

	const dayPanelEl = document.createElement("div");
	dayPanelEl.className = "tn-calendar-day-panel";
	const dayPanelItem = document.createElement("div");
	dayPanelItem.className = "tnc-dg-day";
	dayPanelItem.dataset.date = "2026-11-20";
	dayPanelEl.appendChild(dayPanelItem);

	const popoverEl = document.createElement("div");
	popoverEl.className = "tnc-popover";
	const popoverInner = document.createElement("div");
	popoverInner.textContent = "Popover item";
	popoverEl.appendChild(popoverInner);

	calendarEl.append(gridEl, dayPanelEl);
	rootEl.append(toolbarEl, calendarEl, popoverEl);
	containerEl.appendChild(rootEl);
	basesViewEl.appendChild(containerEl);
	parentEl.appendChild(basesViewEl);
	document.body.appendChild(parentEl);

	const handleDateSelectSpy = vi.fn();
	const unselectSpy = vi.fn();
	const openMoreSpy = vi.fn();
	const openTaskEditModalSpy = vi.fn();
	const taskFile = new TFile();
	taskFile.path = "TaskNotes/Tasks/full.md";
	taskFile.extension = "md";

	let draggingFlag = options.draggingActive ?? false;

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
					handleDateSelect: handleDateSelectSpy,
					calendar: {
						meta: new WeakMap(),
						get session() {
							return { active: draggingFlag };
						},
						unselect: unselectSpy,
						openMore: openMoreSpy,
					},
				},
			},
		},
	};

	const app = {
		plugins: {
			plugins: {
				tasknotes: {
					settings: { singleClickAction: "edit" },
					taskSelectionService: {
						isSelectionModeActive: () => options.selectionModeActive ?? false,
					},
					cacheManager: {
						getTaskInfo: (taskPath: string) =>
							Promise.resolve({ path: taskPath, title: "Full task" }),
					},
					openTaskEditModal: openTaskEditModalSpy,
				},
			},
		},
		vault: {
			getAbstractFileByPath: (filePath: string) =>
				filePath === taskFile.path ? taskFile : null,
		},
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
		containerEl,
		calendarEl,
		toolbarEl,
		dayCell,
		navLink,
		chipIndicator,
		fullEventBar,
		moreLink,
		fullMoreButton,
		dayPanelItem,
		popoverInner,
		handleDateSelectSpy,
		unselectSpy,
		openMoreSpy,
		setDragging: (active: boolean) => {
			draggingFlag = active;
		},
	};
}

describe("MonthDayQuickCreateController", () => {
	beforeEach(() => {
		document.body.replaceChildren();
		document.body.className = "";
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		document.body.replaceChildren();
		document.body.className = "";
	});

	it("opens TaskNotes creation menu on desktop right-click across all month modes including showMonthDayPanel: true", () => {
		for (const spec of [
			{ gridMode: "full" as const, showMonthDayPanel: false },
			{ gridMode: "chips" as const, showMonthDayPanel: false },
			{ gridMode: "dots" as const, showMonthDayPanel: false },
			{ gridMode: "compact" as const, showMonthDayPanel: false },
			{ gridMode: "chips" as const, showMonthDayPanel: true },
		]) {
			document.body.replaceChildren();
			const harness = createQuickCreateHarness(spec);
			const controller = new MonthDayQuickCreateController(harness.app);
			controller.enable();

			expect(document.body.classList.contains(MONTH_QUICK_CREATE_BODY_CLASS)).toBe(true);

			const event = new MouseEvent("contextmenu", {
				bubbles: true,
				cancelable: true,
				button: 2,
				clientX: 150,
				clientY: 260,
			});
			harness.dayCell.dispatchEvent(event);

			expect(event.defaultPrevented).toBe(true);
			expect(harness.handleDateSelectSpy).toHaveBeenCalledTimes(1);
			const info = harness.handleDateSelectSpy.mock.calls[0]?.[0] as {
				start: Date;
				end: Date;
				startStr: string;
				endStr: string;
				allDay: boolean;
				jsEvent: MouseEvent;
				view?: unknown;
			};
			expect(formatLocalDateString(info.start)).toBe("2026-11-20");
			expect(formatLocalDateString(info.end)).toBe("2026-11-21");
			expect(info.startStr).toBe("2026-11-20");
			expect(info.endStr).toBe("2026-11-21");
			expect(info.allDay).toBe(true);
			expect(info.jsEvent).toBe(event);
			expect(info.view).toBeUndefined();

			controller.disable();
		}
	});

	it("ignores desktop right-click on event items, navlinks, popover, toolbar, day-panel, and selection mode", () => {
		const harness = createQuickCreateHarness({
			gridMode: "chips",
			includeMoreLink: true,
		});
		const controller = new MonthDayQuickCreateController(harness.app);
		controller.enable();

		const ignoredTargets: Array<Element | null> = [
			harness.fullEventBar,
			harness.chipIndicator,
			harness.navLink,
			harness.popoverInner,
			harness.toolbarEl,
			harness.dayPanelItem,
		];

		for (const target of ignoredTargets) {
			const ev = new MouseEvent("contextmenu", {
				bubbles: true,
				cancelable: true,
				button: 2,
			});
			target?.dispatchEvent(ev);
			expect(ev.defaultPrevented).toBe(false);
		}
		expect(harness.handleDateSelectSpy).not.toHaveBeenCalled();

		controller.disable();

		const selectionHarness = createQuickCreateHarness({
			gridMode: "chips",
			selectionModeActive: true,
		});
		const selController = new MonthDayQuickCreateController(selectionHarness.app);
		selController.enable();
		const selEvent = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
		selectionHarness.dayCell.dispatchEvent(selEvent);
		expect(selectionHarness.handleDateSelectSpy).not.toHaveBeenCalled();
		selController.disable();
	});

	it("triggers creation menu on touch long-press and suppresses trailing pointerup/click/contextmenu including MobileMonthTapController", () => {
		vi.useFakeTimers();
		const harness = createQuickCreateHarness({ gridMode: "chips" });

		// Attach MobileMonthTapController as well to verify co-existence order independence.
		const mobileTap = new MobileMonthTapController(harness.app);
		const quickCreate = new MonthDayQuickCreateController(harness.app);
		mobileTap.enable();
		quickCreate.enable();

		const downEvent = createTouchPointerEvent("pointerdown", {
			pointerId: 7,
			clientX: 135,
			clientY: 245,
		});
		harness.chipIndicator.dispatchEvent(downEvent);
		expect(harness.handleDateSelectSpy).not.toHaveBeenCalled();

		vi.advanceTimersByTime(LONG_PRESS_DELAY_MS);
		expect(harness.unselectSpy).toHaveBeenCalledTimes(1);
		expect(harness.handleDateSelectSpy).toHaveBeenCalledTimes(1);
		const info = harness.handleDateSelectSpy.mock.calls[0]?.[0] as {
			startStr: string;
			jsEvent: MouseEvent;
		};
		expect(info.startStr).toBe("2026-11-20");
		expect(info.jsEvent.clientX).toBe(135);
		expect(info.jsEvent.clientY).toBe(245);

		// Trailing native contextmenu, pointerup, and click inside containerEl must all be suppressed.
		const nativeCtx = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
		harness.chipIndicator.dispatchEvent(nativeCtx);
		expect(nativeCtx.defaultPrevented).toBe(true);
		expect(harness.handleDateSelectSpy).toHaveBeenCalledTimes(1);

		const upEvent = createTouchPointerEvent("pointerup", { pointerId: 7 });
		harness.chipIndicator.dispatchEvent(upEvent);
		expect(upEvent.defaultPrevented).toBe(true);

		const clickEvent = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
		harness.chipIndicator.dispatchEvent(clickEvent);
		expect(clickEvent.defaultPrevented).toBe(true);
		// Crucially, MobileMonthTapController must NOT open the day popover on long-press release.
		expect(harness.openMoreSpy).not.toHaveBeenCalled();

		// Meanwhile, clicks outside containerEl (like Obsidian's Menu attached to document.body) work normally.
		const menuButton = document.createElement("div");
		menuButton.className = "menu-item";
		document.body.appendChild(menuButton);
		const outsideClickSpy = vi.fn();
		menuButton.addEventListener("click", outsideClickSpy);
		const menuClick = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
		menuButton.dispatchEvent(menuClick);
		expect(menuClick.defaultPrevented).toBe(false);
		expect(outsideClickSpy).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(POST_LONG_PRESS_SUPPRESS_MS);
		quickCreate.disable();
		mobileTap.disable();
	});

	it("cancels long-press on short tap, finger movement > 10px, multi-touch pinch, pointercancel, or drag state", () => {
		vi.useFakeTimers();
		const harness = createQuickCreateHarness({ gridMode: "chips" });
		const controller = new MonthDayQuickCreateController(harness.app);
		controller.enable();

		// 1. Short tap released before 480ms
		harness.dayCell.dispatchEvent(createTouchPointerEvent("pointerdown", { pointerId: 1 }));
		vi.advanceTimersByTime(LONG_PRESS_DELAY_MS - 50);
		harness.dayCell.dispatchEvent(createTouchPointerEvent("pointerup", { pointerId: 1 }));
		vi.advanceTimersByTime(100);
		expect(harness.handleDateSelectSpy).not.toHaveBeenCalled();

		// 2. Movement > 10px
		harness.dayCell.dispatchEvent(
			createTouchPointerEvent("pointerdown", { pointerId: 2, clientX: 100, clientY: 100 }),
		);
		harness.dayCell.dispatchEvent(
			createTouchPointerEvent("pointermove", { pointerId: 2, clientX: 115, clientY: 100 }),
		);
		vi.advanceTimersByTime(LONG_PRESS_DELAY_MS + 50);
		harness.dayCell.dispatchEvent(createTouchPointerEvent("pointerup", { pointerId: 2 }));
		expect(harness.handleDateSelectSpy).not.toHaveBeenCalled();

		// 3. Multi-touch pinch (second finger arrives)
		harness.dayCell.dispatchEvent(createTouchPointerEvent("pointerdown", { pointerId: 3 }));
		harness.dayCell.dispatchEvent(createTouchPointerEvent("pointerdown", { pointerId: 4 }));
		vi.advanceTimersByTime(LONG_PRESS_DELAY_MS + 50);
		harness.dayCell.dispatchEvent(createTouchPointerEvent("pointerup", { pointerId: 3 }));
		harness.dayCell.dispatchEvent(createTouchPointerEvent("pointerup", { pointerId: 4 }));
		expect(harness.handleDateSelectSpy).not.toHaveBeenCalled();

		// 4. pointercancel
		harness.dayCell.dispatchEvent(createTouchPointerEvent("pointerdown", { pointerId: 5 }));
		harness.dayCell.dispatchEvent(createTouchPointerEvent("pointercancel", { pointerId: 5 }));
		vi.advanceTimersByTime(LONG_PRESS_DELAY_MS + 50);
		expect(harness.handleDateSelectSpy).not.toHaveBeenCalled();

		// 5. Engine enters drag session before timer fires
		harness.dayCell.dispatchEvent(createTouchPointerEvent("pointerdown", { pointerId: 6 }));
		harness.setDragging(true);
		vi.advanceTimersByTime(LONG_PRESS_DELAY_MS + 50);
		expect(harness.handleDateSelectSpy).not.toHaveBeenCalled();

		controller.disable();
	});

	it("does not hijack long-press on full-mode event bars", () => {
		vi.useFakeTimers();
		const harness = createQuickCreateHarness({ gridMode: "full" });
		const controller = new MonthDayQuickCreateController(harness.app);
		controller.enable();

		harness.fullEventBar.dispatchEvent(
			createTouchPointerEvent("pointerdown", { pointerId: 10 }),
		);
		vi.advanceTimersByTime(LONG_PRESS_DELAY_MS + 50);
		expect(harness.handleDateSelectSpy).not.toHaveBeenCalled();

		controller.disable();
	});

	it("opens creation menu on desktop right-click and touch long-press on +more in chips and full modes", () => {
		vi.useFakeTimers();

		// 1. Desktop right-click & mobile long-press on chips .tnc-dg-dots-more with MobileMonthTapController active
		const chipsHarness = createQuickCreateHarness({
			gridMode: "chips",
			includeMoreLink: true,
		});
		const mobileTap = new MobileMonthTapController(chipsHarness.app);
		const chipsQuickCreate = new MonthDayQuickCreateController(chipsHarness.app);
		mobileTap.enable();
		chipsQuickCreate.enable();

		const moreClickSpy = vi.fn();
		chipsHarness.moreLink?.addEventListener("click", moreClickSpy);

		const rightClick = new MouseEvent("contextmenu", {
			bubbles: true,
			cancelable: true,
			button: 2,
			clientX: 90,
			clientY: 130,
		});
		chipsHarness.moreLink?.dispatchEvent(rightClick);
		expect(rightClick.defaultPrevented).toBe(true);
		expect(chipsHarness.handleDateSelectSpy).toHaveBeenCalledTimes(1);
		expect(
			(chipsHarness.handleDateSelectSpy.mock.calls[0]?.[0] as { startStr: string }).startStr,
		).toBe("2026-11-20");

		// Short tap cancels long-press and lets click reach +more
		chipsHarness.moreLink?.dispatchEvent(
			createTouchPointerEvent("pointerdown", { pointerId: 21 }),
		);
		vi.advanceTimersByTime(LONG_PRESS_DELAY_MS - 100);
		chipsHarness.moreLink?.dispatchEvent(
			createTouchPointerEvent("pointerup", { pointerId: 21 }),
		);
		chipsHarness.moreLink?.dispatchEvent(
			new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }),
		);
		expect(chipsHarness.handleDateSelectSpy).toHaveBeenCalledTimes(1);
		expect(moreClickSpy).toHaveBeenCalledTimes(1);

		// Long-press on +more triggers creation menu and suppresses trailing click
		chipsHarness.moreLink?.dispatchEvent(
			createTouchPointerEvent("pointerdown", { pointerId: 22, clientX: 95, clientY: 140 }),
		);
		vi.advanceTimersByTime(LONG_PRESS_DELAY_MS);
		expect(chipsHarness.handleDateSelectSpy).toHaveBeenCalledTimes(2);
		expect(
			(chipsHarness.handleDateSelectSpy.mock.calls[1]?.[0] as { startStr: string }).startStr,
		).toBe("2026-11-20");

		const trailingClick = new MouseEvent("click", {
			bubbles: true,
			cancelable: true,
			button: 0,
		});
		chipsHarness.moreLink?.dispatchEvent(trailingClick);
		expect(trailingClick.defaultPrevented).toBe(true);
		expect(moreClickSpy).toHaveBeenCalledTimes(1);
		expect(chipsHarness.openMoreSpy).not.toHaveBeenCalled();

		chipsQuickCreate.disable();
		mobileTap.disable();
		document.body.replaceChildren();

		// 2. Desktop right-click & touch long-press on full-mode .tnc-more[data-day]
		const fullHarness = createQuickCreateHarness({
			gridMode: "full",
			includeFullMoreButton: true,
		});
		const fullQuickCreate = new MonthDayQuickCreateController(fullHarness.app);
		fullQuickCreate.enable();

		const fullRightClick = new MouseEvent("contextmenu", {
			bubbles: true,
			cancelable: true,
			button: 2,
		});
		fullHarness.fullMoreButton?.dispatchEvent(fullRightClick);
		expect(fullRightClick.defaultPrevented).toBe(true);
		expect(fullHarness.handleDateSelectSpy).toHaveBeenCalledTimes(1);
		expect(
			(fullHarness.handleDateSelectSpy.mock.calls[0]?.[0] as { startStr: string }).startStr,
		).toBe("2026-11-20");

		const fullClickSpy = vi.fn();
		fullHarness.fullMoreButton?.addEventListener("click", fullClickSpy);
		fullHarness.fullMoreButton?.dispatchEvent(
			createTouchPointerEvent("pointerdown", { pointerId: 23 }),
		);
		vi.advanceTimersByTime(LONG_PRESS_DELAY_MS);
		expect(fullHarness.handleDateSelectSpy).toHaveBeenCalledTimes(2);
		const fullTrailingClick = new MouseEvent("click", {
			bubbles: true,
			cancelable: true,
			button: 0,
		});
		fullHarness.fullMoreButton?.dispatchEvent(fullTrailingClick);
		expect(fullTrailingClick.defaultPrevented).toBe(true);
		expect(fullClickSpy).not.toHaveBeenCalled();

		fullQuickCreate.disable();
	});

	it("cleans up body class, pending timers, and event listeners on disable()", () => {
		vi.useFakeTimers();
		const harness = createQuickCreateHarness({ gridMode: "chips" });
		const controller = new MonthDayQuickCreateController(harness.app);
		controller.enable();

		harness.dayCell.dispatchEvent(createTouchPointerEvent("pointerdown", { pointerId: 11 }));
		controller.disable();

		expect(document.body.classList.contains(MONTH_QUICK_CREATE_BODY_CLASS)).toBe(false);

		vi.advanceTimersByTime(LONG_PRESS_DELAY_MS + 100);
		expect(harness.handleDateSelectSpy).not.toHaveBeenCalled();

		const rightClick = new MouseEvent("contextmenu", {
			bubbles: true,
			cancelable: true,
			button: 2,
		});
		harness.dayCell.dispatchEvent(rightClick);
		expect(rightClick.defaultPrevented).toBe(false);
		expect(harness.handleDateSelectSpy).not.toHaveBeenCalled();
	});

	it("resolves column date under touch long-press on a multi-day spanning chip in .tnc-dg-layer", () => {
		vi.useFakeTimers();
		const harness = createQuickCreateHarness({ gridMode: "chips" });
		const grid = harness.calendarEl.querySelector<HTMLElement>(".tnc-dg");
		if (!grid) {
			throw new Error("Expected grid element");
		}

		// Build a 2-day week row so we can verify pointer X selects column 2 ("2026-11-21")
		const weekRow = document.createElement("div");
		weekRow.className = "tnc-dg-week";
		const dates = document.createElement("div");
		dates.className = "tnc-dg-dates";

		const cell1 = document.createElement("div");
		cell1.className = "tnc-dg-day";
		cell1.dataset.date = "2026-11-20";
		vi.spyOn(cell1, "getBoundingClientRect").mockReturnValue(
			new DOMRect(0, 0, 100, 100),
		);

		const cell2 = document.createElement("div");
		cell2.className = "tnc-dg-day";
		cell2.dataset.date = "2026-11-21";
		vi.spyOn(cell2, "getBoundingClientRect").mockReturnValue(
			new DOMRect(100, 0, 100, 100),
		);

		dates.append(cell1, cell2);
		const layer = document.createElement("div");
		layer.className = "tnc-dg-layer";
		const spanningChip = document.createElement("div");
		spanningChip.className = "tnc-item tnc-item--indicator";
		spanningChip.dataset.icsEvent = "true";
		spanningChip.dataset.tnceStartDate = "2026-11-20";
		layer.appendChild(spanningChip);
		weekRow.append(dates, layer);
		grid.replaceChildren(weekRow);

		const controller = new MonthDayQuickCreateController(harness.app);
		controller.enable();

		spanningChip.dispatchEvent(
			createTouchPointerEvent("pointerdown", {
				pointerId: 33,
				clientX: 150,
				clientY: 40,
			}),
		);
		vi.advanceTimersByTime(LONG_PRESS_DELAY_MS);
		expect(harness.handleDateSelectSpy).toHaveBeenCalledTimes(1);
		expect(
			(harness.handleDateSelectSpy.mock.calls[0]?.[0] as { startStr: string }).startStr,
		).toBe("2026-11-21");

		controller.disable();
	});
});
