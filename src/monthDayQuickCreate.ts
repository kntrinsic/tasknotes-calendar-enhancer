import type { App, EventRef } from "obsidian";
import {
	type CalendarViewHandle,
	formatDayNumber,
	getActiveCalendarViews,
	getBasesLeafContainers,
} from "./tasknotesBridge";

export const MONTH_QUICK_CREATE_BODY_CLASS = "tnce-month-quick-create";

export const LONG_PRESS_DELAY_MS = 480;
export const MAX_LONG_PRESS_MOVEMENT_PX = 10;
export const POST_LONG_PRESS_SUPPRESS_MS = 800;

const IGNORED_ANCESTORS_SELECTOR = [
	".tn-calendar-day-panel",
	".tn-selection-mode",
	".tnc-popover",
	".tnc-toolbar",
	".tnc-navlink",
].join(", ");

const INTERACTIVE_CONTROLS_SELECTOR =
	'a, button, input, select, textarea, [role="button"]';

const DAY_NUMBER_PATTERN = /^-?\d+$/;

interface MonthCreationTarget {
	targetEl: HTMLElement;
	dateStr: string;
}

interface PendingLongPress {
	pointerId: number;
	startX: number;
	startY: number;
	targetEl: HTMLElement;
	dateStr: string;
	timerId: number;
}

interface AttachedQuickCreateView {
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

function isTouchLikePointer(event: PointerEvent): boolean {
	return event.pointerType === "touch" || event.pointerType === "pen";
}

function resolveMoreButtonTarget(target: Element): MonthCreationTarget | null {
	const dotsMoreEl = target.closest<HTMLElement>(".tnc-dg-dots-more");
	if (dotsMoreEl) {
		const dayCell = dotsMoreEl.closest<HTMLElement>(".tnc-dg-day[data-date]");
		const dateStr = dayCell?.dataset.date?.trim();
		if (dayCell && dateStr) {
			return { targetEl: dotsMoreEl, dateStr };
		}
		return null;
	}

	const fullMoreEl = target.closest<HTMLElement>(".tnc-more[data-day]");
	if (fullMoreEl) {
		const rawDay = fullMoreEl.dataset.day?.trim();
		if (!rawDay || !DAY_NUMBER_PATTERN.test(rawDay)) {
			return null;
		}
		const dateStr = formatDayNumber(Number(rawDay));
		if (dateStr) {
			return { targetEl: fullMoreEl, dateStr };
		}
		return null;
	}

	return null;
}

function findRightClickTarget(target: Element): MonthCreationTarget | null {
	if (!target.closest(".tnc-dg") || target.closest(IGNORED_ANCESTORS_SELECTOR)) {
		return null;
	}
	const moreTarget = resolveMoreButtonTarget(target);
	if (moreTarget) {
		return moreTarget;
	}
	if (
		target.closest(INTERACTIVE_CONTROLS_SELECTOR) ||
		target.closest(".tnc-item")
	) {
		return null;
	}
	const dayCell = target.closest<HTMLElement>(".tnc-dg-day[data-date]");
	const dateStr = dayCell?.dataset.date?.trim();
	return dayCell && dateStr ? { targetEl: dayCell, dateStr } : null;
}

function findTouchLongPressTarget(target: Element): MonthCreationTarget | null {
	if (!target.closest(".tnc-dg") || target.closest(IGNORED_ANCESTORS_SELECTOR)) {
		return null;
	}
	const moreTarget = resolveMoreButtonTarget(target);
	if (moreTarget) {
		return moreTarget;
	}
	if (target.closest(INTERACTIVE_CONTROLS_SELECTOR)) {
		return null;
	}

	const itemEl = target.closest(".tnc-item");
	if (itemEl) {
		const isAllowedChipOrCompactIndicator =
			Boolean(itemEl.closest(".tnc-dg--chips .tnc-dg-dots > .tnc-item--indicator")) ||
			Boolean(itemEl.closest(".tnc-dg--compact"));
		if (!isAllowedChipOrCompactIndicator) {
			return null;
		}
	}

	const dayCell = target.closest<HTMLElement>(".tnc-dg-day[data-date]");
	const dateStr = dayCell?.dataset.date?.trim();
	return dayCell && dateStr ? { targetEl: dayCell, dateStr } : null;
}

/**
 * Adds desktop right-click and mobile long-press quick creation on TaskNotes month day cells,
 * opening TaskNotes' native creation menu without breaking taps, swipes, or drags.
 */
export class MonthDayQuickCreateController {
	private readonly app: App;
	private enabled = false;
	private workspaceEventRefs: EventRef[] = [];
	private observedContainers = new Map<HTMLElement, MutationObserver>();
	private attachedViews = new Map<HTMLElement, AttachedQuickCreateView>();
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
		doc.body.classList.add(MONTH_QUICK_CREATE_BODY_CLASS);
		this.styledDocuments.add(doc);
	}

	private clearAllBodyClasses(): void {
		for (const doc of this.styledDocuments) {
			try {
				doc.body.classList.remove(MONTH_QUICK_CREATE_BODY_CLASS);
			} catch {
				// Ignore documents from closed popout windows.
			}
		}
		this.styledDocuments.clear();
	}

	private attachView(initialHandle: CalendarViewHandle): AttachedQuickCreateView {
		const containerEl = initialHandle.containerEl;
		const doc = containerEl.ownerDocument;
		const entry: AttachedQuickCreateView = {
			handle: initialHandle,
			detach: () => {},
		};

		let pendingPress: PendingLongPress | null = null;
		let suppressedPointerId: number | null = null;
		let suppressUntil = 0;
		const activeTouchPointerIds = new Set<number>();

		const cancelPendingPress = (): void => {
			if (!pendingPress) {
				return;
			}
			window.clearTimeout(pendingPress.timerId);
			pendingPress = null;
		};

		const isInsideContainer = (target: EventTarget | null): boolean => {
			const el = asElement(target);
			return el !== null && containerEl.contains(el);
		};

		const onContextMenu = (event: MouseEvent): void => {
			if (!this.enabled) {
				return;
			}
			if (Date.now() <= suppressUntil) {
				event.preventDefault();
				event.stopPropagation();
				return;
			}
			if (
				entry.handle.isSelectionModeActive() ||
				entry.handle.isCalendarEngineDragging()
			) {
				return;
			}

			const target = asElement(event.target);
			if (!target) {
				return;
			}
			const creationTarget = findRightClickTarget(target);
			if (!creationTarget) {
				return;
			}

			event.preventDefault();
			event.stopPropagation();
			entry.handle.openDateCreationMenu(creationTarget.dateStr, event);
		};

		const onPointerDown = (event: PointerEvent): void => {
			if (!isTouchLikePointer(event)) {
				return;
			}

			if (suppressedPointerId !== event.pointerId) {
				suppressedPointerId = null;
				suppressUntil = 0;
			}

			activeTouchPointerIds.add(event.pointerId);
			if (activeTouchPointerIds.size > 1) {
				cancelPendingPress();
				return;
			}

			cancelPendingPress();

			if (
				!this.enabled ||
				event.button !== 0 ||
				event.metaKey ||
				event.ctrlKey ||
				event.shiftKey ||
				event.altKey ||
				entry.handle.isSelectionModeActive() ||
				entry.handle.isCalendarEngineDragging()
			) {
				return;
			}

			const target = asElement(event.target);
			if (!target) {
				return;
			}

			const creationTarget = findTouchLongPressTarget(target);
			if (!creationTarget) {
				return;
			}

			const pressPointerId = event.pointerId;
			const startX = event.clientX;
			const startY = event.clientY;
			const timerId = window.setTimeout(() => {
				if (!pendingPress || pendingPress.pointerId !== pressPointerId) {
					return;
				}
				const fired = pendingPress;
				pendingPress = null;

				if (
					!this.enabled ||
					!fired.targetEl.isConnected ||
					entry.handle.isSelectionModeActive() ||
					entry.handle.isCalendarEngineDragging()
				) {
					return;
				}

				suppressedPointerId = fired.pointerId;
				suppressUntil = Date.now() + POST_LONG_PRESS_SUPPRESS_MS;

				entry.handle.unselectCalendar();

				const win = fired.targetEl.ownerDocument.defaultView ?? window;
				const syntheticEvent = new win.MouseEvent("contextmenu", {
					bubbles: true,
					cancelable: true,
					clientX: fired.startX,
					clientY: fired.startY,
					button: 0,
				});
				entry.handle.openDateCreationMenu(fired.dateStr, syntheticEvent);
			}, LONG_PRESS_DELAY_MS);

			pendingPress = {
				pointerId: pressPointerId,
				startX,
				startY,
				targetEl: creationTarget.targetEl,
				dateStr: creationTarget.dateStr,
				timerId,
			};
		};

		const onPointerMove = (event: PointerEvent): void => {
			if (!pendingPress || event.pointerId !== pendingPress.pointerId) {
				return;
			}
			if (entry.handle.isCalendarEngineDragging()) {
				cancelPendingPress();
				return;
			}
			const distance = Math.hypot(
				event.clientX - pendingPress.startX,
				event.clientY - pendingPress.startY,
			);
			if (distance > MAX_LONG_PRESS_MOVEMENT_PX) {
				cancelPendingPress();
			}
		};

		const onPointerEnd = (event: PointerEvent): void => {
			activeTouchPointerIds.delete(event.pointerId);
			if (pendingPress && event.pointerId === pendingPress.pointerId) {
				cancelPendingPress();
			}
		};

		const onDocPointerUp = (event: PointerEvent): void => {
			activeTouchPointerIds.delete(event.pointerId);
			if (suppressedPointerId !== null && event.pointerId === suppressedPointerId) {
				suppressedPointerId = null;
				event.preventDefault();
				event.stopPropagation();
				event.stopImmediatePropagation();
			}
		};

		const onDocClick = (event: MouseEvent): void => {
			if (Date.now() <= suppressUntil && isInsideContainer(event.target)) {
				suppressUntil = 0;
				event.preventDefault();
				event.stopPropagation();
				event.stopImmediatePropagation();
			}
		};

		const onDocContextMenu = (event: MouseEvent): void => {
			if (Date.now() <= suppressUntil && isInsideContainer(event.target)) {
				event.preventDefault();
				event.stopPropagation();
				event.stopImmediatePropagation();
			}
		};

		containerEl.addEventListener("contextmenu", onContextMenu, true);
		containerEl.addEventListener("pointerdown", onPointerDown, true);
		containerEl.addEventListener("pointermove", onPointerMove, true);
		containerEl.addEventListener("pointerup", onPointerEnd, true);
		containerEl.addEventListener("pointercancel", onPointerEnd, true);

		doc.addEventListener("pointerup", onDocPointerUp, true);
		doc.addEventListener("click", onDocClick, true);
		doc.addEventListener("contextmenu", onDocContextMenu, true);

		entry.detach = () => {
			cancelPendingPress();
			activeTouchPointerIds.clear();
			suppressedPointerId = null;
			suppressUntil = 0;

			containerEl.removeEventListener("contextmenu", onContextMenu, true);
			containerEl.removeEventListener("pointerdown", onPointerDown, true);
			containerEl.removeEventListener("pointermove", onPointerMove, true);
			containerEl.removeEventListener("pointerup", onPointerEnd, true);
			containerEl.removeEventListener("pointercancel", onPointerEnd, true);

			doc.removeEventListener("pointerup", onDocPointerUp, true);
			doc.removeEventListener("click", onDocClick, true);
			doc.removeEventListener("contextmenu", onDocContextMenu, true);
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
