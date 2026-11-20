import { type App, Notice, type Plugin, PluginSettingTab, Setting } from "obsidian";

/**
 * Persisted settings for TaskNotes Calendar Enhancer.
 * Stores only feature toggles; external calendar events must never be stored here.
 */
export interface TaskNotesCalendarEnhancerSettings {
	enableToolbarCalendarPicker: boolean;
	enableExternalCalendarCache: boolean;
	enableMobileMonthTap: boolean;
	enableMonthDayQuickCreate: boolean;
}

export const DEFAULT_SETTINGS: Readonly<TaskNotesCalendarEnhancerSettings> = {
	enableToolbarCalendarPicker: true,
	enableExternalCalendarCache: true,
	enableMobileMonthTap: true,
	enableMonthDayQuickCreate: true,
};

/**
 * Minimal plugin interface needed by the settings tab to avoid circular imports.
 */
export interface SettingsPluginHost {
	settings: TaskNotesCalendarEnhancerSettings;
	saveSettings(): Promise<void>;
	applyFeatureStates(): void;
	clearCalendarCache(): Promise<void>;
}

/**
 * Sanitizes raw persisted plugin data into valid settings with defaults.
 */
export function normalizeSettings(raw: unknown): TaskNotesCalendarEnhancerSettings {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { ...DEFAULT_SETTINGS };
	}

	const record = raw as Record<string, unknown>;
	return {
		enableToolbarCalendarPicker:
			typeof record.enableToolbarCalendarPicker === "boolean"
				? record.enableToolbarCalendarPicker
				: DEFAULT_SETTINGS.enableToolbarCalendarPicker,
		enableExternalCalendarCache:
			typeof record.enableExternalCalendarCache === "boolean"
				? record.enableExternalCalendarCache
				: DEFAULT_SETTINGS.enableExternalCalendarCache,
		enableMobileMonthTap:
			typeof record.enableMobileMonthTap === "boolean"
				? record.enableMobileMonthTap
				: DEFAULT_SETTINGS.enableMobileMonthTap,
		enableMonthDayQuickCreate:
			typeof record.enableMonthDayQuickCreate === "boolean"
				? record.enableMonthDayQuickCreate
				: DEFAULT_SETTINGS.enableMonthDayQuickCreate,
	};
}

/**
 * Settings UI providing independent toggles for each companion feature and cache clearing.
 */
export class TaskNotesCalendarEnhancerSettingTab extends PluginSettingTab {
	private readonly plugin: SettingsPluginHost;

	constructor(app: App, plugin: Plugin & SettingsPluginHost) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Bases toolbar calendar picker")
			.setDesc("Add a quick calendar visibility toggle button to the Obsidian Bases toolbar.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableToolbarCalendarPicker)
					.onChange((value) => {
						this.updateToggleSetting("enableToolbarCalendarPicker", value);
					}),
			);

		new Setting(containerEl)
			.setName("External calendar startup cache")
			.setDesc(
				"Show cached external calendars immediately at startup on this device until background sync completes.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableExternalCalendarCache)
					.onChange((value) => {
						this.updateToggleSetting("enableExternalCalendarCache", value);
					}),
			);

		new Setting(containerEl)
			.setName("Mobile month view tap details")
			.setDesc(
				"Allow tapping event chips or compact indicators in narrow month views to open details.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableMobileMonthTap)
					.onChange((value) => {
						this.updateToggleSetting("enableMobileMonthTap", value);
					}),
			);

		new Setting(containerEl)
			.setName("Month view quick create (right-click / long-press)")
			.setDesc(
				"Right-click (desktop) or long-press (mobile) a day cell in month view to open TaskNotes' creation menu.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableMonthDayQuickCreate)
					.onChange((value) => {
						this.updateToggleSetting("enableMonthDayQuickCreate", value);
					}),
			);

		new Setting(containerEl)
			.setName("Clear calendar cache")
			.setDesc("Remove all locally cached external calendar events from this device.")
			.addButton((button) =>
				button
					.setButtonText("Clear calendar cache")
					.setDestructive()
					.onClick(() => {
						void this.handleClearCache();
					}),
			);
	}

	private updateToggleSetting(
		key: keyof TaskNotesCalendarEnhancerSettings,
		value: boolean,
	): void {
		this.plugin.settings[key] = value;
		void (async () => {
			try {
				await this.plugin.saveSettings();
				this.plugin.applyFeatureStates();
			} catch (error) {
				console.error("Failed to save TaskNotes Calendar Enhancer settings:", error);
				new Notice("TaskNotes Calendar Enhancer: failed to save settings.");
			}
		})();
	}

	private async handleClearCache(): Promise<void> {
		try {
			await this.plugin.clearCalendarCache();
			new Notice("TaskNotes Calendar Enhancer: calendar cache cleared.");
		} catch (error) {
			console.error("Failed to clear calendar cache:", error);
			new Notice("TaskNotes Calendar Enhancer: failed to clear calendar cache.");
		}
	}
}
