import type { App, EventRef } from "obsidian";
import {
	type CalendarViewHandle,
	getActiveCalendarViews,
	getBasesLeafContainers,
} from "./tasknotesBridge";

export const MAX_DIRECT_MONTH_CHIPS = 4;

interface AppliedCalendarLimit {
	handle: CalendarViewHandle;
	original: boolean | number;
}

/**
 * Caps direct month chip count at 4 (showing "+N" at 5+ events) while monthDisplay === "chips",
 * without mutating `.base` view configuration files.
 */
export class MonthChipLimitController {
	private readonly app: App;
	private enabled = false;
	private workspaceEventRefs: EventRef[] = [];
	private observedContainers = new Map<HTMLElement, MutationObserver>();
	private appliedCalendars = new Map<object, AppliedCalendarLimit>();
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
		if (!this.enabled && this.appliedCalendars.size === 0) {
			return;
		}
		this.enabled = false;

		this.clearSyncTimer();
		this.disconnectAllObservers();
		this.unregisterWorkspaceListeners();

		for (const saved of this.appliedCalendars.values()) {
			try {
				saved.handle.setCalendarDayMaxEvents(saved.original);
			} catch {
				// Ignore teardown errors on destroyed calendars.
			}
		}
		this.appliedCalendars.clear();
	}

	syncViews(): void {
		if (!this.enabled) {
			return;
		}

		this.syncObservedContainers();

		const activeHandles = getActiveCalendarViews(this.app);
		const activeCalendars = new Set<object>();

		for (const handle of activeHandles) {
			const rawCalendar = handle.rawCalendar;
			if (!rawCalendar) {
				continue;
			}
			activeCalendars.add(rawCalendar);

			const isChipsMonth =
				handle.getCalendarMonthDisplay() === "chips" &&
				handle.getCalendarViewType() === "month";
			const configured = handle.getConfiguredDayMaxEvents();

			if (isChipsMonth && configured !== false) {
				const desired =
					typeof configured === "number" && configured > 0
						? Math.min(configured, MAX_DIRECT_MONTH_CHIPS)
						: MAX_DIRECT_MONTH_CHIPS;
				const saved = this.appliedCalendars.get(rawCalendar);
				if (!saved) {
					const current = handle.getCalendarDayMaxEvents();
					if (
						current !== null &&
						current !== desired &&
						handle.setCalendarDayMaxEvents(desired)
					) {
						this.appliedCalendars.set(rawCalendar, {
							handle,
							original: current,
						});
					}
				} else {
					saved.handle = handle;
					if (configured !== null) {
						saved.original = configured;
					}
					if (handle.getCalendarDayMaxEvents() !== desired) {
						handle.setCalendarDayMaxEvents(desired);
					}
				}
			} else {
				const saved = this.appliedCalendars.get(rawCalendar);
				if (saved) {
					handle.setCalendarDayMaxEvents(configured ?? saved.original);
					this.appliedCalendars.delete(rawCalendar);
				}
			}
		}

		for (const rawCalendar of Array.from(this.appliedCalendars.keys())) {
			if (!activeCalendars.has(rawCalendar)) {
				this.appliedCalendars.delete(rawCalendar);
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
