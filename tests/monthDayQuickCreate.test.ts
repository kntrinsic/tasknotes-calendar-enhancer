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
import { formatLocalDateString } from "../src/tasknotesBridge";

interface QuickCreateHarnessOptions {
	gridMode?: "full" | "chips" | "dots" | "compact";
	showMonthDayPanel?: boolean;
	selectionModeActive?: boolean;
	draggingActive?: boolean;
	includeMoreLink?: boolean;
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
		moreLink.textContent = "+2 more";
		dotsEl.appendChild(moreLink);
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

	it("ignores desktop right-click on event items, navlinks, +more, popover, toolbar, day-panel, and selection mode", () => {
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
			harness.moreLink,
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
});
