import { Plugin } from "obsidian";
import {
	DEFAULT_SETTINGS,
	normalizeSettings,
	type SettingsPluginHost,
	type TaskNotesCalendarEnhancerSettings,
	TaskNotesCalendarEnhancerSettingTab,
} from "./settings";

/**
 * Companion plugin extending TaskNotes without modifying upstream files.
 */
export default class TaskNotesCalendarEnhancerPlugin
	extends Plugin
	implements SettingsPluginHost
{
	settings: TaskNotesCalendarEnhancerSettings = { ...DEFAULT_SETTINGS };
	private isLoaded = false;

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
		// Phase 2-4 feature controllers will be synchronized here based on this.settings.
	}

	clearCalendarCache(): Promise<void> {
		// Phase 4 will remove device-local external calendar cache entries here.
		return Promise.resolve();
	}

	private teardownFeatures(): void {
		// Phase 2-4 cleanup hooks (DOM, listeners, observers, monkey patches).
		// Never call Bases config.set() inside onunload() (Bases #1397).
	}
}
