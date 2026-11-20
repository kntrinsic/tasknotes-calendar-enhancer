// @vitest-environment happy-dom

import {
	App,
	ButtonComponent,
	ColorComponent,
	ExtraButtonComponent,
	type Plugin,
	Setting,
	ToggleComponent,
} from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCalendarColorKey } from "../src/calendarColorOverrides";
import {
	DEFAULT_SETTINGS,
	normalizeSettings,
	type SettingsPluginHost,
	TaskNotesCalendarEnhancerSettingTab,
} from "../src/settings";

interface DisplayableTab {
	display(): void;
}

describe("settings", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("enables all companion features by default", () => {
		expect(DEFAULT_SETTINGS).toEqual({
			enableToolbarCalendarPicker: true,
			enableExternalCalendarCache: true,
			enableMobileMonthTap: true,
			enableMonthDayQuickCreate: true,
			enableCustomCalendarColors: true,
			calendarColorOverrides: {},
			enableVividChipColors: true,
			enableMonthChipLimit: true,
			enableMonthChipSpanning: true,
			enableWeekendHolidayColors: true,
			enableJapaneseHolidays: true,
			holidayCalendarKeys: [],
		});
	});

	it("returns defaults for non-object raw inputs", () => {
		expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
		expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
		expect(normalizeSettings("invalid")).toEqual(DEFAULT_SETTINGS);
		expect(normalizeSettings(42)).toEqual(DEFAULT_SETTINGS);
		expect(normalizeSettings(["enableToolbarCalendarPicker"])).toEqual(DEFAULT_SETTINGS);
	});

	it("preserves valid boolean overrides, calendar color overrides, and holiday calendar keys while filling missing keys", () => {
		const validKey = buildCalendarColorKey("google", "work@example.com");
		const validHolidayKey = buildCalendarColorKey("ics", "us-holidays");
		expect(
			normalizeSettings({
				enableExternalCalendarCache: false,
				enableMonthDayQuickCreate: false,
				enableCustomCalendarColors: false,
				calendarColorOverrides: {
					[validKey]: "#ABC",
					"google:invalid-key": "#112233",
					[buildCalendarColorKey("microsoft", "bad")]: "not-hex",
				},
				enableVividChipColors: false,
				enableMonthChipLimit: false,
				enableMonthChipSpanning: false,
				enableWeekendHolidayColors: false,
				enableJapaneseHolidays: false,
				holidayCalendarKeys: [
					validHolidayKey,
					validHolidayKey,
					"ics:raw-id",
				],
			}),
		).toEqual({
			enableToolbarCalendarPicker: true,
			enableExternalCalendarCache: false,
			enableMobileMonthTap: true,
			enableMonthDayQuickCreate: false,
			enableCustomCalendarColors: false,
			calendarColorOverrides: {
				[validKey]: "#aabbcc",
			},
			enableVividChipColors: false,
			enableMonthChipLimit: false,
			enableMonthChipSpanning: false,
			enableWeekendHolidayColors: false,
			enableJapaneseHolidays: false,
			holidayCalendarKeys: [validHolidayKey],
		});
	});

	it("falls back to defaults when values are not expected types", () => {
		expect(
			normalizeSettings({
				enableToolbarCalendarPicker: "false",
				enableExternalCalendarCache: 0,
				enableMobileMonthTap: null,
				enableMonthDayQuickCreate: 1,
				enableCustomCalendarColors: "true",
				calendarColorOverrides: ["bad"],
				enableVividChipColors: "yes",
				enableMonthChipLimit: 0,
				enableMonthChipSpanning: "yes",
				enableWeekendHolidayColors: "yes",
				enableJapaneseHolidays: 0,
				holidayCalendarKeys: "not-array",
			}),
		).toEqual(DEFAULT_SETTINGS);
	});

	it("strips unknown keys and returns fresh nested collections", () => {
		const raw = {
			enableToolbarCalendarPicker: false,
			unexpectedKey: "should-be-dropped",
			cachedEvents: [{ summary: "secret" }],
		};

		const normalized = normalizeSettings(raw);
		expect(normalized).toEqual({
			enableToolbarCalendarPicker: false,
			enableExternalCalendarCache: true,
			enableMobileMonthTap: true,
			enableMonthDayQuickCreate: true,
			enableCustomCalendarColors: true,
			calendarColorOverrides: {},
			enableVividChipColors: true,
			enableMonthChipLimit: true,
			enableMonthChipSpanning: true,
			enableWeekendHolidayColors: true,
			enableJapaneseHolidays: true,
			holidayCalendarKeys: [],
		});
		expect("unexpectedKey" in normalized).toBe(false);
		expect("cachedEvents" in normalized).toBe(false);

		normalized.enableExternalCalendarCache = false;
		expect(DEFAULT_SETTINGS.enableExternalCalendarCache).toBe(true);
	});

	it("renders all toggles including weekend/holiday options and handles color & holiday updates cleanly", async () => {
		const settingNames: string[] = [];
		const toggleHandlers: Array<(value: boolean) => unknown> = [];
		const colorHandlers: Array<(value: string) => unknown> = [];
		const extraResetHandlers: Array<() => unknown> = [];
		const buttonHandlers: Array<(evt: MouseEvent) => unknown> = [];

		vi.spyOn(Setting.prototype, "setName").mockImplementation(function (
			this: Setting,
			name: string | DocumentFragment,
		) {
			if (typeof name === "string") {
				settingNames.push(name);
			}
			return this;
		});
		const setDescSpy = vi.spyOn(Setting.prototype, "setDesc");
		vi.spyOn(ToggleComponent.prototype, "onChange").mockImplementation(function (
			this: ToggleComponent,
			cb: (value: boolean) => unknown,
		) {
			toggleHandlers.push(cb);
			return this;
		});
		vi.spyOn(ColorComponent.prototype, "onChange").mockImplementation(function (
			this: ColorComponent,
			cb: (value: string) => unknown,
		) {
			colorHandlers.push(cb);
			return this;
		});
		vi.spyOn(ExtraButtonComponent.prototype, "onClick").mockImplementation(function (
			this: ExtraButtonComponent,
			cb: () => unknown,
		) {
			extraResetHandlers.push(cb);
			return this;
		});
		vi.spyOn(ButtonComponent.prototype, "onClick").mockImplementation(function (
			this: ButtonComponent,
			cb: (evt: MouseEvent) => unknown,
		) {
			buttonHandlers.push(cb);
			return this;
		});

		const app = new App();
		(app as unknown as { plugins: { plugins: Record<string, unknown> } }).plugins = {
			plugins: {
				tasknotes: {
					microsoftCalendarService: {
						getAvailableCalendars: () => [
							{ id: "ms-1", summary: "Outlook", backgroundColor: "#0078d4" },
						],
					},
				},
			},
		};

		const saveSettings = vi.fn(() => Promise.resolve());
		const applyFeatureStates = vi.fn();
		const setCalendarColorOverride = vi.fn(() => Promise.resolve());
		const clearAllCalendarColorOverrides = vi.fn(() => Promise.resolve());
		const setHolidayCalendarSelected = vi.fn(() => Promise.resolve());
		const host: SettingsPluginHost = {
			settings: {
				...DEFAULT_SETTINGS,
				calendarColorOverrides: {},
				holidayCalendarKeys: [],
			},
			saveSettings,
			applyFeatureStates,
			clearCalendarCache: () => Promise.resolve(),
			setCalendarColorOverride,
			clearAllCalendarColorOverrides,
			setHolidayCalendarSelected,
		};

		const tabInstance = new TaskNotesCalendarEnhancerSettingTab(
			app,
			host as unknown as Plugin & SettingsPluginHost,
		);
		const emptySpy = vi.spyOn(tabInstance.containerEl, "empty");
		const tab = tabInstance as unknown as DisplayableTab;
		tab.display();

		// 9 main feature toggles + 1 built-in Japanese holidays toggle + 1 external holiday calendar toggle
		expect(toggleHandlers).toHaveLength(11);
		expect(settingNames).toContain("Vivid month chip colors");
		expect(settingNames).toContain("Limit month chips to 4 events");
		expect(settingNames).toContain("Span multi-day events in month chips");
		expect(settingNames).toContain("Weekend & holiday colors");
		expect(settingNames).toContain("Built-in Japanese holidays");
		expect(settingNames).toContain("Custom calendar colors");
		expect(settingNames).toContain("Outlook");
		expect(colorHandlers).toHaveLength(1);
		expect(extraResetHandlers).toHaveLength(1);
		expect(emptySpy).toHaveBeenCalledTimes(1);

		const containerNode = tabInstance.containerEl as unknown as HTMLDivElement;
		const disclosure = containerNode.querySelector<HTMLDetailsElement>(
			"details.tnce-settings-disclosure",
		);
		const disclosureCount = containerNode.querySelector<HTMLElement>(
			".tnce-settings-disclosure-count",
		);
		expect(disclosure).not.toBeNull();
		expect(disclosure?.open).toBe(false);
		expect(disclosureCount?.textContent).toBe("1 available");

		// Selecting external holiday calendar invokes setHolidayCalendarSelected and updates summary in-place
		toggleHandlers[10]?.(true);
		await Promise.resolve();
		expect(setHolidayCalendarSelected).toHaveBeenCalledWith("microsoft", "ms-1", true);
		expect(disclosureCount?.textContent).toBe("1 of 1 selected");
		expect(emptySpy).toHaveBeenCalledTimes(1);

		// Dragging/changing the color picker updates in-place without re-rendering.
		colorHandlers[0]?.("#e05252");
		await Promise.resolve();
		expect(setCalendarColorOverride).toHaveBeenCalledWith("microsoft", "ms-1", "#e05252");
		expect(setDescSpy).toHaveBeenCalledWith("Microsoft Calendar — Custom (#e05252)");
		expect(emptySpy).toHaveBeenCalledTimes(1);

		// Reset button clears override and re-renders.
		extraResetHandlers[0]?.();
		await Promise.resolve();
		await Promise.resolve();
		expect(setCalendarColorOverride).toHaveBeenCalledWith("microsoft", "ms-1", null);
		expect(emptySpy).toHaveBeenCalledTimes(2);

		// Reset all colors button invokes clearAllCalendarColorOverrides.
		const resetAllBtnHandler = buttonHandlers[buttonHandlers.length - 1];
		resetAllBtnHandler?.({} as MouseEvent);
		await Promise.resolve();
		await Promise.resolve();
		expect(clearAllCalendarColorOverrides).toHaveBeenCalledTimes(1);

		const quickCreateHandler = toggleHandlers[3];
		if (!quickCreateHandler) {
			throw new Error("Expected quick create toggle handler");
		}
		quickCreateHandler(false);
		await Promise.resolve();
		await Promise.resolve();

		expect(host.settings.enableMonthDayQuickCreate).toBe(false);
		expect(saveSettings).toHaveBeenCalledTimes(1);
		expect(applyFeatureStates).toHaveBeenCalledTimes(1);
	});
});
