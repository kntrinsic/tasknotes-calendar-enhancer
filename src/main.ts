import { Plugin } from "obsidian";
import {
	DEFAULT_SETTINGS,
	normalizeSettings,
	type SettingsPluginHost,
	type TaskNotesCalendarEnhancerSettings,
	TaskNotesCalendarEnhancerSettingTab,
} from "./settings";
import { MobileMonthTapController } from "./mobileMonthTap";
import { ToolbarCalendarPicker } from "./toolbarCalendarPicker";

/**
 * Companion plugin extending TaskNotes without modifying upstream files.
 */
export default class TaskNotesCalendarEnhancerPlugin
	extends Plugin
	implements SettingsPluginHost
{
	settings: TaskNotesCalendarEnhancerSettings = { ...DEFAULT_SETTINGS };
	private isLoaded = false;
	private toolbarCalendarPicker: ToolbarCalendarPicker | null = null;
	private mobileMonthTap: MobileMonthTapController | null = null;

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

		if (this.settings.enableToolbarCalendarPicker) {
			this.toolbarCalendarPicker ??= new ToolbarCalendarPicker(this.app);
			this.toolbarCalendarPicker.enable();
		} else {
			this.toolbarCalendarPicker?.disable();
		}

		if (this.settings.enableMobileMonthTap) {
			this.mobileMonthTap ??= new MobileMonthTapController(this.app);
			this.mobileMonthTap.enable();
		} else {
			this.mobileMonthTap?.disable();
		}
	}

	clearCalendarCache(): Promise<void> {
		// Phase 4 will remove device-local external calendar cache entries here.
		return Promise.resolve();
	}

	private teardownFeatures(): void {
		// Never call Bases config.set() inside onunload() (Bases #1397).
		this.toolbarCalendarPicker?.disable();
		this.toolbarCalendarPicker = null;
		this.mobileMonthTap?.disable();
		this.mobileMonthTap = null;
	}
}
