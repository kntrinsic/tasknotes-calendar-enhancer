// @vitest-environment happy-dom

import type { App } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildCalendarColorKey,
	CALENDAR_COLOR_PRESETS,
} from "../src/calendarColorOverrides";
import {
	POPOVER_CLASS,
	sanitizeCssColor,
	TOOLBAR_BUTTON_WRAPPER_CLASS,
	type ToolbarCalendarColorAdapter,
	ToolbarCalendarPicker,
} from "../src/toolbarCalendarPicker";

interface HarnessOptions {
	viewType?: string;
	includeMoreBtn?: boolean;
	includeNewTaskBtn?: boolean;
	googleCalendars?: Array<{
		id: string;
		summary: string;
		primary?: boolean;
		backgroundColor?: string;
	}>;
	microsoftCalendars?: Array<{
		id: string;
		summary: string;
		backgroundColor?: string;
	}>;
	icsSubscriptions?: Array<{
		id: string;
		name: string;
		enabled: boolean;
		color?: string;
	}>;
	hostedAllCount?: number;
}

function createHarness(options: HarnessOptions = {}) {
	const parentEl = document.createElement("div");
	const toolbarEl = document.createElement("div");
	toolbarEl.className = "bases-toolbar";

	const filterEl = document.createElement("div");
	filterEl.className = "bases-toolbar-filter-menu";
	toolbarEl.appendChild(filterEl);

	if (options.includeMoreBtn) {
		const moreBtn = document.createElement("button");
		moreBtn.className = "tn-bases-toolbar-more";
		toolbarEl.appendChild(moreBtn);
	}

	if (options.includeNewTaskBtn !== false) {
		const newTaskBtn = document.createElement("div");
		newTaskBtn.className = "tn-bases-new-task-btn";
		toolbarEl.appendChild(newTaskBtn);
	}

	const basesViewEl = document.createElement("div");
	basesViewEl.className = "bases-view";
	const containerEl = document.createElement("div");
	basesViewEl.appendChild(containerEl);
	parentEl.append(toolbarEl, basesViewEl);
	document.body.appendChild(parentEl);

	const configStore = new Map<string, unknown>();
	const configSetSpy = vi.fn((key: string, value: unknown) => {
		configStore.set(key, value);
	});
	const refreshSpy = vi.fn();
	const openSettingsSpy = vi.fn();
	const openTabByIdSpy = vi.fn();
	const workspaceListeners = new Map<string, Set<() => void>>();

	let currentViewType = options.viewType ?? "tasknotesCalendar";

	const hostedGoogleService = {
		isSignedIn: () => (options.hostedAllCount ?? 0) > 0,
		isConnected: () => (options.hostedAllCount ?? 0) > 0,
		getAvailableCalendars: () => options.googleCalendars ?? [],
		getAllCalendars: () =>
			Array.from(
				{ length: options.hostedAllCount ?? (options.googleCalendars?.length ?? 0) },
				(_, index) => ({ id: `cal-${String(index)}` }),
			),
		on: () => () => {},
	};

	const leaf = {
		view: {
			getViewType: () => "bases",
			containerEl: parentEl,
			controller: {
				view: {
					get type() {
						return currentViewType;
					},
					containerEl,
					config: {
						get: (key: string) => configStore.get(key),
						set: configSetSpy,
					},
					readEventToggles: vi.fn(),
					refresh: refreshSpy,
				},
			},
		},
	};

	const app = {
		plugins: {
			plugins: {
				tasknotes: {
					googleCalendarService: hostedGoogleService,
					hostedGoogleCalendarService: hostedGoogleService,
					microsoftCalendarService: {
						getAvailableCalendars: () => options.microsoftCalendars ?? [],
						on: () => () => {},
					},
					icsSubscriptionService: {
						getSubscriptions: () => options.icsSubscriptions ?? [],
						on: () => () => {},
					},
				},
			},
		},
		workspace: {
			getLeavesOfType: (type: string) => (type === "bases" ? [leaf] : []),
			on: (event: string, cb: () => void) => {
				let set = workspaceListeners.get(event);
				if (!set) {
					set = new Set();
					workspaceListeners.set(event, set);
				}
				set.add(cb);
				return { event, cb };
			},
			offref: (ref: { event: string; cb: () => void }) => {
				workspaceListeners.get(ref.event)?.delete(ref.cb);
			},
			onLayoutReady: (cb: () => void) => {
				cb();
			},
		},
		setting: {
			open: openSettingsSpy,
			openTabById: openTabByIdSpy,
		},
	} as unknown as App;

	return {
		app,
		toolbarEl,
		containerEl,
		configStore,
		configSetSpy,
		refreshSpy,
		openSettingsSpy,
		openTabByIdSpy,
		setViewType: (nextType: string) => {
			currentViewType = nextType;
		},
		triggerLayoutChange: () => {
			for (const cb of workspaceListeners.get("layout-change") ?? []) {
				cb();
			}
		},
	};
}

describe("ToolbarCalendarPicker", () => {
	let picker: ToolbarCalendarPicker | null = null;

	beforeEach(() => {
		document.body.replaceChildren();
	});

	afterEach(() => {
		picker?.disable();
		picker = null;
		vi.restoreAllMocks();
	});

	it("sanitizes CSS colors and rejects injection payloads", () => {
		expect(sanitizeCssColor("#4285F4")).toBe("#4285F4");
		expect(sanitizeCssColor("rgb(10, 20, 30)")).toBe("rgb(10, 20, 30)");
		expect(sanitizeCssColor("red; background-image: url(evil)")).toBeNull();
		expect(sanitizeCssColor("expression(alert(1))")).toBeNull();
	});

	it("places calendar button directly before .tn-bases-new-task-btn and after .tn-bases-toolbar-more", () => {
		const harness = createHarness({
			includeMoreBtn: true,
			includeNewTaskBtn: true,
		});
		picker = new ToolbarCalendarPicker(harness.app);
		picker.enable();

		const children = [...harness.toolbarEl.children];
		const moreIndex = children.findIndex((el) =>
			el.classList.contains("tn-bases-toolbar-more"),
		);
		const pickerIndex = children.findIndex((el) =>
			el.classList.contains(TOOLBAR_BUTTON_WRAPPER_CLASS),
		);
		const newTaskIndex = children.findIndex((el) =>
			el.classList.contains("tn-bases-new-task-btn"),
		);

		expect(moreIndex).toBeGreaterThanOrEqual(0);
		expect(pickerIndex).toBe(moreIndex + 1);
		expect(newTaskIndex).toBe(pickerIndex + 1);
	});

	it("keeps button after .tn-bases-toolbar-more when TaskNotes injects overflow control later", async () => {
		const harness = createHarness({
			includeMoreBtn: false,
			includeNewTaskBtn: true,
		});
		picker = new ToolbarCalendarPicker(harness.app);
		picker.enable();

		const newTaskBtn = harness.toolbarEl.querySelector<HTMLElement>(".tn-bases-new-task-btn");
		expect(newTaskBtn).not.toBeNull();

		const moreBtn = document.createElement("button");
		moreBtn.className = "tn-bases-toolbar-more";
		newTaskBtn?.before(moreBtn);

		await new Promise((resolve) => setTimeout(resolve, 20));

		const children = [...harness.toolbarEl.children];
		const moreIndex = children.findIndex((el) =>
			el.classList.contains("tn-bases-toolbar-more"),
		);
		const pickerIndex = children.findIndex((el) =>
			el.classList.contains(TOOLBAR_BUTTON_WRAPPER_CLASS),
		);
		const newTaskIndex = children.findIndex((el) =>
			el.classList.contains("tn-bases-new-task-btn"),
		);
		expect(pickerIndex).toBe(moreIndex + 1);
		expect(newTaskIndex).toBe(pickerIndex + 1);
	});

	it("converges without DOM ping-pong alongside TaskNotes .tn-shortcut-help observer and overflow panel", async () => {
		const harness = createHarness({
			includeMoreBtn: true,
			includeNewTaskBtn: true,
			icsSubscriptions: [{ id: "ics-1", name: "Work", enabled: true }],
		});
		const newTaskBtn = harness.toolbarEl.querySelector<HTMLElement>(".tn-bases-new-task-btn");
		expect(newTaskBtn).not.toBeNull();

		const helpBtn = document.createElement("button");
		helpBtn.className = "tn-shortcut-help clickable-icon";
		newTaskBtn?.before(helpBtn);

		const overflowPanel = document.createElement("div");
		overflowPanel.className = "tn-bases-toolbar-overflow-panel";
		document.body.appendChild(overflowPanel);

		let toolbarMutations = 0;
		const chromeObserver = new MutationObserver(() => {
			toolbarMutations += 1;
			if (helpBtn.closest(".tn-bases-toolbar-overflow-panel")) {
				return;
			}
			if (newTaskBtn && helpBtn.nextElementSibling !== newTaskBtn) {
				newTaskBtn.before(helpBtn);
			}
		});
		chromeObserver.observe(harness.toolbarEl.parentElement as HTMLElement, {
			childList: true,
			subtree: true,
		});

		try {
			picker = new ToolbarCalendarPicker(harness.app);
			picker.enable();

			await new Promise((resolve) => setTimeout(resolve, 50));

			expect(toolbarMutations).toBeLessThan(10);
			const children = [...harness.toolbarEl.children];
			const moreIndex = children.findIndex((el) =>
				el.classList.contains("tn-bases-toolbar-more"),
			);
			const pickerIndex = children.findIndex((el) =>
				el.classList.contains(TOOLBAR_BUTTON_WRAPPER_CLASS),
			);
			const helpIndex = children.findIndex((el) =>
				el.classList.contains("tn-shortcut-help"),
			);
			const newTaskIndex = children.findIndex((el) =>
				el.classList.contains("tn-bases-new-task-btn"),
			);
			expect(moreIndex).toBeGreaterThanOrEqual(0);
			expect(pickerIndex).toBe(moreIndex + 1);
			expect(helpIndex).toBe(pickerIndex + 1);
			expect(newTaskIndex).toBe(helpIndex + 1);

			const toggleBtn = harness.toolbarEl.querySelector<HTMLButtonElement>(
				".tnce-calendar-toggle-button",
			);
			toggleBtn?.click();
			expect(document.body.querySelector(`.${POPOVER_CLASS}`)).not.toBeNull();

			// Simulate TaskNotes narrow-screen overflow moving .tn-shortcut-help out and back.
			const mutationsBeforeOverflow = toolbarMutations;
			const placeholder = document.createComment("");
			helpBtn.before(placeholder);
			overflowPanel.appendChild(helpBtn);
			await new Promise((resolve) => setTimeout(resolve, 30));

			const pickerWrapper = harness.toolbarEl.querySelector<HTMLElement>(
				`.${TOOLBAR_BUTTON_WRAPPER_CLASS}`,
			);
			expect(pickerWrapper?.nextElementSibling).toBe(newTaskBtn);

			placeholder.replaceWith(helpBtn);
			await new Promise((resolve) => setTimeout(resolve, 30));
			expect(pickerWrapper?.nextElementSibling).toBe(helpBtn);
			expect(toolbarMutations - mutationsBeforeOverflow).toBeLessThan(10);
		} finally {
			chromeObserver.disconnect();
		}
	});

	it("removes button when switching away from tasknotesCalendar", () => {
		const harness = createHarness();
		picker = new ToolbarCalendarPicker(harness.app);
		picker.enable();

		expect(
			harness.toolbarEl.querySelector(`.${TOOLBAR_BUTTON_WRAPPER_CLASS}`),
		).not.toBeNull();

		harness.setViewType("tasknotesMiniCalendar");
		picker.syncAllToolbars();

		expect(
			harness.toolbarEl.querySelector(`.${TOOLBAR_BUTTON_WRAPPER_CLASS}`),
		).toBeNull();
	});

	it("renders grouped calendars safely, toggles individual & batch visibility, and updates badge", () => {
		const xssName = "<img src=x onerror=alert(1)>";
		const harness = createHarness({
			googleCalendars: [
				{ id: "primary", summary: xssName, backgroundColor: "#4285f4" },
			],
			microsoftCalendars: [
				{ id: "ms-1", summary: "Outlook", backgroundColor: "javascript:evil" },
			],
			icsSubscriptions: [
				{ id: "ics-1", name: "Holidays", enabled: true, color: "#00aa88" },
				{ id: "ics-off", name: "Disabled", enabled: false, color: "#111111" },
			],
		});

		picker = new ToolbarCalendarPicker(harness.app);
		picker.enable();

		const toggleBtn = harness.toolbarEl.querySelector<HTMLButtonElement>(
			".tnce-calendar-toggle-button",
		);
		expect(toggleBtn).not.toBeNull();
		toggleBtn?.click();

		const popover = document.body.querySelector<HTMLDivElement>(`.${POPOVER_CLASS}`);
		expect(popover).not.toBeNull();
		expect(popover?.getAttribute("role")).toBe("dialog");
		expect(popover?.querySelector("img")).toBeNull();

		const names = [...(popover?.querySelectorAll(".tnce-calendar-picker-name") ?? [])].map(
			(el) => el.textContent,
		);
		expect(names).toEqual([xssName, "Outlook", "Holidays"]);

		const checkboxes = [
			...(popover?.querySelectorAll<HTMLInputElement>(".tnce-calendar-picker-checkbox") ??
				[]),
		];
		expect(checkboxes).toHaveLength(3);
		expect(checkboxes.every((box) => box.checked)).toBe(true);

		if (checkboxes[0]) {
			checkboxes[0].checked = false;
			checkboxes[0].dispatchEvent(new Event("change", { bubbles: true }));
		}
		expect(harness.configSetSpy).toHaveBeenCalledWith("showGoogleCalendar_primary", false);
		expect(harness.refreshSpy).toHaveBeenCalledTimes(1);

		const badge = harness.toolbarEl.querySelector<HTMLSpanElement>(
			".tnce-calendar-toggle-badge",
		);
		expect(badge?.hidden).toBe(false);
		expect(badge?.textContent).toBe("2/3");

		const buttons = [
			...(popover?.querySelectorAll<HTMLButtonElement>(".tnce-calendar-picker-action-btn") ??
				[]),
		];
		const showAllBtn = buttons.find((btn) => btn.textContent === "Show all");
		const hideAllBtn = buttons.find((btn) => btn.textContent === "Hide all");

		hideAllBtn?.click();
		expect(badge?.textContent).toBe("0/3");
		expect(checkboxes.every((box) => !box.checked)).toBe(true);

		showAllBtn?.click();
		expect(badge?.hidden).toBe(true);
		expect(checkboxes.every((box) => box.checked)).toBe(true);
	});

	it("shows hosted Google max-5 guidance without modifying TaskNotes settings", () => {
		const harness = createHarness({
			googleCalendars: [{ id: "g1", summary: "G1" }],
			hostedAllCount: 9,
		});
		picker = new ToolbarCalendarPicker(harness.app);
		picker.enable();

		const toggleBtn = harness.toolbarEl.querySelector<HTMLButtonElement>(
			".tnce-calendar-toggle-button",
		);
		toggleBtn?.click();

		const note = document.body.querySelector(".tnce-calendar-picker-note");
		expect(note?.textContent).toContain("1 of 9 Google calendars");

		const settingsBtn = document.body.querySelector<HTMLButtonElement>(
			".tnce-calendar-picker-footer .tnce-calendar-picker-link-btn",
		);
		settingsBtn?.click();
		expect(harness.openSettingsSpy).toHaveBeenCalledTimes(1);
		expect(harness.openTabByIdSpy).toHaveBeenCalledWith("tasknotes");
		expect(document.body.querySelector(`.${POPOVER_CLASS}`)).toBeNull();
	});

	it("renders empty state when no external calendars exist", () => {
		const harness = createHarness();
		picker = new ToolbarCalendarPicker(harness.app);
		picker.enable();

		harness.toolbarEl
			.querySelector<HTMLButtonElement>(".tnce-calendar-toggle-button")
			?.click();

		const emptyText = document.body.querySelector(".tnce-calendar-picker-empty-text");
		expect(emptyText?.textContent).toContain("No external calendars");
	});

	it("closes popover on Escape (restoring focus) and outside pointerdown", () => {
		const harness = createHarness({
			icsSubscriptions: [{ id: "ics-1", name: "Work", enabled: true }],
		});
		picker = new ToolbarCalendarPicker(harness.app);
		picker.enable();

		const toggleBtn = harness.toolbarEl.querySelector<HTMLButtonElement>(
			".tnce-calendar-toggle-button",
		);
		const toggleWrapper = harness.toolbarEl.querySelector<HTMLElement>(
			`.${TOOLBAR_BUTTON_WRAPPER_CLASS}`,
		);
		expect(toggleBtn).not.toBeNull();
		const focusSpy = vi.spyOn(toggleBtn as HTMLButtonElement, "focus");

		toggleBtn?.click();
		const openedPopover = document.body.querySelector(`.${POPOVER_CLASS}`);
		expect(openedPopover).not.toBeNull();
		expect(openedPopover?.classList.contains("menu")).toBe(true);
		expect(toggleWrapper?.classList.contains("has-active-menu")).toBe(true);
		expect(toggleBtn?.classList.contains("has-active-menu")).toBe(true);
		expect(toggleBtn?.getAttribute("aria-expanded")).toBe("true");

		// Clicking the button again closes the popover, and click bubbles to document so other Bases menus can dismiss.
		const docBubbleClickSpy = vi.fn();
		document.addEventListener("click", docBubbleClickSpy);
		try {
			toggleBtn?.click();
			expect(document.body.querySelector(`.${POPOVER_CLASS}`)).toBeNull();
			expect(docBubbleClickSpy).toHaveBeenCalledTimes(1);

			toggleBtn?.click();
			expect(document.body.querySelector(`.${POPOVER_CLASS}`)).not.toBeNull();
			expect(docBubbleClickSpy).toHaveBeenCalledTimes(2);
		} finally {
			document.removeEventListener("click", docBubbleClickSpy);
		}

		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(document.body.querySelector(`.${POPOVER_CLASS}`)).toBeNull();
		expect(toggleWrapper?.classList.contains("has-active-menu")).toBe(false);
		expect(toggleBtn?.classList.contains("has-active-menu")).toBe(false);
		expect(toggleBtn?.getAttribute("aria-expanded")).toBe("false");
		expect(focusSpy).toHaveBeenCalledTimes(1);

		toggleBtn?.click();
		expect(document.body.querySelector(`.${POPOVER_CLASS}`)).not.toBeNull();

		document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
		expect(document.body.querySelector(`.${POPOVER_CLASS}`)).toBeNull();
	});

	it("removes all injected DOM and never calls config.set on disable()", () => {
		const harness = createHarness({
			icsSubscriptions: [{ id: "ics-1", name: "Work", enabled: true }],
		});
		picker = new ToolbarCalendarPicker(harness.app);
		picker.enable();

		harness.toolbarEl
			.querySelector<HTMLButtonElement>(".tnce-calendar-toggle-button")
			?.click();
		expect(document.body.querySelector(`.${POPOVER_CLASS}`)).not.toBeNull();

		harness.configSetSpy.mockClear();
		picker.disable();

		expect(
			harness.toolbarEl.querySelector(`.${TOOLBAR_BUTTON_WRAPPER_CLASS}`),
		).toBeNull();
		expect(document.body.querySelector(`.${POPOVER_CLASS}`)).toBeNull();
		expect(harness.configSetSpy).not.toHaveBeenCalled();
	});

	it("supports inline preset swatches, custom hex input, reset, and checkbox isolation when color adapter is enabled", async () => {
		const msCals = [
			{ id: "ms-1", summary: "Outlook Work", backgroundColor: "#0078d4" },
			{ id: "ms-2", summary: "Outlook Personal", backgroundColor: "#0078d4" },
		];
		const harness = createHarness({
			microsoftCalendars: msCals,
		});

		let colorsEnabled = true;
		const overrides = new Map<string, string>();
		const setColorOverride = vi.fn(
			(
				provider: "google" | "microsoft" | "ics",
				calendarId: string,
				hexColor: string | null,
			) => {
				const key = buildCalendarColorKey(provider, calendarId);
				if (hexColor === null) {
					overrides.delete(key);
				} else {
					overrides.set(key, hexColor);
				}
				const target = msCals.find((cal) => cal.id === calendarId);
				if (target) {
					target.backgroundColor = hexColor ?? "#0078d4";
				}
				picker?.syncAllToolbars();
				return Promise.resolve();
			},
		);

		const adapter: ToolbarCalendarColorAdapter = {
			isEnabled: () => colorsEnabled,
			getOverrideColor: (provider, calendarId) =>
				overrides.get(buildCalendarColorKey(provider, calendarId)) ?? null,
			setColorOverride,
		};

		picker = new ToolbarCalendarPicker(harness.app, adapter);
		picker.enable();

		harness.toolbarEl
			.querySelector<HTMLButtonElement>(".tnce-calendar-toggle-button")
			?.click();

		const popover = document.body.querySelector<HTMLDivElement>(`.${POPOVER_CLASS}`);
		expect(popover).not.toBeNull();

		const triggers = [
			...(popover?.querySelectorAll<HTMLButtonElement>(".tnce-calendar-color-trigger") ??
				[]),
		];
		expect(triggers).toHaveLength(2);

		// Opening the color panel does not toggle visibility checkboxes.
		triggers[0]?.click();
		expect(harness.configSetSpy).not.toHaveBeenCalled();
		expect(popover?.querySelectorAll(".tnce-calendar-color-panel")).toHaveLength(1);
		expect(triggers[0]?.getAttribute("aria-expanded")).toBe("true");

		const swatches = [
			...(popover?.querySelectorAll<HTMLButtonElement>(".tnce-calendar-color-swatch") ??
				[]),
		];
		expect(swatches).toHaveLength(CALENDAR_COLOR_PRESETS.length);

		// Pick the first preset (#e05252) and keep the popover open.
		swatches[0]?.click();
		await Promise.resolve();
		await Promise.resolve();

		expect(setColorOverride).toHaveBeenCalledWith(
			"microsoft",
			"ms-1",
			CALENDAR_COLOR_PRESETS[0]?.hex,
		);
		expect(document.body.querySelector(`.${POPOVER_CLASS}`)).not.toBeNull();
		const firstDot = triggers[0]?.querySelector<HTMLElement>(".tnce-calendar-picker-color");
		expect(firstDot?.classList.contains("is-custom")).toBe(true);
		expect(swatches[0]?.getAttribute("aria-pressed")).toBe("true");

		// Custom color input previews on `input` and persists on `change`.
		const customInput = popover?.querySelector<HTMLInputElement>(".tnce-calendar-color-input");
		expect(customInput).not.toBeNull();
		if (customInput) {
			customInput.value = "#12ab34";
			customInput.dispatchEvent(new Event("input", { bubbles: true }));
			expect(firstDot?.style.backgroundColor).not.toBe("");
			customInput.dispatchEvent(new Event("change", { bubbles: true }));
		}
		await Promise.resolve();
		await Promise.resolve();
		expect(setColorOverride).toHaveBeenCalledWith("microsoft", "ms-1", "#12ab34");

		// Reset clears the override and restores default dot state.
		const resetBtn = popover?.querySelector<HTMLButtonElement>(
			".tnce-calendar-color-reset-btn",
		);
		expect(resetBtn?.disabled).toBe(false);
		resetBtn?.click();
		await Promise.resolve();
		await Promise.resolve();
		expect(setColorOverride).toHaveBeenCalledWith("microsoft", "ms-1", null);
		expect(firstDot?.classList.contains("is-custom")).toBe(false);
		expect(resetBtn?.disabled).toBe(true);

		// Opening the second calendar's color panel closes the first panel.
		triggers[1]?.click();
		expect(popover?.querySelectorAll(".tnce-calendar-color-panel")).toHaveLength(1);
		expect(triggers[0]?.getAttribute("aria-expanded")).toBe("false");
		expect(triggers[1]?.getAttribute("aria-expanded")).toBe("true");

		// Clicking the calendar name label still toggles its checkbox properly.
		const labels = [
			...(popover?.querySelectorAll<HTMLLabelElement>(".tnce-calendar-picker-name") ?? []),
		];
		labels[0]?.click();
		expect(harness.configSetSpy).toHaveBeenCalledWith("showMicrosoftCalendar_ms-1", false);

		// Disabling color overrides closes any stale color-enabled popover cleanly on sync.
		colorsEnabled = false;
		picker.syncAllToolbars();
		expect(document.body.querySelector(`.${POPOVER_CLASS}`)).toBeNull();
	});
});
