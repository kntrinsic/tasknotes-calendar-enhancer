import type { App, EventRef } from "obsidian";
import {
	asCallable,
	asDayGridView,
	type CalendarViewHandle,
	type DayGridContextInfo,
	type DayGridViewLike,
	type DayGridWeekLike,
	formatDayNumber,
	getActiveCalendarViews,
	getBasesLeafContainers,
	getCalendarDayGridView,
	isCalendarDestroyed,
	isRecord,
	readDayGridContext,
	syncCalendarMonthChipControls,
} from "./tasknotesBridge";

export const MONTH_CHIP_SPANNING_BODY_CLASS = "tnce-month-chip-spanning";
export const CHIP_HAS_EVENTS_DATA_ATTR = "tnceHasEvents";
export const CHIP_START_DATE_DATA_ATTR = "tnceStartDate";
export const CHIP_SPAN_COLS_DATA_ATTR = "tnceSpanCols";

const DEFAULT_CHIP_HEIGHT_PX = 20;
const DEFAULT_CHIP_GAP_PX = 3;
const DEFAULT_TOP_PX = 24;
const CELL_PAD_PX = 6;
const SPAN_HORIZONTAL_INSET_PX = 2;

export interface SpanningChipItem {
	id: string;
	startDay: number;
	endDay: number;
	allDay: boolean;
	item: {
		display?: string;
		preview?: boolean;
	};
}

export interface WeekChipPlacement<T extends SpanningChipItem = SpanningChipItem> {
	item: T;
	startCol: number;
	endCol: number;
	level: number;
	isStart: boolean;
	isEnd: boolean;
}

export interface WeekChipLayout<T extends SpanningChipItem = SpanningChipItem> {
	placements: Array<WeekChipPlacement<T>>;
	countByCol: number[];
	levels: number;
}

export interface WeekChipRowLimit {
	fit: number;
	withMore: number;
	fits: number;
}

export interface VisibleWeekChipPlacement<T extends SpanningChipItem = SpanningChipItem> {
	placement: WeekChipPlacement<T>;
	renderLevel: number;
}

export interface PlannedWeekChips<T extends SpanningChipItem = SpanningChipItem> {
	visible: Array<VisibleWeekChipPlacement<T>>;
	hiddenByCol: T[][];
	moreRowByCol: number[];
	maxLevel: number;
}

function isHiddenDisplay(item: SpanningChipItem): boolean {
	return item.item.display === "background" || item.item.display === "none";
}

function colOfDay(days: readonly number[], targetDay: number): number {
	let lo = 0;
	let hi = days.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		const midDay = days[mid];
		if (midDay !== undefined && midDay < targetDay) {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}
	return lo;
}

/**
 * Packs week items into non-overlapping horizontal chip tracks across visible day columns.
 */
export function layoutWeekChips<T extends SpanningChipItem>(
	items: readonly T[],
	days: readonly number[],
	order?: (a: T, b: T) => number,
): WeekChipLayout<T> {
	const countByCol = new Array<number>(days.length).fill(0);
	const first = days[0];
	const last = days[days.length - 1];
	if (first === undefined || last === undefined) {
		return { placements: [], countByCol, levels: 0 };
	}

	const sorted = items
		.filter(
			(item) =>
				!isHiddenDisplay(item) && item.startDay <= last && item.endDay > first,
		)
		.sort((a, b) => {
			const clampedStartDiff =
				Math.max(a.startDay, first) - Math.max(b.startDay, first);
			if (clampedStartDiff !== 0) {
				return clampedStartDiff;
			}
			const durationDiff = b.endDay - b.startDay - (a.endDay - a.startDay);
			if (durationDiff !== 0) {
				return durationDiff;
			}
			const allDayDiff = Number(b.allDay) - Number(a.allDay);
			if (allDayDiff !== 0) {
				return allDayDiff;
			}
			return order ? order(a, b) : 0;
		});

	const occupiedByLevel: number[][] = [];
	const placements: Array<WeekChipPlacement<T>> = [];

	for (const item of sorted) {
		const startCol = colOfDay(days, item.startDay);
		const endCol = colOfDay(days, item.endDay);
		if (endCol <= startCol) {
			continue;
		}

		let level = 0;
		for (; ; level++) {
			let levelOccupied = occupiedByLevel[level];
			if (!levelOccupied) {
				levelOccupied = [];
				occupiedByLevel[level] = levelOccupied;
			}
			let free = true;
			for (let c = startCol; c < endCol; c++) {
				if (levelOccupied[c] === 1) {
					free = false;
					break;
				}
			}
			if (free) {
				for (let c = startCol; c < endCol; c++) {
					levelOccupied[c] = 1;
				}
				break;
			}
		}

		for (let c = startCol; c < endCol; c++) {
			countByCol[c] = (countByCol[c] ?? 0) + 1;
		}

		const startDay = days[startCol];
		const endDay = days[endCol - 1];
		placements.push({
			item,
			startCol,
			endCol,
			level,
			isStart: startDay !== undefined && item.startDay >= startDay,
			isEnd: endDay !== undefined && item.endDay <= endDay + 1,
		});
	}

	return {
		placements,
		countByCol,
		levels: occupiedByLevel.length,
	};
}

/**
 * Computes direct-display and "+N" overflow track capacities for a week row in chips mode.
 */
export function resolveWeekChipLimit(
	dayMaxEvents: boolean | number | null,
	availableHeightPx: number,
	chipHeightPx: number,
	gapPx: number,
): WeekChipRowLimit | null {
	if (dayMaxEvents === false) {
		return null;
	}
	const step = Math.max(1, chipHeightPx + gapPx);
	const fits = Math.max(1, Math.floor((availableHeightPx + gapPx) / step));
	const cap =
		typeof dayMaxEvents === "number" && dayMaxEvents > 0
			? Math.min(dayMaxEvents, fits)
			: fits;
	const fit = cap;
	const withMore = cap >= fits ? Math.max(1, cap - 1) : Math.max(1, cap);
	return { fit, withMore, fits };
}

/**
 * Applies per-column overflow constraints across spanning tracks without stranding hidden bars
 * or colliding chips with "+N" buttons.
 */
export function planWeekChipVisibility<T extends SpanningChipItem>(
	layout: WeekChipLayout<T>,
	limit: WeekChipRowLimit | null,
	options?: { draggingId?: string | null },
): PlannedWeekChips<T> {
	const colCount = layout.countByCol.length;
	const hiddenByCol: T[][] = Array.from({ length: colCount }, () => []);
	const moreRowByCol = new Array<number>(colCount).fill(0);
	const draggingId = options?.draggingId ?? null;

	if (limit === null) {
		let maxLevel = -1;
		const visible = layout.placements.map((placement) => {
			if (placement.level > maxLevel) {
				maxLevel = placement.level;
			}
			return { placement, renderLevel: placement.level };
		});
		return { visible, hiddenByCol, moreRowByCol, maxLevel };
	}

	const overflow = new Array<boolean>(colCount).fill(false);
	for (let c = 0; c < colCount; c++) {
		if ((layout.countByCol[c] ?? 0) > limit.fit) {
			overflow[c] = true;
		}
	}
	for (const p of layout.placements) {
		const isSpecial = p.item.item.preview === true || p.item.id === draggingId;
		if (isSpecial || p.level < limit.fit) {
			continue;
		}
		for (let c = p.startCol; c < p.endCol; c++) {
			overflow[c] = true;
		}
	}

	const roomForCol = (col: number): number => (overflow[col] ? limit.withMore : limit.fit);

	let changed = true;
	while (changed) {
		changed = false;
		for (const p of layout.placements) {
			const isSpecial = p.item.item.preview === true || p.item.id === draggingId;
			if (isSpecial) {
				continue;
			}
			let minRoom = Number.POSITIVE_INFINITY;
			for (let c = p.startCol; c < p.endCol; c++) {
				const room = roomForCol(c);
				if (room < minRoom) {
					minRoom = room;
				}
			}
			if (p.level >= minRoom) {
				for (let c = p.startCol; c < p.endCol; c++) {
					if (!overflow[c]) {
						overflow[c] = true;
						changed = true;
					}
				}
			}
		}
	}

	const visible: Array<VisibleWeekChipPlacement<T>> = [];
	const previewLevels = new Array<number>(colCount).fill(0);
	const maxVisibleLevelByCol = new Array<number>(colCount).fill(-1);
	let maxLevel = -1;

	for (const p of layout.placements) {
		let room = Number.POSITIVE_INFINITY;
		for (let c = p.startCol; c < p.endCol; c++) {
			const colRoom = roomForCol(c);
			if (colRoom < room) {
				room = colRoom;
			}
		}

		let renderLevel = p.level;
		if (renderLevel >= room) {
			if (p.item.item.preview === true) {
				renderLevel = 0;
				for (let c = p.startCol; c < p.endCol; c++) {
					renderLevel = Math.max(
						renderLevel,
						roomForCol(c) + 1,
						previewLevels[c] ?? 0,
					);
				}
				for (let c = p.startCol; c < p.endCol; c++) {
					previewLevels[c] = renderLevel + 1;
				}
			} else if (p.item.id === draggingId) {
				renderLevel = Math.max(0, room - 1);
			} else {
				for (let c = p.startCol; c < p.endCol; c++) {
					hiddenByCol[c]?.push(p.item);
				}
				continue;
			}
		}

		if (renderLevel > maxLevel) {
			maxLevel = renderLevel;
		}
		for (let c = p.startCol; c < p.endCol; c++) {
			if (renderLevel > (maxVisibleLevelByCol[c] ?? -1)) {
				maxVisibleLevelByCol[c] = renderLevel;
			}
		}
		visible.push({ placement: p, renderLevel });
	}

	for (let c = 0; c < colCount; c++) {
		const hidden = hiddenByCol[c];
		if (hidden && hidden.length > 0) {
			moreRowByCol[c] = (maxVisibleLevelByCol[c] ?? -1) + 1;
		}
	}

	return { visible, hiddenByCol, moreRowByCol, maxLevel };
}

function formatPct(fraction: number): string {
	return `${String(Math.round(fraction * 1e4) / 100)}%`;
}

function readCssPixelProperty(
	cs: CSSStyleDeclaration,
	name: string,
	fallback: number,
): number {
	const parsed = Number.parseFloat(cs.getPropertyValue(name));
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

interface SavedMethodPatch {
	target: object;
	key: string;
	hadOwn: boolean;
	descriptor: PropertyDescriptor | undefined;
}

function installMethodPatch(
	target: object,
	key: string,
	wrapper: (...args: unknown[]) => unknown,
): SavedMethodPatch {
	const hadOwn = Object.prototype.hasOwnProperty.call(target, key);
	const descriptor = Object.getOwnPropertyDescriptor(target, key);
	Object.defineProperty(target, key, {
		value: wrapper,
		configurable: true,
		writable: true,
		enumerable: descriptor ? descriptor.enumerable : false,
	});
	return { target, key, hadOwn, descriptor };
}

function restoreMethodPatch(saved: SavedMethodPatch): void {
	if (saved.hadOwn && saved.descriptor) {
		Object.defineProperty(saved.target, saved.key, saved.descriptor);
	} else {
		Reflect.deleteProperty(saved.target, saved.key);
	}
}

interface PatchedDayGridEntry {
	dayGridView: DayGridViewLike;
	patches: SavedMethodPatch[];
}

interface PatchedCalendarEntry {
	handle: CalendarViewHandle;
	createViewPatch: SavedMethodPatch;
	patchedView: PatchedDayGridEntry | null;
}

/**
 * Renders spanning multi-day chips in TaskNotes month `chips` mode (`560px–850px` / tablets),
 * matching `full` mode's continuous multi-day bars while keeping `chips` compact heights and UX.
 */
export class MonthChipSpanningController {
	private readonly app: App;
	private enabled = false;
	private workspaceEventRefs: EventRef[] = [];
	private observedContainers = new Map<HTMLElement, MutationObserver>();
	private styledDocuments = new Set<Document>();
	private patchedCalendars = new Map<object, PatchedCalendarEntry>();
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
			this.patchedCalendars.size === 0 &&
			this.styledDocuments.size === 0
		) {
			return;
		}
		this.enabled = false;

		this.clearSyncTimer();
		this.disconnectAllObservers();
		this.unregisterWorkspaceListeners();
		this.unpatchAllCalendars();
		this.clearAllBodyClasses();
	}

	syncViews(): void {
		if (!this.enabled) {
			return;
		}

		this.syncObservedContainers();

		const activeHandles = getActiveCalendarViews(this.app);
		const activeCalendars = new Set<object>();

		for (const handle of activeHandles) {
			this.applyBodyClass(handle.containerEl.ownerDocument);

			const rawCalendar = handle.rawCalendar;
			if (!rawCalendar || isCalendarDestroyed(rawCalendar)) {
				continue;
			}
			activeCalendars.add(rawCalendar);

			let entry = this.patchedCalendars.get(rawCalendar);
			if (!entry) {
				const created = this.patchCalendar(rawCalendar, handle);
				if (!created) {
					continue;
				}
				entry = created;
				this.patchedCalendars.set(rawCalendar, entry);
			} else {
				entry.handle = handle;
			}

			const currentDayGrid = getCalendarDayGridView(rawCalendar);
			if (currentDayGrid) {
				if (entry.patchedView?.dayGridView !== currentDayGrid) {
					if (entry.patchedView) {
						this.unpatchDayGridView(entry.patchedView, false, null);
						entry.patchedView = null;
					}
					entry.patchedView = this.patchDayGridView(currentDayGrid);
					this.safeRenderDayGridView(currentDayGrid);
					syncCalendarMonthChipControls(handle.rawView);
				}
			} else if (entry.patchedView) {
				this.unpatchDayGridView(entry.patchedView, false, null);
				entry.patchedView = null;
			}
		}

		for (const [rawCalendar, entry] of this.patchedCalendars.entries()) {
			if (!activeCalendars.has(rawCalendar) || isCalendarDestroyed(rawCalendar)) {
				this.unpatchCalendarEntry(entry, false);
				this.patchedCalendars.delete(rawCalendar);
			}
		}
	}

	private patchCalendar(
		rawCalendar: object,
		handle: CalendarViewHandle,
	): PatchedCalendarEntry | null {
		if (!isRecord(rawCalendar)) {
			return null;
		}
		const origCreateView = asCallable(rawCalendar.createView);
		if (!origCreateView) {
			return null;
		}

		let entry: PatchedCalendarEntry | null = null;
		const createViewPatch = installMethodPatch(rawCalendar, "createView", (...args) => {
			const created = origCreateView.apply(rawCalendar, args);
			if (!this.enabled || !entry) {
				return created;
			}
			if (entry.patchedView) {
				this.unpatchDayGridView(entry.patchedView, false, null);
				entry.patchedView = null;
			}
			const dayGridView = asDayGridView(created);
			if (dayGridView) {
				entry.patchedView = this.patchDayGridView(dayGridView);
			}
			return created;
		});

		entry = {
			handle,
			createViewPatch,
			patchedView: null,
		};
		return entry;
	}

	private patchDayGridView(dayGridView: DayGridViewLike): PatchedDayGridEntry {
		const rawView = dayGridView as unknown as Record<string, unknown>;
		const origRender = dayGridView.render;
		const origRenderDots = dayGridView.renderDots;
		const patches: SavedMethodPatch[] = [];

		let suppressEmptyPoolEnd = false;
		const deferredPoolWeeks = new Set<DayGridWeekLike>();

		for (const week of dayGridView.weeks) {
			const origPoolEnd = week.pool.end;
			patches.push(
				installMethodPatch(week.pool, "end", () => {
					if (
						suppressEmptyPoolEnd &&
						dayGridView.el.classList.contains("tnc-dg--chips") &&
						(!week.pool.used || week.pool.used.size === 0)
					) {
						deferredPoolWeeks.add(week);
						return;
					}
					origPoolEnd.call(week.pool);
				}),
			);
		}

		const flushDeferredWeekPool = (week: DayGridWeekLike): void => {
			if (!deferredPoolWeeks.has(week)) {
				return;
			}
			deferredPoolWeeks.delete(week);
			const prevSuppress = suppressEmptyPoolEnd;
			suppressEmptyPoolEnd = false;
			try {
				week.pool.begin();
				week.pool.end();
			} finally {
				suppressEmptyPoolEnd = prevSuppress;
			}
		};

		patches.push(
			installMethodPatch(rawView, "render", (change: unknown) => {
				const prevSuppress = suppressEmptyPoolEnd;
				suppressEmptyPoolEnd = this.enabled;
				try {
					origRender.call(dayGridView, change);
				} finally {
					suppressEmptyPoolEnd = prevSuppress;
					for (const week of Array.from(deferredPoolWeeks)) {
						flushDeferredWeekPool(week);
					}
					if (!dayGridView.dotsMode || !dayGridView.el.classList.contains("tnc-dg--chips")) {
						for (const week of dayGridView.weeks) {
							this.clearWeekSpanningMetadata(week);
						}
					}
				}
			}),
		);

		patches.push(
			installMethodPatch(rawView, "renderDots", (weekArg: unknown) => {
				const week = weekArg as DayGridWeekLike;
				if (!this.enabled || !dayGridView.el.classList.contains("tnc-dg--chips")) {
					this.clearWeekSpanningMetadata(week);
					flushDeferredWeekPool(week);
					origRenderDots.call(dayGridView, week);
					return;
				}

				const ctx = readDayGridContext(dayGridView);
				if (!ctx) {
					this.clearWeekSpanningMetadata(week);
					flushDeferredWeekPool(week);
					origRenderDots.call(dayGridView, week);
					return;
				}

				const prevSuppress = suppressEmptyPoolEnd;
				suppressEmptyPoolEnd = false;
				try {
					this.renderSpanningChipsWeek(dayGridView, week, ctx);
					deferredPoolWeeks.delete(week);
				} catch (error) {
					console.warn(
						"Failed to render spanning month chips; falling back to default chip layout:",
						error,
					);
					this.clearWeekSpanningMetadata(week);
					week.more.replaceChildren();
					try {
						week.pool.clear();
					} catch {
						// Ignore cleanup failure during fallback.
					}
					deferredPoolWeeks.delete(week);
					origRenderDots.call(dayGridView, week);
				} finally {
					suppressEmptyPoolEnd = prevSuppress;
				}
			}),
		);

		return { dayGridView, patches };
	}

	private renderSpanningChipsWeek(
		dayGridView: DayGridViewLike,
		week: DayGridWeekLike,
		ctx: DayGridContextInfo,
	): void {
		// Clear cell dots pools/counts without hiding .tnc-dg-dots (DayGridView.render checks box.clientHeight >= 44).
		for (const cell of week.dots) {
			cell.pool.begin();
			cell.pool.end();
			cell.count.textContent = "";
			cell.count.remove();
		}

		const firstDotBox = week.dots[0]?.box;
		const cs = ctx.win.getComputedStyle(firstDotBox ?? week.row);
		const chipHeight = readCssPixelProperty(cs, "--tnc-chip-h", DEFAULT_CHIP_HEIGHT_PX);
		const chipGap = readCssPixelProperty(cs, "--tnc-dot-gap", DEFAULT_CHIP_GAP_PX);
		const topPx =
			typeof dayGridView.topPx === "number" && dayGridView.topPx > 0
				? dayGridView.topPx
				: DEFAULT_TOP_PX;

		const boxHeight = firstDotBox?.clientHeight ?? 0;
		const availHeight =
			boxHeight > 0 ? boxHeight : Math.max(0, week.row.clientHeight - topPx - 4);

		const items = dayGridView.itemsFor(week);
		const layout = layoutWeekChips(items, week.days, ctx.order ?? undefined);
		const limit = resolveWeekChipLimit(ctx.dayMaxEvents, availHeight, chipHeight, chipGap);
		const plan = planWeekChipVisibility(layout, limit, {
			draggingId: ctx.draggingId,
		});

		const colCount = week.days.length;
		week.pool.begin();
		for (const { placement, renderLevel } of plan.visible) {
			const startDay = week.days[placement.startCol];
			if (startDay === undefined) {
				continue;
			}
			const el = week.pool.place(placement.item.id, {
				n: placement.item,
				day: startDay,
				isStart: placement.isStart,
				isEnd: placement.isEnd,
				variant: "indicator",
				mirror: false,
			});

			const startDate = formatDayNumber(startDay);
			if (startDate) {
				el.dataset.tnceStartDate = startDate;
			} else {
				delete el.dataset.tnceStartDate;
			}
			const spanCols = placement.endCol - placement.startCol;
			el.dataset.tnceSpanCols = String(spanCols);

			const leftFraction = placement.startCol / colCount;
			const widthFraction = spanCols / colCount;
			el.style.setProperty(
				"left",
				`calc(${formatPct(leftFraction)} + ${String(SPAN_HORIZONTAL_INSET_PX)}px)`,
			);
			el.style.setProperty(
				"width",
				`calc(${formatPct(widthFraction)} - ${String(SPAN_HORIZONTAL_INSET_PX * 2)}px)`,
			);
			el.style.setProperty(
				"top",
				`calc(var(--tnc-dg-top-h) + ${String(renderLevel)} * (var(--tnc-chip-h, ${String(DEFAULT_CHIP_HEIGHT_PX)}px) + var(--tnc-dot-gap, ${String(DEFAULT_CHIP_GAP_PX)}px)))`,
			);
		}
		week.pool.end();

		week.days.forEach((day, colIndex) => {
			const cell = week.cells[colIndex];
			if (!cell) {
				return;
			}
			const count = layout.countByCol[colIndex] ?? 0;
			const dateLabel = ctx.formatLongDate(day);
			cell.setAttribute(
				"aria-label",
				count > 0 ? `${dateLabel}, ${ctx.formatItemCount(count)}` : dateLabel,
			);
			if (count > 0) {
				cell.dataset.tnceHasEvents = "true";
			} else {
				delete cell.dataset.tnceHasEvents;
			}
		});

		week.more.replaceChildren();
		plan.hiddenByCol.forEach((hiddenItems, colIndex) => {
			if (hiddenItems.length === 0) {
				return;
			}
			const day = week.days[colIndex];
			if (day === undefined) {
				return;
			}
			const button = ctx.doc.createElement("button");
			button.type = "button";
			button.className = "tnc-more tnce-chip-more";
			button.setAttribute("aria-haspopup", "dialog");
			button.setAttribute("data-day", String(day));
			button.setAttribute("data-tnc-no-drag", "");
			button.setAttribute("aria-label", ctx.formatMoreLabel(hiddenItems.length));
			button.textContent = `+${String(hiddenItems.length)}`;

			const rowLevel = plan.moreRowByCol[colIndex] ?? 0;
			button.style.setProperty(
				"left",
				`calc(${formatPct(colIndex / colCount)} + ${String(SPAN_HORIZONTAL_INSET_PX)}px)`,
			);
			button.style.setProperty(
				"width",
				`calc(${formatPct(1 / colCount)} - ${String(SPAN_HORIZONTAL_INSET_PX * 2)}px)`,
			);
			button.style.setProperty(
				"top",
				`calc(var(--tnc-dg-top-h) + ${String(rowLevel)} * (var(--tnc-chip-h, ${String(DEFAULT_CHIP_HEIGHT_PX)}px) + var(--tnc-dot-gap, ${String(DEFAULT_CHIP_GAP_PX)}px)))`,
			);

			button.addEventListener("click", (ev) => {
				if (dayGridView.el.closest(".tn-calendar-composition")) {
					return;
				}
				ctx.openMore(day, button, ev);
			});

			week.more.append(button);
		});

		if (limit === null) {
			const step = chipHeight + chipGap;
			const need = plan.maxLevel >= 0 ? (plan.maxLevel + 1) * step - chipGap : 0;
			week.row.style.setProperty("--tnc-levels", String(plan.maxLevel + 1));
			week.row.style.setProperty("--tnc-dg-need", `${String(topPx + need + CELL_PAD_PX)}px`);
		} else {
			week.row.style.setProperty("--tnc-levels", "0");
			week.row.style.removeProperty("--tnc-dg-need");
		}
	}

	private clearWeekSpanningMetadata(week: DayGridWeekLike): void {
		for (const cell of week.cells) {
			delete cell.dataset.tnceHasEvents;
		}
		for (const button of Array.from(week.more.querySelectorAll(".tnce-chip-more"))) {
			button.remove();
		}
		for (const item of Array.from(week.layer.querySelectorAll<HTMLElement>(".tnc-item"))) {
			delete item.dataset.tnceStartDate;
			delete item.dataset.tnceSpanCols;
		}
	}

	private safeRenderDayGridView(dayGridView: DayGridViewLike): void {
		try {
			dayGridView.render(null);
		} catch (error) {
			console.warn("Failed to render TaskNotes DayGridView:", error);
		}
	}

	private unpatchDayGridView(
		patched: PatchedDayGridEntry,
		rerender: boolean,
		handle: CalendarViewHandle | null,
	): void {
		for (let i = patched.patches.length - 1; i >= 0; i--) {
			const patch = patched.patches[i];
			if (patch) {
				restoreMethodPatch(patch);
			}
		}

		for (const week of patched.dayGridView.weeks) {
			this.clearWeekSpanningMetadata(week);
		}

		if (rerender && (!handle || handle.containerEl.isConnected)) {
			this.safeRenderDayGridView(patched.dayGridView);
			if (handle) {
				syncCalendarMonthChipControls(handle.rawView);
			}
		}
	}

	private unpatchCalendarEntry(entry: PatchedCalendarEntry, rerender: boolean): void {
		restoreMethodPatch(entry.createViewPatch);
		const isDestroyed = isCalendarDestroyed(entry.handle.rawCalendar ?? {});
		if (entry.patchedView) {
			this.unpatchDayGridView(
				entry.patchedView,
				rerender && !isDestroyed,
				entry.handle,
			);
			entry.patchedView = null;
		}
	}

	private unpatchAllCalendars(): void {
		for (const entry of this.patchedCalendars.values()) {
			this.unpatchCalendarEntry(entry, true);
		}
		this.patchedCalendars.clear();
	}

	private applyBodyClass(doc: Document | null | undefined): void {
		if (!doc?.body) {
			return;
		}
		doc.body.classList.add(MONTH_CHIP_SPANNING_BODY_CLASS);
		this.styledDocuments.add(doc);
	}

	private clearAllBodyClasses(): void {
		for (const doc of this.styledDocuments) {
			try {
				doc.body.classList.remove(MONTH_CHIP_SPANNING_BODY_CLASS);
			} catch {
				// Ignore documents from closed popout windows.
			}
		}
		this.styledDocuments.clear();
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
