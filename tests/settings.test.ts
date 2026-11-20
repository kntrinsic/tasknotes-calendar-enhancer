import { App, type Plugin, Setting, ToggleComponent } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
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
		});
	});

	it("returns defaults for non-object raw inputs", () => {
		expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
		expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
		expect(normalizeSettings("invalid")).toEqual(DEFAULT_SETTINGS);
		expect(normalizeSettings(42)).toEqual(DEFAULT_SETTINGS);
		expect(normalizeSettings(["enableToolbarCalendarPicker"])).toEqual(DEFAULT_SETTINGS);
	});

	it("preserves valid boolean overrides while filling missing keys", () => {
		expect(
			normalizeSettings({
				enableExternalCalendarCache: false,
				enableMonthDayQuickCreate: false,
			}),
		).toEqual({
			enableToolbarCalendarPicker: true,
			enableExternalCalendarCache: false,
			enableMobileMonthTap: true,
			enableMonthDayQuickCreate: false,
		});
	});

	it("falls back to defaults when values are not booleans", () => {
		expect(
			normalizeSettings({
				enableToolbarCalendarPicker: "false",
				enableExternalCalendarCache: 0,
				enableMobileMonthTap: null,
				enableMonthDayQuickCreate: 1,
			}),
		).toEqual(DEFAULT_SETTINGS);
	});

	it("strips unknown keys and returns a fresh object", () => {
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
		});
		expect("unexpectedKey" in normalized).toBe(false);
		expect("cachedEvents" in normalized).toBe(false);

		normalized.enableExternalCalendarCache = false;
		expect(DEFAULT_SETTINGS.enableExternalCalendarCache).toBe(true);
	});

	it("renders all toggles including month view quick create and applies updates", async () => {
		const settingNames: string[] = [];
		const toggleHandlers: Array<(value: boolean) => unknown> = [];

		vi.spyOn(Setting.prototype, "setName").mockImplementation(function (
			this: Setting,
			name: string | DocumentFragment,
		) {
			if (typeof name === "string") {
				settingNames.push(name);
			}
			return this;
		});
		vi.spyOn(ToggleComponent.prototype, "onChange").mockImplementation(function (
			this: ToggleComponent,
			cb: (value: boolean) => unknown,
		) {
			toggleHandlers.push(cb);
			return this;
		});

		const saveSettings = vi.fn(() => Promise.resolve());
		const applyFeatureStates = vi.fn();
		const host: SettingsPluginHost = {
			settings: { ...DEFAULT_SETTINGS },
			saveSettings,
			applyFeatureStates,
			clearCalendarCache: () => Promise.resolve(),
		};

		const tab = new TaskNotesCalendarEnhancerSettingTab(
			new App(),
			host as unknown as Plugin & SettingsPluginHost,
		) as unknown as DisplayableTab;
		tab.display();

		expect(toggleHandlers).toHaveLength(4);
		expect(settingNames).toContain("Month view quick create (right-click / long-press)");

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
