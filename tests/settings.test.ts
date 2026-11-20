import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, normalizeSettings } from "../src/settings";

describe("settings", () => {
	it("enables all three features by default", () => {
		expect(DEFAULT_SETTINGS).toEqual({
			enableToolbarCalendarPicker: true,
			enableExternalCalendarCache: true,
			enableMobileMonthTap: true,
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
			}),
		).toEqual({
			enableToolbarCalendarPicker: true,
			enableExternalCalendarCache: false,
			enableMobileMonthTap: true,
		});
	});

	it("falls back to defaults when values are not booleans", () => {
		expect(
			normalizeSettings({
				enableToolbarCalendarPicker: "false",
				enableExternalCalendarCache: 0,
				enableMobileMonthTap: null,
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
		});
		expect("unexpectedKey" in normalized).toBe(false);
		expect("cachedEvents" in normalized).toBe(false);

		normalized.enableExternalCalendarCache = false;
		expect(DEFAULT_SETTINGS.enableExternalCalendarCache).toBe(true);
	});
});
