import { Notice, Plugin } from "obsidian";
import {
	buildCalendarColorKey,
	CalendarColorOverridesController,
	MAX_CALENDAR_COLOR_OVERRIDES,
	normalizeHexColor,
} from "./calendarColorOverrides";
import {
	clearAllExternalCalendarCacheStorage,
	ExternalCalendarCacheController,
} from "./externalCalendarCache";
import { MobileMonthTapController } from "./mobileMonthTap";
import { MonthChipLimitController } from "./monthChipLimit";
import { MonthChipSpanningController } from "./monthChipSpanning";
import { MonthDayQuickCreateController } from "./monthDayQuickCreate";
import {
	DEFAULT_SETTINGS,
	normalizeSettings,
	type SettingsPluginHost,
	type TaskNotesCalendarEnhancerSettings,
	TaskNotesCalendarEnhancerSettingTab,
} from "./settings";
import type { ExternalCalendarProviderId } from "./tasknotesBridge";
import { ToolbarCalendarPicker } from "./toolbarCalendarPicker";
import {
	MAX_HOLIDAY_CALENDAR_KEYS,
	WeekendHolidayHighlighter,
} from "./weekendHolidayHighlighter";

export const VIVID_CHIP_COLORS_BODY_CLASS = "tnce-vivid-chip-colors";

/**
 * Companion plugin extending TaskNotes without modifying upstream files.
 */
export default class TaskNotesCalendarEnhancerPlugin
	extends Plugin
	implements SettingsPluginHost
{
	settings: TaskNotesCalendarEnhancerSettings = {
		...DEFAULT_SETTINGS,
		calendarColorOverrides: {},
		holidayCalendarKeys: [],
	};
	private isLoaded = false;
	private externalCalendarCache: ExternalCalendarCacheController | null = null;
	private calendarColorOverrides: CalendarColorOverridesController | null = null;
	private toolbarCalendarPicker: ToolbarCalendarPicker | null = null;
	private mobileMonthTap: MobileMonthTapController | null = null;
	private monthChipLimit: MonthChipLimitController | null = null;
	private monthChipSpanning: MonthChipSpanningController | null = null;
	private monthDayQuickCreate: MonthDayQuickCreateController | null = null;
	private weekendHolidayHighlighter: WeekendHolidayHighlighter | null = null;

	async onload(): Promise<void> {
		this.isLoaded = true;
		await this.loadSettings();
		this.addSettingTab(new TaskNotesCalendarEnhancerSettingTab(this.app, this));
		this.applyFeatureStates();
	}

	onunload(): void {
		this.isLoaded = false;
		this.teardownFeatures();
	}

	async loadSettings(): Promise<void> {
		const rawData: unknown = await this.loadData();
		this.settings = normalizeSettings(rawData);
	}

	async saveSettings(): Promise<void> {
		const sanitized = normalizeSettings(this.settings);
		this.settings = sanitized;
		await this.saveData(sanitized);
	}

	applyFeatureStates(): void {
		if (!this.isLoaded) {
			return;
		}

		const wasCacheEnabled = this.externalCalendarCache?.isEnabled() ?? false;
		if (this.settings.enableExternalCalendarCache) {
			this.externalCalendarCache ??= new ExternalCalendarCacheController(this.app);
			this.externalCalendarCache.enable();
		} else {
			this.externalCalendarCache?.disable();
		}

		if (this.settings.enableCustomCalendarColors) {
			this.calendarColorOverrides ??= new CalendarColorOverridesController(
				this.app,
				() => this.settings.calendarColorOverrides,
			);
			if (!this.calendarColorOverrides.isEnabled()) {
				this.calendarColorOverrides.enable();
			} else if (!wasCacheEnabled && this.settings.enableExternalCalendarCache) {
				// Keep color overrides stacked cleanly above newly attached startup cache wrappers.
				this.calendarColorOverrides.reattach();
			}
		} else {
			this.calendarColorOverrides?.disable({ refreshViews: true });
		}

		if (this.settings.enableToolbarCalendarPicker) {
			this.toolbarCalendarPicker ??= new ToolbarCalendarPicker(this.app, {
				isEnabled: () => this.settings.enableCustomCalendarColors,
				getOverrideColor: (provider, calendarId) =>
					this.calendarColorOverrides?.getOverrideColor(provider, calendarId) ?? null,
				setColorOverride: (provider, calendarId, hexColor) =>
					this.setCalendarColorOverride(provider, calendarId, hexColor),
			});
			this.toolbarCalendarPicker.enable();
			this.toolbarCalendarPicker.syncAllToolbars();
		} else {
			this.toolbarCalendarPicker?.disable();
		}

		if (this.settings.enableMobileMonthTap) {
			this.mobileMonthTap ??= new MobileMonthTapController(this.app);
			this.mobileMonthTap.enable();
		} else {
			this.mobileMonthTap?.disable();
		}

		if (this.settings.enableMonthChipSpanning) {
			this.monthChipSpanning ??= new MonthChipSpanningController(this.app);
			this.monthChipSpanning.enable();
		} else {
			this.monthChipSpanning?.disable();
		}

		if (this.settings.enableMonthChipLimit) {
			this.monthChipLimit ??= new MonthChipLimitController(this.app);
			this.monthChipLimit.enable();
		} else {
			this.monthChipLimit?.disable();
		}

		if (this.settings.enableMonthDayQuickCreate) {
			this.monthDayQuickCreate ??= new MonthDayQuickCreateController(this.app);
			this.monthDayQuickCreate.enable();
		} else {
			this.monthDayQuickCreate?.disable();
		}

		if (this.settings.enableWeekendHolidayColors) {
			this.weekendHolidayHighlighter ??= new WeekendHolidayHighlighter(this.app, () => ({
				enableJapaneseHolidays: this.settings.enableJapaneseHolidays,
				holidayCalendarKeys: this.settings.holidayCalendarKeys,
			}));
			if (!this.weekendHolidayHighlighter.isEnabled()) {
				this.weekendHolidayHighlighter.enable();
			} else {
				this.weekendHolidayHighlighter.refresh();
			}
		} else {
			this.weekendHolidayHighlighter?.disable();
		}

		this.syncVividChipColorsClass(this.settings.enableVividChipColors);
	}

	async setCalendarColorOverride(
		provider: ExternalCalendarProviderId,
		calendarId: string,
		hexColor: string | null,
	): Promise<void> {
		if (!calendarId) {
			return;
		}

		const key = buildCalendarColorKey(provider, calendarId);
		let nextOverrides: Record<string, string>;
		if (hexColor === null) {
			nextOverrides = Object.fromEntries(
				Object.entries(this.settings.calendarColorOverrides).filter(
					([entryKey]) => entryKey !== key,
				),
			);
		} else {
			nextOverrides = { ...this.settings.calendarColorOverrides };
			const normalized = normalizeHexColor(hexColor);
			if (!normalized) {
				return;
			}
			if (
				!(key in nextOverrides) &&
				Object.keys(nextOverrides).length >= MAX_CALENDAR_COLOR_OVERRIDES
			) {
				new Notice("TaskNotes Calendar Enhancer: custom calendar color limit reached.");
				return;
			}
			nextOverrides[key] = normalized;
		}

		this.settings = normalizeSettings({
			...this.settings,
			calendarColorOverrides: nextOverrides,
		});
		this.calendarColorOverrides?.notifyOverridesChanged();
		this.toolbarCalendarPicker?.syncAllToolbars();
		await this.saveSettings();
	}

	async clearAllCalendarColorOverrides(): Promise<void> {
		this.settings = normalizeSettings({
			...this.settings,
			calendarColorOverrides: {},
		});
		this.calendarColorOverrides?.notifyOverridesChanged();
		this.toolbarCalendarPicker?.syncAllToolbars();
		await this.saveSettings();
	}

	async setHolidayCalendarSelected(
		provider: ExternalCalendarProviderId,
		calendarId: string,
		selected: boolean,
	): Promise<void> {
		if (!calendarId) {
			return;
		}

		const key = buildCalendarColorKey(provider, calendarId);
		const currentKeys = this.settings.holidayCalendarKeys;
		let nextKeys: string[];

		if (selected) {
			if (currentKeys.includes(key)) {
				return;
			}
			if (currentKeys.length >= MAX_HOLIDAY_CALENDAR_KEYS) {
				new Notice("TaskNotes Calendar Enhancer: holiday calendar limit reached.");
				return;
			}
			nextKeys = [...currentKeys, key];
		} else {
			nextKeys = currentKeys.filter((entry) => entry !== key);
		}

		this.settings = normalizeSettings({
			...this.settings,
			holidayCalendarKeys: nextKeys,
		});
		this.weekendHolidayHighlighter?.refresh();
		await this.saveSettings();
	}

	clearCalendarCache(): Promise<void> {
		this.externalCalendarCache?.clearAll();
		clearAllExternalCalendarCacheStorage(this.app);
		return Promise.resolve();
	}

	private teardownFeatures(): void {
		// Never call Bases config.set() inside onunload() (Bases #1397).
		this.syncVividChipColorsClass(false);
		this.weekendHolidayHighlighter?.disable();
		this.weekendHolidayHighlighter = null;
		this.toolbarCalendarPicker?.disable();
		this.toolbarCalendarPicker = null;
		this.mobileMonthTap?.disable();
		this.mobileMonthTap = null;
		this.monthChipLimit?.disable();
		this.monthChipLimit = null;
		this.monthChipSpanning?.disable();
		this.monthChipSpanning = null;
		this.monthDayQuickCreate?.disable();
		this.monthDayQuickCreate = null;
		this.calendarColorOverrides?.disable({ refreshViews: false });
		this.calendarColorOverrides = null;
		this.externalCalendarCache?.disable();
		this.externalCalendarCache = null;
	}

	private syncVividChipColorsClass(enabled: boolean): void {
		if (typeof document === "undefined") {
			return;
		}
		document.body.classList.toggle(VIVID_CHIP_COLORS_BODY_CLASS, enabled);
	}
}
