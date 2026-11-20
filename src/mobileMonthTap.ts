import type { App, EventRef } from "obsidian";
import {
	type CalendarViewHandle,
	getActiveCalendarViews,
	getBasesLeafContainers,
} from "./tasknotesBridge";

export const MOBILE_MONTH_TAP_BODY_CLASS = "tnce-mobile-month-tap";

const MAX_TAP_MOVEMENT_PX = 10;
const IGNORED_ANCESTORS_SELECTOR = [
	".tn-calendar-composition",
	".tn-selection-mode",
	".tnc-popover",
	".tnc-toolbar",
	".tnc-navlink",
	".tnc-dg-dots-more",
	".tnc-more",
	".tnc-dg--compact",
].join(", ");
const INTERACTIVE_CONTROLS_SELECTOR =
	'a, button, input, select, textarea, [role="button"]';

interface PendingDayTap {
	pointerId: number;
	startX: number;
	startY: number;
	dayCell: HTMLElement;
	moved: boolean;
}

interface AttachedCalendarView {
	handle: CalendarViewHandle;
	detach: () => void;
}

function asElement(target: EventTarget | null): Element | null {
	if (
		typeof target === "object" &&
		target !== null &&
		typeof (target as { closest?: unknown }).closest === "function"
	) {
		return target as Element;
	}
	return null;
}

function isEligiblePointerOrMouseEvent(
	event: MouseEvent,
	handle: CalendarViewHandle,
): boolean {
	if (event.button !== 0) {
		return false;
	}
	if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
		return false;
	}
	if (
		handle.isMonthDayPanelEnabled() ||
		handle.isSelectionModeActive() ||
		handle.isCalendarEngineDragging()
	) {
		return false;
	}
	return true;
}

function findFallbackDayCell(target: Element): HTMLElement | null {
	if (!target.closest(".tnc-dg--dots")) {
		return null;
	}
	if (
		target.closest(IGNORED_ANCESTORS_SELECTOR) ||
		target.closest(".tnc-item--indicator") ||
		target.closest(INTERACTIVE_CONTROLS_SELECTOR)
	) {
		return null;
	}

	const dayCell = target.closest<HTMLElement>(".tnc-dg-day[data-date]");
	if (!dayCell || !dayCell.querySelector(".tnc-item--indicator")) {
		return null;
	}

	return dayCell;
}

/**
 * Enables tapping chips and narrow-month day cells to inspect event details
 * without disrupting swipes, drag-and-drop, selection mode, or day-panel mode.
 */
export class MobileMonthTapController {
	private readonly app: App;
	private enabled = false;
	private workspaceEventRefs: EventRef[] = [];
	private observedContainers = new Map<HTMLElement, MutationObserver>();
	private attachedViews = new Map<HTMLElement, AttachedCalendarView>();
	private styledDocuments = new Set<Document>();
	private syncTimer: number | null = null;

	constructor(app: App) {
		this.app = app;
	}

	enable(): void {
		if (this.enabled) {
			return;
		}
		this.enabled = true;

		if (typeof document !== "undefined") {
			this.applyBodyClass(document);
		}

		this.registerWorkspaceListeners();

		const workspace = this.app.workspace as unknown as {
			onLayoutReady?: (cb: () => void) => void;
		};
		if (typeof workspace.onLayoutReady === "function") {
			workspace.onLayoutReady(() => {
				if (!this.enabled) {
					return;
				}
				this.syncViews();
			});
		}

		this.syncViews();
	}

	disable(): void {
		if (
			!this.enabled &&
			this.attachedViews.size === 0 &&
			this.styledDocuments.size === 0
		) {
			return;
		}
		this.enabled = false;

		this.clearSyncTimer();
		this.disconnectAllObservers();
		this.unregisterWorkspaceListeners();
		this.detachAllViews();
		this.clearAllBodyClasses();
	}

	syncViews(): void {
		if (!this.enabled) {
			return;
		}

		this.syncObservedContainers();

		const activeHandles = getActiveCalendarViews(this.app);
		const activeContainers = new Set<HTMLElement>();

		for (const handle of activeHandles) {
			activeContainers.add(handle.containerEl);
			this.applyBodyClass(handle.containerEl.ownerDocument);

			const existing = this.attachedViews.get(handle.containerEl);
			if (existing) {
				existing.handle = handle;
			} else {
				this.attachedViews.set(handle.containerEl, this.attachView(handle));
			}
		}

		for (const [containerEl, attached] of this.attachedViews.entries()) {
			if (!activeContainers.has(containerEl) || !containerEl.isConnected) {
				attached.detach();
				this.attachedViews.delete(containerEl);
			}
		}
	}

	private applyBodyClass(doc: Document | null | undefined): void {
		if (!doc?.body) {
			return;
		}
		doc.body.classList.add(MOBILE_MONTH_TAP_BODY_CLASS);
		this.styledDocuments.add(doc);
	}

	private clearAllBodyClasses(): void {
		for (const doc of this.styledDocuments) {
			try {
				doc.body.classList.remove(MOBILE_MONTH_TAP_BODY_CLASS);
			} catch {
				// Ignore documents from closed popout windows.
			}
		}
		this.styledDocuments.clear();
	}

	private attachView(initialHandle: CalendarViewHandle): AttachedCalendarView {
		const containerEl = initialHandle.containerEl;
		const entry: AttachedCalendarView = {
			handle: initialHandle,
			detach: () => {},
		};
		let pendingTap: PendingDayTap | null = null;

		const onPointerDown = (event: PointerEvent): void => {
			pendingTap = null;
			if (!this.enabled || !isEligiblePointerOrMouseEvent(event, entry.handle)) {
				return;
			}
			const target = asElement(event.target);
			if (!target) {
				return;
			}
			if (target.closest(".tnc-dg--chips .tnc-dg-dots-more")) {
				// Prevent @tasknotes/calendar bubble-phase pointerdown from starting day selection on "+N".
				event.stopPropagation();
				return;
			}
			const dayCell = findFallbackDayCell(target);
			if (!dayCell) {
				return;
			}
			pendingTap = {
				pointerId: event.pointerId,
				startX: event.clientX,
				startY: event.clientY,
				dayCell,
				moved: false,
			};
			// Prevent @tasknotes/calendar bubble-phase pointerdown from starting a date-selection drag.
			event.stopPropagation();
		};

		const onPointerMove = (event: PointerEvent): void => {
			if (!pendingTap || event.pointerId !== pendingTap.pointerId) {
				return;
			}
			const distance = Math.hypot(
				event.clientX - pendingTap.startX,
				event.clientY - pendingTap.startY,
			);
			if (distance > MAX_TAP_MOVEMENT_PX) {
				pendingTap.moved = true;
			}
		};

		const onPointerCancel = (): void => {
			pendingTap = null;
		};

		const onClick = (event: MouseEvent): void => {
			const tap = pendingTap;
			pendingTap = null;
			if (!this.enabled || !isEligiblePointerOrMouseEvent(event, entry.handle)) {
				return;
			}
			const target = asElement(event.target);
			if (!target || target.closest(IGNORED_ANCESTORS_SELECTOR)) {
				return;
			}

			const indicatorEl = target.closest<HTMLElement>(
				".tnc-dg--chips .tnc-dg-dots > .tnc-item--indicator",
			);
			if (indicatorEl) {
				if (entry.handle.hasEngineItemMeta(indicatorEl)) {
					// Native engine onClick already opens the item via CalendarView.handleEventClick.
					return;
				}
				event.preventDefault();
				event.stopPropagation();
				const taskPath = indicatorEl.dataset.taskPath;
				if (taskPath) {
					void entry.handle.openTaskFromPath(taskPath);
					return;
				}
				const dateStr = indicatorEl.closest<HTMLElement>(".tnc-dg-day[data-date]")
					?.dataset.date;
				if (dateStr) {
					entry.handle.openDayMorePopover(dateStr, indicatorEl, event);
				}
				return;
			}

			const dayCell = findFallbackDayCell(target);
			if (!dayCell) {
				return;
			}
			if (tap && (tap.moved || tap.dayCell !== dayCell)) {
				return;
			}
			const dateStr = dayCell.dataset.date;
			if (!dateStr) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			entry.handle.openDayMorePopover(dateStr, dayCell, event);
		};

		containerEl.addEventListener("pointerdown", onPointerDown, true);
		containerEl.addEventListener("pointermove", onPointerMove, true);
		containerEl.addEventListener("pointercancel", onPointerCancel, true);
		containerEl.addEventListener("click", onClick, true);

		entry.detach = () => {
			pendingTap = null;
			containerEl.removeEventListener("pointerdown", onPointerDown, true);
			containerEl.removeEventListener("pointermove", onPointerMove, true);
			containerEl.removeEventListener("pointercancel", onPointerCancel, true);
			containerEl.removeEventListener("click", onClick, true);
		};

		return entry;
	}

	private detachAllViews(): void {
		for (const attached of this.attachedViews.values()) {
			attached.detach();
		}
		this.attachedViews.clear();
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
			const observer = new MutationObserver(() => {
				if (this.enabled) {
					this.scheduleSync();
				}
			});
			observer.observe(containerEl, { childList: true, subtree: true });
			this.observedContainers.set(containerEl, observer);
		}
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
			this.syncViews();
		}, 0);
	}

	private clearSyncTimer(): void {
		if (this.syncTimer !== null) {
			window.clearTimeout(this.syncTimer);
			this.syncTimer = null;
		}
	}
}
