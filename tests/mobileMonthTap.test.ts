// @vitest-environment happy-dom

import { type App, TFile } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	MOBILE_MONTH_TAP_BODY_CLASS,
	MobileMonthTapController,
} from "../src/mobileMonthTap";
import {
	LONG_PRESS_DELAY_MS,
	MonthDayQuickCreateController,
} from "../src/monthDayQuickCreate";
import { parseDayNumber } from "../src/tasknotesBridge";

interface HarnessOptions {
	gridMode?: "chips" | "dots" | "compact" | "full";
	showMonthDayPanel?: boolean;
	selectionModeActive?: boolean;
	singleClickAction?: "edit" | "openNote";
	includeMoreLink?: boolean;
	includeIndicator?: boolean;
	registerChipInMeta?: boolean;
	taskPath?: string;
	isIcsEvent?: boolean;
}

function createMonthHarness(options: HarnessOptions = {}) {
	const parentEl = document.createElement("div");
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

	let indicatorEl: HTMLDivElement | null = null;
	if (options.includeIndicator !== false) {
		indicatorEl = document.createElement("div");
		indicatorEl.className = "tnc-item tnc-item--indicator";
		if (options.taskPath) {
			indicatorEl.dataset.taskPath = options.taskPath;
		}
		if (options.isIcsEvent) {
			indicatorEl.dataset.icsEvent = "true";
		}
		const titleSpan = document.createElement("span");
		titleSpan.className = "tnc-item-title";
		titleSpan.textContent = "Event";
		indicatorEl.appendChild(titleSpan);
		dotsEl.appendChild(indicatorEl);
	}

	let moreLink: HTMLSpanElement | null = null;
	if (options.includeMoreLink) {
		moreLink = document.createElement("span");
		moreLink.className = "tnc-dg-dots-more";
		moreLink.textContent = "+2 more";
		dotsEl.appendChild(moreLink);
	}

	dayCell.appendChild(dotsEl);
	gridEl.appendChild(dayCell);
	calendarEl.appendChild(gridEl);
	rootEl.appendChild(calendarEl);
	containerEl.appendChild(rootEl);
	basesViewEl.appendChild(containerEl);
	parentEl.appendChild(basesViewEl);
	document.body.appendChild(parentEl);

	const meta = new WeakMap<HTMLElement, unknown>();
	if (indicatorEl && options.registerChipInMeta) {
		meta.set(indicatorEl, { id: "item-1" });
	}

	const configSetSpy = vi.fn();
	const handleDateSelectSpy = vi.fn();
	const unselectSpy = vi.fn();
	const openMoreSpy = vi.fn();
	const openTaskEditModalSpy = vi.fn();
	const openFileSpy = vi.fn(() => Promise.resolve());
	const bubblePointerDownSpy = vi.fn();
	calendarEl.addEventListener("pointerdown", bubblePointerDownSpy);

	const taskFile = new TFile();
	taskFile.path = options.taskPath ?? "TaskNotes/Tasks/test.md";
	taskFile.extension = "md";

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
						set: configSetSpy,
					},
					viewOptions: {
						showMonthDayPanel: options.showMonthDayPanel ?? false,
					},
					handleDateSelect: handleDateSelectSpy,
					calendar: {
						meta,
						session: { active: false },
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
					settings: {
						singleClickAction: options.singleClickAction ?? "edit",
					},
					taskSelectionService: {
						isSelectionModeActive: () => options.selectionModeActive ?? false,
					},
					cacheManager: {
						getTaskInfo: (taskPath: string) =>
							Promise.resolve({ path: taskPath, title: "Task" }),
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
			getLeaf: () => ({ openFile: openFileSpy }),
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
		dayCell,
		navLink,
		indicatorEl,
		moreLink,
		configSetSpy,
		handleDateSelectSpy,
		unselectSpy,
		openMoreSpy,
		openTaskEditModalSpy,
		openFileSpy,
		bubblePointerDownSpy,
	};
}

function flushMicrotasks(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("MobileMonthTapController", () => {
	let controller: MobileMonthTapController | null = null;

	beforeEach(() => {
		document.body.replaceChildren();
		document.body.className = "";
	});

	afterEach(() => {
		vi.useRealTimers();
		controller?.disable();
		controller = null;
		vi.restoreAllMocks();
	});

	it("toggles body class cleanly and never calls config.set on disable", () => {
		const harness = createMonthHarness();
		controller = new MobileMonthTapController(harness.app);
		controller.enable();

		expect(document.body.classList.contains(MOBILE_MONTH_TAP_BODY_CLASS)).toBe(true);

		controller.disable();
		expect(document.body.classList.contains(MOBILE_MONTH_TAP_BODY_CLASS)).toBe(false);
		expect(harness.configSetSpy).not.toHaveBeenCalled();
	});

	it("delegates registered chips to the native engine without double-opening", async () => {
		const harness = createMonthHarness({
			gridMode: "chips",
			registerChipInMeta: true,
			taskPath: "TaskNotes/Tasks/native.md",
		});
		controller = new MobileMonthTapController(harness.app);
		controller.enable();

		const titleEl = harness.indicatorEl?.querySelector(".tnc-item-title");
		titleEl?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		await flushMicrotasks();

		expect(harness.openTaskEditModalSpy).not.toHaveBeenCalled();
		expect(harness.openMoreSpy).not.toHaveBeenCalled();
	});

	it("opens task modal or note via fallback when chip is not in calendar.meta", async () => {
		const editHarness = createMonthHarness({
			gridMode: "chips",
			registerChipInMeta: false,
			taskPath: "TaskNotes/Tasks/edit-me.md",
			singleClickAction: "edit",
		});
		controller = new MobileMonthTapController(editHarness.app);
		controller.enable();

		editHarness.indicatorEl?.dispatchEvent(
			new MouseEvent("click", { bubbles: true, cancelable: true }),
		);
		await flushMicrotasks();
		expect(editHarness.openTaskEditModalSpy).toHaveBeenCalledWith({
			path: "TaskNotes/Tasks/edit-me.md",
			title: "Task",
		});
		controller.disable();

		const noteHarness = createMonthHarness({
			gridMode: "chips",
			registerChipInMeta: false,
			taskPath: "TaskNotes/Tasks/open-me.md",
			singleClickAction: "openNote",
		});
		controller = new MobileMonthTapController(noteHarness.app);
		controller.enable();

		noteHarness.indicatorEl?.dispatchEvent(
			new MouseEvent("click", { bubbles: true, cancelable: true }),
		);
		await flushMicrotasks();
		expect(noteHarness.openFileSpy).toHaveBeenCalledTimes(1);
	});

	it("opens day popover when tapping an ICS chip without engine meta", () => {
		const harness = createMonthHarness({
			gridMode: "chips",
			registerChipInMeta: false,
			isIcsEvent: true,
		});
		controller = new MobileMonthTapController(harness.app);
		controller.enable();

		const clickEvent = new MouseEvent("click", { bubbles: true, cancelable: true });
		harness.indicatorEl?.dispatchEvent(clickEvent);

		expect(harness.openMoreSpy).toHaveBeenCalledWith(
			parseDayNumber("2026-11-20"),
			harness.indicatorEl,
			clickEvent,
		);
	});

	it("opens day popover on event-bearing chips day without +more and blocks selection pointerdown", () => {
		const harness = createMonthHarness({
			gridMode: "chips",
			includeMoreLink: false,
			includeIndicator: true,
		});
		controller = new MobileMonthTapController(harness.app);
		controller.enable();

		harness.dayCell.dispatchEvent(
			new PointerEvent("pointerdown", {
				bubbles: true,
				button: 0,
				pointerId: 1,
				clientX: 40,
				clientY: 40,
			}),
		);
		expect(harness.bubblePointerDownSpy).not.toHaveBeenCalled();

		const clickEvent = new MouseEvent("click", { bubbles: true, cancelable: true });
		harness.dayCell.dispatchEvent(clickEvent);
		expect(harness.openMoreSpy).toHaveBeenCalledWith(
			parseDayNumber("2026-11-20"),
			harness.dayCell,
			clickEvent,
		);
	});

	it("opens day popover instead of date selection when tapping empty space on a chips day with +more", () => {
		const harness = createMonthHarness({
			gridMode: "chips",
			includeMoreLink: true,
			includeIndicator: true,
		});
		controller = new MobileMonthTapController(harness.app);
		controller.enable();

		harness.dayCell.dispatchEvent(
			new PointerEvent("pointerdown", {
				bubbles: true,
				button: 0,
				pointerId: 12,
				clientX: 40,
				clientY: 40,
			}),
		);
		expect(harness.bubblePointerDownSpy).not.toHaveBeenCalled();

		const clickEvent = new MouseEvent("click", { bubbles: true, cancelable: true });
		harness.dayCell.dispatchEvent(clickEvent);
		expect(harness.openMoreSpy).toHaveBeenCalledWith(
			parseDayNumber("2026-11-20"),
			harness.dayCell,
			clickEvent,
		);
	});

	it("prevents selection pointerdown on +more without double-opening on click", () => {
		const harness = createMonthHarness({
			gridMode: "chips",
			includeMoreLink: true,
			includeIndicator: true,
		});
		controller = new MobileMonthTapController(harness.app);
		controller.enable();

		harness.moreLink?.dispatchEvent(
			new PointerEvent("pointerdown", {
				bubbles: true,
				button: 0,
				pointerId: 13,
				clientX: 44,
				clientY: 50,
			}),
		);
		expect(harness.bubblePointerDownSpy).not.toHaveBeenCalled();

		harness.moreLink?.dispatchEvent(
			new MouseEvent("click", { bubbles: true, cancelable: true }),
		);
		expect(harness.openMoreSpy).not.toHaveBeenCalled();
	});

	it("still allows long-press quick create on empty space of a chips day with +more", () => {
		vi.useFakeTimers();
		const harness = createMonthHarness({
			gridMode: "chips",
			includeMoreLink: true,
			includeIndicator: true,
		});
		controller = new MobileMonthTapController(harness.app);
		const quickCreate = new MonthDayQuickCreateController(harness.app);
		controller.enable();
		quickCreate.enable();

		harness.dayCell.dispatchEvent(
			new PointerEvent("pointerdown", {
				bubbles: true,
				cancelable: true,
				pointerId: 14,
				pointerType: "touch",
				button: 0,
				clientX: 48,
				clientY: 48,
			}),
		);
		expect(harness.bubblePointerDownSpy).not.toHaveBeenCalled();

		vi.advanceTimersByTime(LONG_PRESS_DELAY_MS);
		expect(harness.handleDateSelectSpy).toHaveBeenCalledTimes(1);

		const upEvent = new PointerEvent("pointerup", {
			bubbles: true,
			cancelable: true,
			pointerId: 14,
			pointerType: "touch",
			button: 0,
		});
		harness.dayCell.dispatchEvent(upEvent);
		expect(upEvent.defaultPrevented).toBe(true);

		const clickEvent = new MouseEvent("click", {
			bubbles: true,
			cancelable: true,
			button: 0,
		});
		harness.dayCell.dispatchEvent(clickEvent);
		expect(clickEvent.defaultPrevented).toBe(true);
		expect(harness.openMoreSpy).not.toHaveBeenCalled();

		quickCreate.disable();
	});

	it("opens day popover in dots mode and suppresses trigger if pointer dragged/swiped > 10px", () => {
		const harness = createMonthHarness({
			gridMode: "dots",
			includeIndicator: true,
		});
		controller = new MobileMonthTapController(harness.app);
		controller.enable();

		harness.dayCell.dispatchEvent(
			new PointerEvent("pointerdown", {
				bubbles: true,
				button: 0,
				pointerId: 7,
				clientX: 10,
				clientY: 10,
			}),
		);
		harness.dayCell.dispatchEvent(
			new PointerEvent("pointermove", {
				bubbles: true,
				pointerId: 7,
				clientX: 35,
				clientY: 12,
			}),
		);
		harness.dayCell.dispatchEvent(
			new MouseEvent("click", { bubbles: true, cancelable: true }),
		);
		expect(harness.openMoreSpy).not.toHaveBeenCalled();

		harness.dayCell.dispatchEvent(
			new PointerEvent("pointerdown", {
				bubbles: true,
				button: 0,
				pointerId: 8,
				clientX: 10,
				clientY: 10,
			}),
		);
		harness.dayCell.dispatchEvent(
			new MouseEvent("click", { bubbles: true, cancelable: true }),
		);
		expect(harness.openMoreSpy).toHaveBeenCalledTimes(1);
	});

	it("does not interfere with empty days, showMonthDayPanel, selection mode, compact, full, navlinks, or +more", () => {
		const emptyDay = createMonthHarness({
			gridMode: "chips",
			includeIndicator: false,
		});
		controller = new MobileMonthTapController(emptyDay.app);
		controller.enable();
		emptyDay.dayCell.dispatchEvent(
			new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1 }),
		);
		emptyDay.dayCell.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(emptyDay.bubblePointerDownSpy).toHaveBeenCalledTimes(1);
		expect(emptyDay.openMoreSpy).not.toHaveBeenCalled();
		controller.disable();

		for (const scenario of [
			{ gridMode: "chips" as const, showMonthDayPanel: true },
			{ gridMode: "chips" as const, selectionModeActive: true },
			{ gridMode: "compact" as const },
			{ gridMode: "full" as const },
		]) {
			const h = createMonthHarness(scenario);
			controller = new MobileMonthTapController(h.app);
			controller.enable();
			h.indicatorEl?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			h.dayCell.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			expect(h.openMoreSpy).not.toHaveBeenCalled();
			expect(h.openTaskEditModalSpy).not.toHaveBeenCalled();
			controller.disable();
		}

		const controlHarness = createMonthHarness({
			gridMode: "chips",
			includeMoreLink: true,
		});
		controller = new MobileMonthTapController(controlHarness.app);
		controller.enable();
		controlHarness.navLink.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		controlHarness.moreLink?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(controlHarness.openMoreSpy).not.toHaveBeenCalled();
	});
});
