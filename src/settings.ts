import {
	type App,
	type ButtonComponent,
	type ExtraButtonComponent,
	Notice,
	type Plugin,
	PluginSettingTab,
	Setting,
} from "obsidian";
import {
	buildCalendarColorKey,
	getDefaultProviderColor,
	normalizeHexColor,
	sanitizeCalendarColorOverrides,
} from "./calendarColorOverrides";
import {
	type ExternalCalendarProviderId,
	getExternalCalendarSnapshot,
} from "./tasknotesBridge";
import { sanitizeHolidayCalendarKeys } from "./weekendHolidayHighlighter";

/**
 * Persisted settings for TaskNotes Calendar Enhancer.
 * Stores feature toggles and hashed keys; external calendar events must never be stored here.
 */
export interface TaskNotesCalendarEnhancerSettings {
	enableToolbarCalendarPicker: boolean;
	enableExternalCalendarCache: boolean;
	enableMobileMonthTap: boolean;
	enableMonthDayQuickCreate: boolean;
	enableCustomCalendarColors: boolean;
	calendarColorOverrides: Record<string, string>;
	enableVividChipColors: boolean;
	enableMonthChipLimit: boolean;
	enableMonthChipSpanning: boolean;
	enableWeekendHolidayColors: boolean;
	enableJapaneseHolidays: boolean;
	holidayCalendarKeys: string[];
}

type BooleanSettingKey =
	| "enableToolbarCalendarPicker"
	| "enableExternalCalendarCache"
	| "enableMobileMonthTap"
	| "enableMonthDayQuickCreate"
	| "enableCustomCalendarColors"
	| "enableVividChipColors"
	| "enableMonthChipLimit"
	| "enableMonthChipSpanning"
	| "enableWeekendHolidayColors"
	| "enableJapaneseHolidays";

export const DEFAULT_SETTINGS: Readonly<TaskNotesCalendarEnhancerSettings> = {
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
};

/**
 * Minimal plugin interface needed by the settings tab to avoid circular imports.
 */
export interface SettingsPluginHost {
	settings: TaskNotesCalendarEnhancerSettings;
	saveSettings(): Promise<void>;
	applyFeatureStates(): void;
	clearCalendarCache(): Promise<void>;
	setCalendarColorOverride(
		provider: ExternalCalendarProviderId,
		calendarId: string,
		hexColor: string | null,
	): Promise<void>;
	clearAllCalendarColorOverrides(): Promise<void>;
	setHolidayCalendarSelected(
		provider: ExternalCalendarProviderId,
		calendarId: string,
		selected: boolean,
	): Promise<void>;
}

/**
 * Sanitizes raw persisted plugin data into valid settings with defaults.
 */
export function normalizeSettings(raw: unknown): TaskNotesCalendarEnhancerSettings {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return {
			...DEFAULT_SETTINGS,
			calendarColorOverrides: {},
			holidayCalendarKeys: [],
		};
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
		enableCustomCalendarColors:
			typeof record.enableCustomCalendarColors === "boolean"
				? record.enableCustomCalendarColors
				: DEFAULT_SETTINGS.enableCustomCalendarColors,
		calendarColorOverrides: sanitizeCalendarColorOverrides(record.calendarColorOverrides),
		enableVividChipColors:
			typeof record.enableVividChipColors === "boolean"
				? record.enableVividChipColors
				: DEFAULT_SETTINGS.enableVividChipColors,
		enableMonthChipLimit:
			typeof record.enableMonthChipLimit === "boolean"
				? record.enableMonthChipLimit
				: DEFAULT_SETTINGS.enableMonthChipLimit,
		enableMonthChipSpanning:
			typeof record.enableMonthChipSpanning === "boolean"
				? record.enableMonthChipSpanning
				: DEFAULT_SETTINGS.enableMonthChipSpanning,
		enableWeekendHolidayColors:
			typeof record.enableWeekendHolidayColors === "boolean"
				? record.enableWeekendHolidayColors
				: DEFAULT_SETTINGS.enableWeekendHolidayColors,
		enableJapaneseHolidays:
			typeof record.enableJapaneseHolidays === "boolean"
				? record.enableJapaneseHolidays
				: DEFAULT_SETTINGS.enableJapaneseHolidays,
		holidayCalendarKeys: sanitizeHolidayCalendarKeys(record.holidayCalendarKeys),
	};
}

/**
 * Settings UI providing independent toggles, cache clearing, custom calendar colors, and weekend/holiday options.
 */
export class TaskNotesCalendarEnhancerSettingTab extends PluginSettingTab {
	private readonly plugin: SettingsPluginHost;

	constructor(app: App, plugin: Plugin & SettingsPluginHost) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		this.render();
	}

	private render(): void {
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
			.setName("Custom calendar colors")
			.setDesc(
				"Override display colors for Google, Microsoft, and ICS calendars in TaskNotes.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableCustomCalendarColors)
					.onChange((value) => {
						this.updateToggleSetting("enableCustomCalendarColors", value, {
							rerender: true,
						});
					}),
			);

		new Setting(containerEl)
			.setName("Vivid month chip colors")
			.setDesc(
				"Increase calendar color contrast and add a leading color bar on month chips so calendars stay distinguishable on mobile and narrow screens.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableVividChipColors)
					.onChange((value) => {
						this.updateToggleSetting("enableVividChipColors", value);
					}),
			);

		new Setting(containerEl)
			.setName("Limit month chips to 4 events")
			.setDesc(
				"Show “+N” on month chips whenever a day has 5 or more events (maximum 4 events displayed directly).",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableMonthChipLimit)
					.onChange((value) => {
						this.updateToggleSetting("enableMonthChipLimit", value);
					}),
			);

		new Setting(containerEl)
			.setName("Span multi-day events in month chips")
			.setDesc(
				"Connect multi-day events across consecutive days in narrow month chip view, matching full month view.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableMonthChipSpanning)
					.onChange((value) => {
						this.updateToggleSetting("enableMonthChipSpanning", value);
					}),
			);

		new Setting(containerEl)
			.setName("Weekend & holiday colors")
			.setDesc(
				"Color Saturday dates/headers blue and Sunday/holiday dates red with holiday name tooltips.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableWeekendHolidayColors)
					.onChange((value) => {
						this.updateToggleSetting("enableWeekendHolidayColors", value, {
							rerender: true,
						});
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

		if (this.plugin.settings.enableWeekendHolidayColors) {
			this.renderWeekendHolidaySection(containerEl);
		}

		if (this.plugin.settings.enableCustomCalendarColors) {
			this.renderCalendarColorsSection(containerEl);
		}
	}

	private renderWeekendHolidaySection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Weekend & holiday sources").setHeading();

		new Setting(containerEl)
			.setName("Built-in Japanese holidays")
			.setDesc(
				"Highlight Japanese national holidays offline (includes equinoxes, Happy Mondays, substitute holidays, and citizens' holidays).",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableJapaneseHolidays)
					.onChange((value) => {
						this.updateToggleSetting("enableJapaneseHolidays", value);
					}),
			);

		const snapshot = getExternalCalendarSnapshot(this.app);
		const selectedKeys = new Set(this.plugin.settings.holidayCalendarKeys);
		const totalCount = snapshot.groups.reduce((sum, group) => sum + group.items.length, 0);

		const doc = containerEl.ownerDocument;
		const detailsEl = doc.createElement("details");
		detailsEl.className = "tnce-settings-disclosure";

		const summaryEl = doc.createElement("summary");
		summaryEl.className = "tnce-settings-disclosure-summary";

		const titleEl = doc.createElement("span");
		titleEl.className = "tnce-settings-disclosure-title";
		titleEl.textContent = "External holiday calendars";

		const countEl = doc.createElement("span");
		countEl.className = "tnce-settings-disclosure-count";

		const updateCountLabel = (): void => {
			if (totalCount === 0) {
				countEl.textContent = "None loaded";
				return;
			}
			let selectedCount = 0;
			for (const group of snapshot.groups) {
				for (const item of group.items) {
					if (selectedKeys.has(buildCalendarColorKey(item.provider, item.id))) {
						selectedCount += 1;
					}
				}
			}
			countEl.textContent =
				selectedCount > 0
					? `${String(selectedCount)} of ${String(totalCount)} selected`
					: `${String(totalCount)} available`;
		};
		updateCountLabel();

		summaryEl.append(titleEl, countEl);
		detailsEl.appendChild(summaryEl);

		const bodyEl = doc.createElement("div");
		bodyEl.className = "tnce-settings-disclosure-body";
		detailsEl.appendChild(bodyEl);
		containerEl.appendChild(detailsEl);

		if (totalCount === 0) {
			new Setting(bodyEl)
				.setName("No external holiday calendars available")
				.setDesc(
					"Connect a holiday calendar in TaskNotes (Google, Microsoft, or ICS) to highlight worldwide or custom holidays here without extra network requests.",
				);
			return;
		}

		for (const group of snapshot.groups) {
			for (const item of group.items) {
				const key = buildCalendarColorKey(item.provider, item.id);
				new Setting(bodyEl)
					.setName(item.name)
					.setDesc(`${group.title} — Treat events on this calendar as holidays`)
					.addToggle((toggle) =>
						toggle.setValue(selectedKeys.has(key)).onChange((value) => {
							if (value) {
								selectedKeys.add(key);
							} else {
								selectedKeys.delete(key);
							}
							updateCountLabel();
							void this.persistHolidayCalendarSelected(
								item.provider,
								item.id,
								value,
							);
						}),
					);
			}
		}
	}

	private renderCalendarColorsSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Calendar colors").setHeading();

		const snapshot = getExternalCalendarSnapshot(this.app);
		const resetAllRef: { button: ButtonComponent | null } = { button: null };

		if (snapshot.groups.length === 0) {
			new Setting(containerEl)
				.setName("No external calendars loaded")
				.setDesc(
					"Connect Google, Microsoft, or ICS calendars in TaskNotes to customize their colors here or from the Bases toolbar Calendars menu.",
				);
		} else {
			for (const group of snapshot.groups) {
				for (const item of group.items) {
					const overrideKey = buildCalendarColorKey(item.provider, item.id);
					const overrideColor = normalizeHexColor(
						this.plugin.settings.calendarColorOverrides[overrideKey],
					);
					const initialHex =
						overrideColor ??
						normalizeHexColor(item.color) ??
						getDefaultProviderColor(item.provider);

					const rowResetRef: { button: ExtraButtonComponent | null } = { button: null };
					const rowSetting = new Setting(containerEl)
						.setName(item.name)
						.setDesc(
							overrideColor
								? `${group.title} — Custom (${overrideColor})`
								: `${group.title} — Default`,
						);

					rowSetting
						.addColorPicker((picker) =>
							picker.setValue(initialHex).onChange((value) => {
								const normalized = normalizeHexColor(value);
								if (!normalized) {
									return;
								}
								// Update metadata in-place without re-rendering so an open native picker stays active.
								rowSetting.setDesc(`${group.title} — Custom (${normalized})`);
								rowResetRef.button?.setDisabled(false);
								resetAllRef.button?.setDisabled(false);
								void this.persistCalendarColorOverride(
									item.provider,
									item.id,
									normalized,
								);
							}),
						)
						.addExtraButton((btn) => {
							rowResetRef.button = btn;
							btn.setIcon("rotate-ccw")
								.setTooltip("Reset to default color")
								.setDisabled(overrideColor === null)
								.onClick(() => {
									void this.handleResetCalendarColor(item.provider, item.id);
								});
						});
				}
			}
		}

		const hasOverrides = Object.keys(this.plugin.settings.calendarColorOverrides).length > 0;
		new Setting(containerEl)
			.setName("Reset all custom calendar colors")
			.setDesc("Restore original TaskNotes calendar colors for all calendars.")
			.addButton((button) => {
				resetAllRef.button = button;
				button
					.setButtonText("Reset all colors")
					.setDestructive()
					.setDisabled(!hasOverrides)
					.onClick(() => {
						void this.handleResetAllCalendarColors();
					});
			});
	}

	private updateToggleSetting(
		key: BooleanSettingKey,
		value: boolean,
		options?: { rerender?: boolean },
	): void {
		this.plugin.settings[key] = value;
		void (async () => {
			try {
				await this.plugin.saveSettings();
				this.plugin.applyFeatureStates();
				if (options?.rerender) {
					this.render();
				}
			} catch (error) {
				console.error("Failed to save TaskNotes Calendar Enhancer settings:", error);
				new Notice("TaskNotes Calendar Enhancer: failed to save settings.");
			}
		})();
	}

	private async persistHolidayCalendarSelected(
		provider: ExternalCalendarProviderId,
		calendarId: string,
		selected: boolean,
	): Promise<void> {
		try {
			await this.plugin.setHolidayCalendarSelected(provider, calendarId, selected);
		} catch (error) {
			console.error("Failed to save holiday calendar selection:", error);
			new Notice("TaskNotes Calendar Enhancer: failed to save holiday calendar selection.");
		}
	}

	private async persistCalendarColorOverride(
		provider: ExternalCalendarProviderId,
		calendarId: string,
		hexColor: string,
	): Promise<void> {
		try {
			await this.plugin.setCalendarColorOverride(provider, calendarId, hexColor);
		} catch (error) {
			console.error("Failed to save custom calendar color:", error);
			new Notice("TaskNotes Calendar Enhancer: failed to save custom calendar color.");
		}
	}

	private async handleResetCalendarColor(
		provider: ExternalCalendarProviderId,
		calendarId: string,
	): Promise<void> {
		try {
			await this.plugin.setCalendarColorOverride(provider, calendarId, null);
			this.render();
		} catch (error) {
			console.error("Failed to reset calendar color:", error);
			new Notice("TaskNotes Calendar Enhancer: failed to reset calendar color.");
		}
	}

	private async handleResetAllCalendarColors(): Promise<void> {
		try {
			await this.plugin.clearAllCalendarColorOverrides();
			this.render();
			new Notice("TaskNotes Calendar Enhancer: custom calendar colors reset.");
		} catch (error) {
			console.error("Failed to reset custom calendar colors:", error);
			new Notice("TaskNotes Calendar Enhancer: failed to reset custom calendar colors.");
		}
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
