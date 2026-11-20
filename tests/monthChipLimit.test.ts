// @vitest-environment happy-dom

import type { App } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	MAX_DIRECT_MONTH_CHIPS,
	MonthChipLimitController,
} from "../src/monthChipLimit";

interface ChipLimitHarnessOptions {
	monthDisplay?: string;
	viewType?: string;
	dayMaxEvents?: boolean | number;
	configuredDayMaxEvents?: boolean | number;
	showMonthDayPanel?: boolean;
	destroyed?: boolean;
}

function createChipLimitHarness(options: ChipLimitHarnessOptions = {}) {
	const parentEl = document.createElement("div");
	const basesViewEl = document.createElement("div");
	basesViewEl.className = "bases-view";
	const containerEl = document.createElement("div");

	const gridEl = document.createElement("div");
	gridEl.className = "tnc-dg tnc-dg--dots tnc-dg--chips";
	const moreSpan = document.createElement("span");
	moreSpan.className = "tnc-dg-dots-more";
	moreSpan.textContent = "+1";
	const dotsBox = document.createElement("div");
	dotsBox.className = "tnc-dg-dots";
	dotsBox.setAttribute("aria-hidden", "true");
	dotsBox.appendChild(moreSpan);
	gridEl.appendChild(dotsBox);
	containerEl.appendChild(gridEl);
	basesViewEl.appendChild(containerEl);
	parentEl.appendChild(basesViewEl);
	document.body.appendChild(parentEl);

	const calendarState = {
		monthDisplay: options.monthDisplay ?? "chips",
		viewType: options.viewType ?? "month",
		dayMaxEvents: options.dayMaxEvents ?? true,
		destroyed: options.destroyed ?? false,
	};

	const configSetSpy = vi.fn();
	const syncCalendarToolbarSpy = vi.fn();
	const syncMonthChipControlsSpy = vi.fn();
	const setOptionsSpy = vi.fn((next: Record<string, unknown>) => {
		if (
			typeof next.dayMaxEvents === "boolean" ||
			typeof next.dayMaxEvents === "number"
		) {
			calendarState.dayMaxEvents = next.dayMaxEvents;
		}
	});

	const calendarObj = {
		get destroyed() {
			return calendarState.destroyed;
		},
		get view() {
			return { type: calendarState.viewType };
		},
		getOptions: () => ({
			monthDisplay: calendarState.monthDisplay,
			dayMaxEvents: calendarState.dayMaxEvents,
		}),
		setOptions: setOptionsSpy,
	};

	const viewOptions: Record<string, unknown> = {
		showMonthDayPanel: options.showMonthDayPanel ?? false,
	};
	if (options.configuredDayMaxEvents !== undefined) {
		viewOptions.dayMaxEvents = options.configuredDayMaxEvents;
	}

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
					viewOptions,
					calendar: calendarObj,
					syncCalendarToolbar: syncCalendarToolbarSpy,
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
		containerEl,
		dotsBox,
		moreSpan,
		calendarState,
		viewOptions,
		configSetSpy,
		setOptionsSpy,
		syncCalendarToolbarSpy,
		syncMonthChipControlsSpy,
	};
}

describe("MonthChipLimitController", () => {
	let controller: MonthChipLimitController | null = null;

	beforeEach(() => {
		document.body.replaceChildren();
	});

	afterEach(() => {
		controller?.disable();
		controller = null;
		vi.restoreAllMocks();
	});

	it("caps dayMaxEvents at 4 in month chips mode, preserves toolbar/chip controls, and restores on disable", () => {
		const harness = createChipLimitHarness({
			monthDisplay: "chips",
			viewType: "month",
			dayMaxEvents: true,
			configuredDayMaxEvents: true,
		});
		controller = new MonthChipLimitController(harness.app);
		controller.enable();

		expect(MAX_DIRECT_MONTH_CHIPS).toBe(4);
		expect(harness.setOptionsSpy).toHaveBeenCalledTimes(1);
		expect(harness.setOptionsSpy).toHaveBeenCalledWith({ dayMaxEvents: 4 });
		expect(harness.calendarState.dayMaxEvents).toBe(4);
		expect(harness.syncCalendarToolbarSpy).toHaveBeenCalledTimes(1);
		expect(harness.syncMonthChipControlsSpy).toHaveBeenCalledTimes(1);
		expect(harness.dotsBox.hasAttribute("aria-hidden")).toBe(false);
		expect(harness.moreSpan.getAttribute("role")).toBe("button");
		expect(harness.moreSpan.getAttribute("tabindex")).toBe("0");
		expect(harness.moreSpan.hasAttribute("data-tnc-no-drag")).toBe(true);

		// Repeated syncViews() calls must be idempotent and never trigger extra setOptions calls.
		controller.syncViews();
		expect(harness.setOptionsSpy).toHaveBeenCalledTimes(1);

		controller.disable();
		expect(harness.setOptionsSpy).toHaveBeenCalledTimes(2);
		expect(harness.setOptionsSpy).toHaveBeenLastCalledWith({ dayMaxEvents: true });
		expect(harness.calendarState.dayMaxEvents).toBe(true);
		expect(harness.configSetSpy).not.toHaveBeenCalled();
	});

	it("respects a smaller user-configured dayMaxEvents limit and explicit unlimited (false)", () => {
		const smallerHarness = createChipLimitHarness({
			monthDisplay: "chips",
			viewType: "month",
			dayMaxEvents: 2,
			configuredDayMaxEvents: 2,
		});
		controller = new MonthChipLimitController(smallerHarness.app);
		controller.enable();

		expect(smallerHarness.setOptionsSpy).not.toHaveBeenCalled();
		expect(smallerHarness.calendarState.dayMaxEvents).toBe(2);
		controller.disable();

		const largerHarness = createChipLimitHarness({
			monthDisplay: "chips",
			viewType: "month",
			dayMaxEvents: 8,
			configuredDayMaxEvents: 8,
		});
		controller = new MonthChipLimitController(largerHarness.app);
		controller.enable();

		expect(largerHarness.setOptionsSpy).toHaveBeenCalledWith({ dayMaxEvents: 4 });
		controller.disable();
		expect(largerHarness.calendarState.dayMaxEvents).toBe(8);

		const unlimitedHarness = createChipLimitHarness({
			monthDisplay: "chips",
			viewType: "month",
			dayMaxEvents: false,
			configuredDayMaxEvents: false,
		});
		controller = new MonthChipLimitController(unlimitedHarness.app);
		controller.enable();

		expect(unlimitedHarness.setOptionsSpy).not.toHaveBeenCalled();
		expect(unlimitedHarness.calendarState.dayMaxEvents).toBe(false);
	});

	it("restores original dayMaxEvents when switching out of chips or out of month view", () => {
		const harness = createChipLimitHarness({
			monthDisplay: "chips",
			viewType: "month",
			dayMaxEvents: true,
			configuredDayMaxEvents: true,
		});
		controller = new MonthChipLimitController(harness.app);
		controller.enable();
		expect(harness.calendarState.dayMaxEvents).toBe(4);

		// Switching to desktop full mode restores original dayMaxEvents.
		harness.calendarState.monthDisplay = "full";
		controller.syncViews();
		expect(harness.calendarState.dayMaxEvents).toBe(true);

		// Returning to chips applies 4 again.
		harness.calendarState.monthDisplay = "chips";
		controller.syncViews();
		expect(harness.calendarState.dayMaxEvents).toBe(4);

		// Switching view type to week restores original dayMaxEvents.
		harness.calendarState.viewType = "week";
		controller.syncViews();
		expect(harness.calendarState.dayMaxEvents).toBe(true);
	});
});
