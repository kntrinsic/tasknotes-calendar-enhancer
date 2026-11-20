import { type App, type EventRef, setIcon } from "obsidian";
import {
	type CalendarViewHandle,
	type ExternalCalendarItem,
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

/**
 * Injects a quick external-calendar toggle button and popover into active Bases toolbars.
 */
export class ToolbarCalendarPicker {
	private readonly app: App;
	private enabled = false;
	private workspaceEventRefs: EventRef[] = [];
	private providerUnsubscribe: (() => void) | null = null;
	private observedContainers = new Map<HTMLElement, MutationObserver>();
	private injectedButtons = new Map<HTMLElement, InjectedToolbarButton>();
	private openPopoverState: OpenPopoverState | null = null;
	private syncTimer: number | null = null;

	constructor(app: App) {
		this.app = app;
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

		if (this.openPopoverState) {
			if (
				!this.openPopoverState.buttonEl.isConnected ||
				!this.openPopoverState.toolbarEl.isConnected
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

		buttonEl.addEventListener("click", (event) => {
			event.stopPropagation();
			this.togglePopover(entry);
		});

		return entry;
	}

	/**
	 * Places the calendar picker right before `.tn-bases-new-task-btn` (after `.tn-bases-toolbar-more`)
	 * so narrow-screen overflow spacing (`margin-inline-start: auto` on `.tn-bases-toolbar-more`) stays intact.
	 */
	private ensureButtonPlacement(toolbarEl: HTMLElement, wrapperEl: HTMLDivElement): void {
		const newTaskBtn = toolbarEl.querySelector<HTMLElement>(":scope > .tn-bases-new-task-btn");
		const nativeNewBtn =
			newTaskBtn ?? toolbarEl.querySelector<HTMLElement>(":scope > .bases-toolbar-new-item-menu");

		if (nativeNewBtn) {
			if (wrapperEl.parentElement !== toolbarEl || wrapperEl.nextElementSibling !== nativeNewBtn) {
				nativeNewBtn.before(wrapperEl);
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

		const popoverEl = doc.createElement("div");
		popoverEl.className = POPOVER_CLASS;
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
		const checkboxRows: Array<{ item: ExternalCalendarItem; inputEl: HTMLInputElement }> = [];
		let showAllBtn: HTMLButtonElement | null = null;
		let hideAllBtn: HTMLButtonElement | null = null;

		const syncControls = (): void => {
			let visibleCount = 0;
			for (const row of checkboxRows) {
				const checked = entry.handle.getBooleanConfig(row.item.configKey, true);
				row.inputEl.checked = checked;
				if (checked) {
					visibleCount += 1;
				}
			}
			if (showAllBtn) {
				showAllBtn.disabled = visibleCount === checkboxRows.length;
			}
			if (hideAllBtn) {
				hideAllBtn.disabled = visibleCount === 0;
			}
			this.updateButtonBadge(entry, snapshot);
		};

		if (allItems.length > 0) {
			const actionsEl = doc.createElement("div");
			actionsEl.className = "tnce-calendar-picker-actions";

			showAllBtn = doc.createElement("button");
			showAllBtn.type = "button";
			showAllBtn.className = "tnce-calendar-picker-action-btn";
			showAllBtn.textContent = "Show all";
			showAllBtn.addEventListener("click", () => {
				for (const row of checkboxRows) {
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
				for (const row of checkboxRows) {
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
					const rowEl = doc.createElement("label");
					rowEl.className = "tnce-calendar-picker-item";

					const inputEl = doc.createElement("input");
					inputEl.type = "checkbox";
					inputEl.className = "tnce-calendar-picker-checkbox";
					inputEl.checked = entry.handle.getBooleanConfig(item.configKey, true);
					inputEl.addEventListener("change", () => {
						entry.handle.setCalendarToggle(item.configKey, inputEl.checked);
						syncControls();
					});

					const colorEl = doc.createElement("span");
					colorEl.className = "tnce-calendar-picker-color";
					colorEl.setAttribute("aria-hidden", "true");
					const safeColor = sanitizeCssColor(item.color);
					if (safeColor) {
						colorEl.style.backgroundColor = safeColor;
					} else {
						colorEl.classList.add("is-default");
					}

					const nameEl = doc.createElement("span");
					nameEl.className = "tnce-calendar-picker-name";
					nameEl.textContent = item.name;

					rowEl.append(inputEl, colorEl, nameEl);
					listEl.appendChild(rowEl);
					checkboxRows.push({ item, inputEl });
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
			syncControls,
			cleanup: () => {
				doc.removeEventListener("pointerdown", onPointerDown, true);
				doc.removeEventListener("mousedown", onPointerDown, true);
				doc.removeEventListener("keydown", onKeyDown, true);
				win.removeEventListener("resize", onResize);
				popoverEl.remove();
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
