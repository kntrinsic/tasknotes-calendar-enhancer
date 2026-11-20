import { type App, type EventRef, setIcon } from "obsidian";
import {
	CALENDAR_COLOR_PRESETS,
	getDefaultProviderColor,
	normalizeHexColor,
} from "./calendarColorOverrides";
import {
	type CalendarViewHandle,
	type ExternalCalendarItem,
	type ExternalCalendarProviderId,
	type ExternalCalendarSnapshot,
	getActiveCalendarViews,
	getBasesLeafContainers,
	getExternalCalendarSnapshot,
	isTaskNotesAvailable,
	openTaskNotesSettings,
	subscribeExternalCalendarChanges,
} from "./tasknotesBridge";

export const TOOLBAR_BUTTON_WRAPPER_CLASS = "tnce-calendar-toggle-btn";
export const POPOVER_CLASS = "tnce-calendar-picker-popover";

const HEX_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const FUNC_COLOR_PATTERN = /^(?:rgb|rgba|hsl|hsla)\(\s*[0-9.+%\s,/-]+\s*\)$/i;

export interface ToolbarCalendarColorAdapter {
	isEnabled(): boolean;
	getOverrideColor(provider: ExternalCalendarProviderId, calendarId: string): string | null;
	setColorOverride(
		provider: ExternalCalendarProviderId,
		calendarId: string,
		hexColor: string | null,
	): Promise<void>;
}

interface InjectedToolbarButton {
	toolbarEl: HTMLElement;
	wrapperEl: HTMLDivElement;
	buttonEl: HTMLButtonElement;
	badgeEl: HTMLSpanElement;
	handle: CalendarViewHandle;
}

interface OpenPopoverState {
	toolbarEl: HTMLElement;
	buttonEl: HTMLButtonElement;
	popoverEl: HTMLDivElement;
	colorsEnabled: boolean;
	cleanup: () => void;
	syncControls: () => void;
}

/**
 * Validates untrusted calendar color strings before assigning them to CSS styles.
 */
export function sanitizeCssColor(color: string | undefined): string | null {
	if (!color) {
		return null;
	}
	const trimmed = color.trim();
	if (HEX_COLOR_PATTERN.test(trimmed) || FUNC_COLOR_PATTERN.test(trimmed)) {
		return trimmed;
	}
	return null;
}

function getAllItems(snapshot: ExternalCalendarSnapshot): ExternalCalendarItem[] {
	return snapshot.groups.flatMap((group) => group.items);
}

function applyDotColor(
	colorEl: HTMLElement,
	rawColor: string | undefined,
	isCustom: boolean,
): void {
	const safeColor = sanitizeCssColor(rawColor);
	if (safeColor) {
		colorEl.style.backgroundColor = safeColor;
		colorEl.classList.remove("is-default");
	} else {
		colorEl.style.backgroundColor = "";
		colorEl.classList.add("is-default");
	}
	colorEl.classList.toggle("is-custom", isCustom);
}

/**
 * Injects a quick external-calendar toggle button and popover into active Bases toolbars.
 */
export class ToolbarCalendarPicker {
	private readonly app: App;
	private readonly colorAdapter?: ToolbarCalendarColorAdapter;
	private enabled = false;
	private workspaceEventRefs: EventRef[] = [];
	private providerUnsubscribe: (() => void) | null = null;
	private observedContainers = new Map<HTMLElement, MutationObserver>();
	private injectedButtons = new Map<HTMLElement, InjectedToolbarButton>();
	private openPopoverState: OpenPopoverState | null = null;
	private syncTimer: number | null = null;
	private nextCheckboxId = 0;

	constructor(app: App, colorAdapter?: ToolbarCalendarColorAdapter) {
		this.app = app;
		this.colorAdapter = colorAdapter;
	}

	enable(): void {
		if (this.enabled) {
			return;
		}
		this.enabled = true;

		this.registerWorkspaceListeners();
		this.ensureProviderSubscription();

		const workspace = this.app.workspace as unknown as {
			onLayoutReady?: (cb: () => void) => void;
		};
		if (typeof workspace.onLayoutReady === "function") {
			workspace.onLayoutReady(() => {
				if (!this.enabled) {
					return;
				}
				this.ensureProviderSubscription();
				this.syncAllToolbars();
			});
		}

		this.syncAllToolbars();
	}

	disable(): void {
		if (!this.enabled && this.injectedButtons.size === 0 && !this.openPopoverState) {
			return;
		}
		this.enabled = false;

		this.closePopover();
		this.clearSyncTimer();
		this.disconnectAllObservers();
		this.unregisterWorkspaceListeners();
		this.clearProviderSubscription();
		this.removeAllInjectedButtons();
	}

	syncAllToolbars(): void {
		if (!this.enabled) {
			return;
		}

		this.ensureProviderSubscription();
		this.syncObservedContainers();

		const activeHandles = getActiveCalendarViews(this.app);
		const snapshot = getExternalCalendarSnapshot(this.app);
		const activeToolbars = new Set<HTMLElement>();

		for (const handle of activeHandles) {
			const toolbarEl = handle.toolbarEl;
			if (!toolbarEl) {
				continue;
			}
			activeToolbars.add(toolbarEl);
			this.upsertToolbarButton(toolbarEl, handle, snapshot);
		}

		for (const [toolbarEl, entry] of this.injectedButtons.entries()) {
			if (!activeToolbars.has(toolbarEl) || !toolbarEl.isConnected) {
				if (this.openPopoverState?.toolbarEl === toolbarEl) {
					this.closePopover();
				}
				entry.wrapperEl.remove();
				this.injectedButtons.delete(toolbarEl);
			}
		}

		const colorsEnabled = Boolean(this.colorAdapter?.isEnabled());
		if (this.openPopoverState) {
			if (
				!this.openPopoverState.buttonEl.isConnected ||
				!this.openPopoverState.toolbarEl.isConnected ||
				this.openPopoverState.colorsEnabled !== colorsEnabled
			) {
				this.closePopover();
			} else {
				this.openPopoverState.syncControls();
			}
		}
	}

	private registerWorkspaceListeners(): void {
		const workspace = this.app.workspace as unknown as {
			on?: (name: string, cb: () => void) => EventRef;
		};
		if (typeof workspace.on !== "function") {
			return;
		}
		this.workspaceEventRefs.push(
			workspace.on("layout-change", () => {
				this.scheduleSync();
			}),
			workspace.on("active-leaf-change", () => {
				this.scheduleSync();
			}),
		);
	}

	private unregisterWorkspaceListeners(): void {
		const workspace = this.app.workspace as unknown as {
			offref?: (ref: EventRef) => void;
		};
		for (const ref of this.workspaceEventRefs) {
			try {
				if (typeof workspace.offref === "function") {
					workspace.offref(ref);
				}
			} catch {
				// Ignore teardown errors.
			}
		}
		this.workspaceEventRefs = [];
	}

	private ensureProviderSubscription(): void {
		if (this.providerUnsubscribe || !isTaskNotesAvailable(this.app)) {
			return;
		}
		this.providerUnsubscribe = subscribeExternalCalendarChanges(this.app, () => {
			this.scheduleSync();
		});
	}

	private clearProviderSubscription(): void {
		if (this.providerUnsubscribe) {
			this.providerUnsubscribe();
			this.providerUnsubscribe = null;
		}
	}

	private syncObservedContainers(): void {
		const activeContainers = new Set(getBasesLeafContainers(this.app));

		for (const [containerEl, observer] of this.observedContainers.entries()) {
			if (!activeContainers.has(containerEl) || !containerEl.isConnected) {
				observer.disconnect();
				this.observedContainers.delete(containerEl);
			}
		}

		if (typeof MutationObserver !== "function") {
			return;
		}

		for (const containerEl of activeContainers) {
			if (this.observedContainers.has(containerEl)) {
				continue;
			}
			const observer = new MutationObserver((mutations) => {
				if (!this.enabled || !this.hasRelevantMutation(mutations)) {
					return;
				}
				this.scheduleSync();
			});
			observer.observe(containerEl, { childList: true, subtree: true });
			this.observedContainers.set(containerEl, observer);
		}
	}

	private hasRelevantMutation(mutations: MutationRecord[]): boolean {
		for (const mutation of mutations) {
			if (mutation.type !== "childList") {
				continue;
			}
			const target = mutation.target as { closest?: (selector: string) => Element | null };
			if (
				typeof target.closest === "function" &&
				target.closest(`.${TOOLBAR_BUTTON_WRAPPER_CLASS}`)
			) {
				continue;
			}
			return true;
		}
		return false;
	}

	private disconnectAllObservers(): void {
		for (const observer of this.observedContainers.values()) {
			observer.disconnect();
		}
		this.observedContainers.clear();
	}

	private scheduleSync(): void {
		if (!this.enabled || this.syncTimer !== null) {
			return;
		}
		this.syncTimer = window.setTimeout(() => {
			this.syncTimer = null;
			this.syncAllToolbars();
		}, 0);
	}

	private clearSyncTimer(): void {
		if (this.syncTimer !== null) {
			window.clearTimeout(this.syncTimer);
			this.syncTimer = null;
		}
	}

	private removeAllInjectedButtons(): void {
		for (const entry of this.injectedButtons.values()) {
			entry.wrapperEl.remove();
		}
		this.injectedButtons.clear();
	}

	private upsertToolbarButton(
		toolbarEl: HTMLElement,
		handle: CalendarViewHandle,
		snapshot: ExternalCalendarSnapshot,
	): void {
		let entry = this.injectedButtons.get(toolbarEl);
		if (!entry) {
			// Remove stale wrappers left behind if the toolbar DOM was cloned or reloaded.
			for (const stale of toolbarEl.querySelectorAll(
				`:scope > .${TOOLBAR_BUTTON_WRAPPER_CLASS}`,
			)) {
				stale.remove();
			}
			entry = this.createToolbarButton(toolbarEl, handle);
			this.injectedButtons.set(toolbarEl, entry);
		} else {
			entry.handle = handle;
		}

		this.ensureButtonPlacement(toolbarEl, entry.wrapperEl);
		this.updateButtonBadge(entry, snapshot);
	}

	private createToolbarButton(
		toolbarEl: HTMLElement,
		handle: CalendarViewHandle,
	): InjectedToolbarButton {
		const doc = toolbarEl.ownerDocument;
		const wrapperEl = doc.createElement("div");
		wrapperEl.className = `bases-toolbar-item ${TOOLBAR_BUTTON_WRAPPER_CLASS}`;

		const buttonEl = doc.createElement("button");
		buttonEl.type = "button";
		buttonEl.className = "text-icon-button tnce-calendar-toggle-button";
		buttonEl.setAttribute("aria-label", "Calendars");
		buttonEl.setAttribute("aria-haspopup", "dialog");
		buttonEl.setAttribute("aria-expanded", "false");

		const iconSpan = doc.createElement("span");
		iconSpan.className = "text-button-icon";
		iconSpan.setAttribute("aria-hidden", "true");
		setIcon(iconSpan, "calendar");

		const labelSpan = doc.createElement("span");
		labelSpan.className = "text-button-label";
		labelSpan.textContent = "Calendars";

		const badgeEl = doc.createElement("span");
		badgeEl.className = "tnce-calendar-toggle-badge";
		badgeEl.hidden = true;

		buttonEl.append(iconSpan, labelSpan, badgeEl);
		wrapperEl.appendChild(buttonEl);

		const entry: InjectedToolbarButton = {
			toolbarEl,
			wrapperEl,
			buttonEl,
			badgeEl,
			handle,
		};

		buttonEl.addEventListener("click", () => {
			try {
				this.togglePopover(entry);
			} catch (error) {
				console.warn("Failed to toggle calendar picker popover:", error);
			}
		});

		return entry;
	}

	/**
	 * Places the calendar picker directly before `.tn-shortcut-help` (or `.tn-bases-new-task-btn`
	 * when no help button is mounted), staying after `.tn-bases-toolbar-more` without competing
	 * with TaskNotes' `placeHelp()` observer that anchors `.tn-shortcut-help` before `.tn-bases-new-task-btn`.
	 */
	private ensureButtonPlacement(toolbarEl: HTMLElement, wrapperEl: HTMLDivElement): void {
		const anchor =
			toolbarEl.querySelector<HTMLElement>(":scope > .tn-shortcut-help") ??
			toolbarEl.querySelector<HTMLElement>(":scope > .tn-bases-new-task-btn") ??
			toolbarEl.querySelector<HTMLElement>(":scope > .bases-toolbar-new-item-menu");

		if (anchor) {
			if (wrapperEl.parentElement !== toolbarEl || wrapperEl.nextElementSibling !== anchor) {
				anchor.before(wrapperEl);
			}
			return;
		}

		if (wrapperEl.parentElement !== toolbarEl || wrapperEl.nextElementSibling !== null) {
			toolbarEl.append(wrapperEl);
		}
	}

	private updateButtonBadge(
		entry: InjectedToolbarButton,
		snapshot: ExternalCalendarSnapshot,
	): void {
		const items = getAllItems(snapshot);
		const total = items.length;
		let visible = 0;
		for (const item of items) {
			if (entry.handle.getBooleanConfig(item.configKey, true)) {
				visible += 1;
			}
		}

		const isFiltered = total > 0 && visible < total;
		const nextText = isFiltered ? `${String(visible)}/${String(total)}` : "";
		if (entry.badgeEl.textContent !== nextText) {
			entry.badgeEl.textContent = nextText;
		}
		if (entry.badgeEl.hidden === isFiltered) {
			entry.badgeEl.hidden = !isFiltered;
		}
		entry.buttonEl.classList.toggle("is-filtered", isFiltered);

		const nextLabel = isFiltered
			? `Calendars (${String(visible)} of ${String(total)} visible)`
			: "Calendars";
		if (entry.buttonEl.getAttribute("aria-label") !== nextLabel) {
			entry.buttonEl.setAttribute("aria-label", nextLabel);
		}
	}

	private togglePopover(entry: InjectedToolbarButton): void {
		if (!this.enabled) {
			return;
		}
		if (this.openPopoverState?.toolbarEl === entry.toolbarEl) {
			this.closePopover();
			return;
		}
		this.openPopover(entry);
	}

	private openPopover(entry: InjectedToolbarButton): void {
		this.closePopover();

		const doc = entry.buttonEl.ownerDocument;
		const win = doc.defaultView ?? window;
		const snapshot = getExternalCalendarSnapshot(this.app);
		const colorsEnabled = Boolean(this.colorAdapter?.isEnabled());

		const popoverEl = doc.createElement("div");
		popoverEl.className = `menu ${POPOVER_CLASS}`;
		popoverEl.setAttribute("role", "dialog");
		popoverEl.setAttribute("aria-label", "Toggle calendars");
		popoverEl.style.position = "fixed";

		const headerEl = doc.createElement("div");
		headerEl.className = "tnce-calendar-picker-header";

		const titleEl = doc.createElement("div");
		titleEl.className = "tnce-calendar-picker-title";
		titleEl.textContent = "Calendars";
		headerEl.appendChild(titleEl);

		const allItems = getAllItems(snapshot);
		const rowStates: Array<{
			item: ExternalCalendarItem;
			inputEl: HTMLInputElement;
			colorEl: HTMLSpanElement;
			syncColorPanel?: (freshItem: ExternalCalendarItem) => void;
		}> = [];
		let showAllBtn: HTMLButtonElement | null = null;
		let hideAllBtn: HTMLButtonElement | null = null;

		let closeOpenColorPanel: () => void = () => {};

		const findSnapshotItem = (
			freshSnapshot: ExternalCalendarSnapshot,
			target: ExternalCalendarItem,
		): ExternalCalendarItem => {
			for (const group of freshSnapshot.groups) {
				if (group.provider !== target.provider) {
					continue;
				}
				const match = group.items.find((candidate) => candidate.id === target.id);
				if (match) {
					return match;
				}
			}
			return target;
		};

		const syncControls = (): void => {
			const freshSnapshot = getExternalCalendarSnapshot(this.app);
			let visibleCount = 0;
			for (const row of rowStates) {
				const checked = entry.handle.getBooleanConfig(row.item.configKey, true);
				row.inputEl.checked = checked;
				if (checked) {
					visibleCount += 1;
				}

				const freshItem = findSnapshotItem(freshSnapshot, row.item);
				row.item = freshItem;
				const overrideColor = colorsEnabled
					? (this.colorAdapter?.getOverrideColor(freshItem.provider, freshItem.id) ??
						null)
					: null;
				applyDotColor(
					row.colorEl,
					overrideColor ?? freshItem.color,
					overrideColor !== null,
				);
				row.syncColorPanel?.(freshItem);
			}
			if (showAllBtn) {
				showAllBtn.disabled = visibleCount === rowStates.length;
			}
			if (hideAllBtn) {
				hideAllBtn.disabled = visibleCount === 0;
			}
			this.updateButtonBadge(entry, freshSnapshot);
		};

		if (allItems.length > 0) {
			const actionsEl = doc.createElement("div");
			actionsEl.className = "tnce-calendar-picker-actions";

			showAllBtn = doc.createElement("button");
			showAllBtn.type = "button";
			showAllBtn.className = "tnce-calendar-picker-action-btn";
			showAllBtn.textContent = "Show all";
			showAllBtn.addEventListener("click", () => {
				for (const row of rowStates) {
					if (!entry.handle.getBooleanConfig(row.item.configKey, true)) {
						entry.handle.setCalendarToggle(row.item.configKey, true);
					}
				}
				syncControls();
			});

			hideAllBtn = doc.createElement("button");
			hideAllBtn.type = "button";
			hideAllBtn.className = "tnce-calendar-picker-action-btn";
			hideAllBtn.textContent = "Hide all";
			hideAllBtn.addEventListener("click", () => {
				for (const row of rowStates) {
					if (entry.handle.getBooleanConfig(row.item.configKey, true)) {
						entry.handle.setCalendarToggle(row.item.configKey, false);
					}
				}
				syncControls();
			});

			actionsEl.append(showAllBtn, hideAllBtn);
			headerEl.appendChild(actionsEl);
		}

		popoverEl.appendChild(headerEl);

		const bodyEl = doc.createElement("div");
		bodyEl.className = "tnce-calendar-picker-body";

		if (snapshot.groups.length === 0) {
			const emptyEl = doc.createElement("div");
			emptyEl.className = "tnce-calendar-picker-empty";

			const emptyTextEl = doc.createElement("p");
			emptyTextEl.className = "tnce-calendar-picker-empty-text";
			emptyTextEl.textContent = "No external calendars are available yet.";
			emptyEl.appendChild(emptyTextEl);

			const settingsBtn = doc.createElement("button");
			settingsBtn.type = "button";
			settingsBtn.className = "tnce-calendar-picker-link-btn";
			settingsBtn.textContent = "Open TaskNotes settings";
			settingsBtn.addEventListener("click", () => {
				this.closePopover();
				openTaskNotesSettings(this.app);
			});
			emptyEl.appendChild(settingsBtn);

			bodyEl.appendChild(emptyEl);
		} else {
			for (const group of snapshot.groups) {
				const groupEl = doc.createElement("div");
				groupEl.className = "tnce-calendar-picker-group";

				const groupTitleEl = doc.createElement("div");
				groupTitleEl.className = "tnce-calendar-picker-group-title";
				groupTitleEl.textContent = group.title;
				groupEl.appendChild(groupTitleEl);

				const listEl = doc.createElement("div");
				listEl.className = "tnce-calendar-picker-group-items";

				for (const item of group.items) {
					const checkboxId = `tnce-cal-item-${String(++this.nextCheckboxId)}`;
					const inputEl = doc.createElement("input");
					inputEl.type = "checkbox";
					inputEl.id = checkboxId;
					inputEl.className = "tnce-calendar-picker-checkbox";
					inputEl.checked = entry.handle.getBooleanConfig(item.configKey, true);
					inputEl.addEventListener("change", () => {
						entry.handle.setCalendarToggle(item.configKey, inputEl.checked);
						syncControls();
					});

					const overrideColor = colorsEnabled
						? (this.colorAdapter?.getOverrideColor(item.provider, item.id) ?? null)
						: null;

					const colorEl = doc.createElement("span");
					colorEl.className = "tnce-calendar-picker-color";
					colorEl.setAttribute("aria-hidden", "true");
					applyDotColor(colorEl, overrideColor ?? item.color, overrideColor !== null);

					if (colorsEnabled && this.colorAdapter) {
						const wrapperEl = doc.createElement("div");
						wrapperEl.className = "tnce-calendar-picker-item-wrapper";

						const rowEl = doc.createElement("div");
						rowEl.className = "tnce-calendar-picker-item";

						const colorTriggerBtn = doc.createElement("button");
						colorTriggerBtn.type = "button";
						colorTriggerBtn.className = "tnce-calendar-color-trigger";
						colorTriggerBtn.setAttribute("aria-label", `Change color for ${item.name}`);
						colorTriggerBtn.setAttribute("aria-expanded", "false");
						colorTriggerBtn.title = "Change calendar color";
						colorTriggerBtn.appendChild(colorEl);

						const nameLabelEl = doc.createElement("label");
						nameLabelEl.className = "tnce-calendar-picker-name";
						nameLabelEl.htmlFor = checkboxId;
						nameLabelEl.textContent = item.name;

						rowEl.append(inputEl, colorTriggerBtn, nameLabelEl);
						wrapperEl.appendChild(rowEl);
						listEl.appendChild(wrapperEl);

						const rowState: {
							item: ExternalCalendarItem;
							inputEl: HTMLInputElement;
							colorEl: HTMLSpanElement;
							syncColorPanel?: (freshItem: ExternalCalendarItem) => void;
						} = { item, inputEl, colorEl };
						rowStates.push(rowState);

						let panelEl: HTMLDivElement | null = null;
						const swatchButtons: Array<{ btn: HTMLButtonElement; hex: string }> = [];
						let customInputEl: HTMLInputElement | null = null;
						let resetBtnEl: HTMLButtonElement | null = null;

						const syncPanel = (freshItem: ExternalCalendarItem): void => {
							if (!panelEl) {
								return;
							}
							const currentOverride =
								this.colorAdapter?.getOverrideColor(
									freshItem.provider,
									freshItem.id,
								) ?? null;
							const effectiveHex =
								currentOverride ??
								normalizeHexColor(freshItem.color) ??
								getDefaultProviderColor(freshItem.provider);
							for (const swatch of swatchButtons) {
								swatch.btn.setAttribute(
									"aria-pressed",
									String(effectiveHex === swatch.hex),
								);
							}
							if (customInputEl) {
								customInputEl.value = effectiveHex;
							}
							if (resetBtnEl) {
								resetBtnEl.disabled = currentOverride === null;
							}
						};

						rowState.syncColorPanel = syncPanel;

						const closeThisPanel = (): void => {
							if (!panelEl) {
								return;
							}
							panelEl.remove();
							panelEl = null;
							swatchButtons.length = 0;
							customInputEl = null;
							resetBtnEl = null;
							colorTriggerBtn.setAttribute("aria-expanded", "false");
							if (closeOpenColorPanel === closeThisPanel) {
								closeOpenColorPanel = () => {};
							}
						};

						const applyColor = async (nextHex: string | null): Promise<void> => {
							if (!this.colorAdapter) {
								return;
							}
							try {
								await this.colorAdapter.setColorOverride(
									rowState.item.provider,
									rowState.item.id,
									nextHex,
								);
							} catch (error) {
								console.warn("Failed to update calendar color override:", error);
								return;
							}
							if (
								!this.openPopoverState ||
								this.openPopoverState.popoverEl !== popoverEl
							) {
								return;
							}
							syncControls();
						};

						colorTriggerBtn.addEventListener("click", (event) => {
							event.stopPropagation();
							if (panelEl) {
								closeThisPanel();
								return;
							}

							closeOpenColorPanel();

							const nextPanel = doc.createElement("div");
							nextPanel.className = "tnce-calendar-color-panel";

							const presetsEl = doc.createElement("div");
							presetsEl.className = "tnce-calendar-color-presets";

							for (const preset of CALENDAR_COLOR_PRESETS) {
								const swatchBtn = doc.createElement("button");
								swatchBtn.type = "button";
								swatchBtn.className = "tnce-calendar-color-swatch";
								swatchBtn.setAttribute(
									"aria-label",
									`${preset.name} (${preset.hex})`,
								);
								swatchBtn.setAttribute("aria-pressed", "false");
								swatchBtn.title = `${preset.name} (${preset.hex})`;
								swatchBtn.style.backgroundColor = preset.hex;
								swatchBtn.addEventListener("click", (swatchEvent) => {
									swatchEvent.stopPropagation();
									void applyColor(preset.hex);
								});
								swatchButtons.push({ btn: swatchBtn, hex: preset.hex });
								presetsEl.appendChild(swatchBtn);
							}

							const customRowEl = doc.createElement("div");
							customRowEl.className = "tnce-calendar-color-custom-row";

							const customLabelEl = doc.createElement("label");
							customLabelEl.className = "tnce-calendar-color-custom-label";
							const customTextEl = doc.createElement("span");
							customTextEl.textContent = "Custom";

							const colorInput = doc.createElement("input");
							colorInput.type = "color";
							colorInput.className = "tnce-calendar-color-input";
							colorInput.setAttribute(
								"aria-label",
								`Custom color for ${rowState.item.name}`,
							);
							colorInput.addEventListener("input", () => {
								const previewHex = normalizeHexColor(colorInput.value);
								if (previewHex) {
									applyDotColor(colorEl, previewHex, true);
								}
							});
							colorInput.addEventListener("change", () => {
								const nextHex = normalizeHexColor(colorInput.value);
								if (nextHex) {
									void applyColor(nextHex);
								}
							});

							customInputEl = colorInput;
							customLabelEl.append(customTextEl, colorInput);

							const resetBtn = doc.createElement("button");
							resetBtn.type = "button";
							resetBtn.className = "tnce-calendar-color-reset-btn";
							resetBtn.textContent = "Reset";
							resetBtn.addEventListener("click", (resetEvent) => {
								resetEvent.stopPropagation();
								void applyColor(null);
							});
							resetBtnEl = resetBtn;

							customRowEl.append(customLabelEl, resetBtn);
							nextPanel.append(presetsEl, customRowEl);

							panelEl = nextPanel;
							wrapperEl.appendChild(nextPanel);
							colorTriggerBtn.setAttribute("aria-expanded", "true");
							closeOpenColorPanel = closeThisPanel;
							syncPanel(rowState.item);
							nextPanel.scrollIntoView({ block: "nearest" });
						});
					} else {
						const rowEl = doc.createElement("label");
						rowEl.className = "tnce-calendar-picker-item";
						rowEl.htmlFor = checkboxId;

						const nameEl = doc.createElement("span");
						nameEl.className = "tnce-calendar-picker-name";
						nameEl.textContent = item.name;

						rowEl.append(inputEl, colorEl, nameEl);
						listEl.appendChild(rowEl);
						rowStates.push({ item, inputEl, colorEl });
					}
				}

				groupEl.appendChild(listEl);
				bodyEl.appendChild(groupEl);
			}
		}

		popoverEl.appendChild(bodyEl);

		const hosted = snapshot.hostedGoogle;
		if (hosted?.isHostedActive && hosted.isSignedIn) {
			const footerEl = doc.createElement("div");
			footerEl.className = "tnce-calendar-picker-footer";

			const noteEl = doc.createElement("div");
			noteEl.className = "tnce-calendar-picker-note";
			noteEl.textContent =
				hosted.totalCount > hosted.shownCount
					? `Showing ${String(hosted.shownCount)} of ${String(hosted.totalCount)} Google calendars enabled in TaskNotes (max 5).`
					: "Manage enabled Google calendars in TaskNotes settings.";

			const settingsBtn = doc.createElement("button");
			settingsBtn.type = "button";
			settingsBtn.className = "tnce-calendar-picker-link-btn";
			settingsBtn.textContent = "TaskNotes settings";
			settingsBtn.addEventListener("click", () => {
				this.closePopover();
				openTaskNotesSettings(this.app);
			});

			footerEl.append(noteEl, settingsBtn);
			popoverEl.appendChild(footerEl);
		}

		doc.body.appendChild(popoverEl);
		this.positionPopover(popoverEl, entry.buttonEl, win);
		entry.wrapperEl.classList.add("has-active-menu");
		entry.buttonEl.classList.add("has-active-menu");
		entry.buttonEl.setAttribute("aria-expanded", "true");

		const onPointerDown = (event: Event): void => {
			const target = event.target;
			const docNode = doc.defaultView?.Node;
			const isNode =
				target instanceof Node || (docNode !== undefined && target instanceof docNode);
			if (!isNode) {
				return;
			}
			if (popoverEl.contains(target) || entry.buttonEl.contains(target)) {
				return;
			}
			this.closePopover();
		};

		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key !== "Escape") {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			this.closePopover();
			entry.buttonEl.focus({ preventScroll: true });
		};

		const onResize = (): void => {
			this.closePopover();
		};

		doc.addEventListener("pointerdown", onPointerDown, true);
		doc.addEventListener("mousedown", onPointerDown, true);
		doc.addEventListener("keydown", onKeyDown, true);
		win.addEventListener("resize", onResize);

		this.openPopoverState = {
			toolbarEl: entry.toolbarEl,
			buttonEl: entry.buttonEl,
			popoverEl,
			colorsEnabled,
			syncControls,
			cleanup: () => {
				closeOpenColorPanel();
				doc.removeEventListener("pointerdown", onPointerDown, true);
				doc.removeEventListener("mousedown", onPointerDown, true);
				doc.removeEventListener("keydown", onKeyDown, true);
				win.removeEventListener("resize", onResize);
				popoverEl.remove();
				entry.wrapperEl.classList.remove("has-active-menu");
				entry.buttonEl.classList.remove("has-active-menu");
				entry.buttonEl.setAttribute("aria-expanded", "false");
			},
		};

		syncControls();
	}

	private positionPopover(
		popoverEl: HTMLDivElement,
		anchorEl: HTMLButtonElement,
		win: Window,
	): void {
		try {
			const margin = 8;
			const gap = 6;
			const anchorRect = anchorEl.getBoundingClientRect();
			const popoverRect = popoverEl.getBoundingClientRect();
			const viewportWidth = win.innerWidth || 1024;
			const viewportHeight = win.innerHeight || 768;

			const width = popoverRect.width || 280;
			const height = popoverRect.height || 240;

			let left = anchorRect.right - width;
			if (left < margin) {
				left = anchorRect.left;
			}
			left = Math.max(margin, Math.min(left, viewportWidth - width - margin));

			let top = anchorRect.bottom + gap;
			if (top + height > viewportHeight - margin && anchorRect.top - gap - height >= margin) {
				top = anchorRect.top - gap - height;
			}
			top = Math.max(margin, Math.min(top, viewportHeight - height - margin));

			popoverEl.style.left = `${String(Math.round(left))}px`;
			popoverEl.style.top = `${String(Math.round(top))}px`;
		} catch {
			// Keep default CSS positioning if layout metrics are unavailable.
		}
	}

	private closePopover(): void {
		if (!this.openPopoverState) {
			return;
		}
		const state = this.openPopoverState;
		this.openPopoverState = null;
		state.cleanup();
	}
}
