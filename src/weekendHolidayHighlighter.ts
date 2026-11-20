import { type App, type EventRef, setTooltip } from "obsidian";
import {
	buildCalendarColorKey,
	CALENDAR_COLOR_KEY_PATTERN,
} from "./calendarColorOverrides";
import { getJapaneseHolidayName } from "./japaneseHolidays";
import {
	formatLocalDateString,
	getBasesLeafContainers,
	getCacheableCalendarProviders,
	isRecord,
	isTaskNotesAvailable,
	parseDayNumber,
	parseLocalDateParts,
	safeCall,
	subscribeExternalCalendarChanges,
} from "./tasknotesBridge";

export const WEEKEND_HOLIDAY_BODY_CLASS = "tnce-weekend-holiday-colors";
export const DAY_KIND_ATTR = "data-tnce-day-kind";
export const HOLIDAY_TOOLTIP_ATTR = "data-tnce-holiday";
export const HOLIDAY_LABEL_CLASS = "tnce-holiday-label";
export const MAX_HOLIDAY_CALENDAR_KEYS = 20;
export const MAX_EXTERNAL_HOLIDAY_EVENT_SPAN_DAYS = 31;

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const EXPLICIT_TZ_PATTERN = /(?:[zZ]|[+-]\d{2}:?\d{2})$/;
const MS_PER_DAY = 86_400_000;

const DAY_ELEMENT_SELECTOR =
	".tnc-dg-day[data-date], .tnc-dh[data-date], .tnc-ym-day[data-date], .tnc-list-day[data-date], .tnc-strip-day[data-date]";

export type CalendarDayKind = "saturday" | "sunday" | "holiday";

export interface WeekendHolidayOptions {
	enableJapaneseHolidays: boolean;
	holidayCalendarKeys: readonly string[];
}

/**
 * Validates persisted hashed holiday calendar keys, deduplicating and capping at `MAX_HOLIDAY_CALENDAR_KEYS`.
 */
export function sanitizeHolidayCalendarKeys(raw: unknown): string[] {
	if (!Array.isArray(raw)) {
		return [];
	}

	const sanitized: string[] = [];
	const seen = new Set<string>();
	for (const entry of raw) {
		if (sanitized.length >= MAX_HOLIDAY_CALENDAR_KEYS) {
			break;
		}
		if (typeof entry !== "string" || !CALENDAR_COLOR_KEY_PATTERN.test(entry)) {
			continue;
		}
		if (seen.has(entry)) {
			continue;
		}
		seen.add(entry);
		sanitized.push(entry);
	}
	return sanitized;
}

function formatUtcDayNumber(dayNum: number): string {
	const date = new Date(dayNum * MS_PER_DAY);
	return `${String(date.getUTCFullYear()).padStart(4, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function parseIsoBoundaryToLocalDate(raw: string, subtractOneMsForEnd = false): string | null {
	const trimmed = raw.trim();
	if (DATE_ONLY_PATTERN.test(trimmed)) {
		return parseLocalDateParts(trimmed) ? trimmed : null;
	}
	if (EXPLICIT_TZ_PATTERN.test(trimmed)) {
		const parsed = new Date(trimmed);
		if (Number.isNaN(parsed.getTime())) {
			return null;
		}
		const adjusted = subtractOneMsForEnd
			? new Date(parsed.getTime() - 1)
			: parsed;
		return formatLocalDateString(adjusted);
	}

	const wallDate = trimmed.slice(0, 10);
	if (!parseLocalDateParts(wallDate)) {
		return null;
	}
	if (subtractOneMsForEnd) {
		const parsedWall = new Date(trimmed);
		if (!Number.isNaN(parsedWall.getTime())) {
			return formatLocalDateString(new Date(parsedWall.getTime() - 1));
		}
	}
	return wallDate;
}

function collectEventDateStrings(entry: Record<string, unknown>): string[] {
	const startRaw = typeof entry.start === "string" ? entry.start.trim() : "";
	if (!startRaw) {
		return [];
	}
	const endRaw = typeof entry.end === "string" ? entry.end.trim() : "";
	const isAllDay = entry.allDay === true || DATE_ONLY_PATTERN.test(startRaw);

	if (isAllDay) {
		const startDate = startRaw.slice(0, 10);
		const startDay = parseDayNumber(startDate);
		if (startDay === null) {
			return [];
		}

		let span = 1;
		if (endRaw) {
			const endDay = parseDayNumber(endRaw.slice(0, 10));
			if (endDay !== null && endDay > startDay) {
				span = Math.min(endDay - startDay, MAX_EXTERNAL_HOLIDAY_EVENT_SPAN_DAYS);
			}
		}

		const dates: string[] = [];
		for (let offset = 0; offset < span; offset += 1) {
			dates.push(formatUtcDayNumber(startDay + offset));
		}
		return dates;
	}

	const startDate = parseIsoBoundaryToLocalDate(startRaw, false);
	if (!startDate) {
		return [];
	}
	const startDay = parseDayNumber(startDate);
	if (startDay === null) {
		return [startDate];
	}

	let span = 1;
	if (endRaw) {
		const endDate = parseIsoBoundaryToLocalDate(endRaw, true);
		const endDay = endDate ? parseDayNumber(endDate) : null;
		if (endDay !== null && endDay >= startDay) {
			span = Math.min(endDay - startDay + 1, MAX_EXTERNAL_HOLIDAY_EVENT_SPAN_DAYS);
		}
	}

	const dates: string[] = [];
	for (let offset = 0; offset < span; offset += 1) {
		dates.push(formatUtcDayNumber(startDay + offset));
	}
	return dates;
}

function addHolidayTitle(
	holidayMap: Map<string, string[]>,
	dateStr: string,
	title: string,
): void {
	const existing = holidayMap.get(dateStr);
	if (!existing) {
		holidayMap.set(dateStr, [title]);
		return;
	}
	if (!existing.includes(title)) {
		existing.push(title);
	}
}

/**
 * Collects holiday date titles (`YYYY-MM-DD` -> combined title) from TaskNotes'
 * already-loaded external calendars selected via hashed keys, without making network requests.
 */
export function collectExternalHolidayDateMap(
	app: App,
	holidayCalendarKeys: readonly string[],
): Map<string, string> {
	const selectedKeys = new Set(sanitizeHolidayCalendarKeys(holidayCalendarKeys));
	if (selectedKeys.size === 0) {
		return new Map();
	}

	const groupedTitles = new Map<string, string[]>();
	const providers = getCacheableCalendarProviders(app);

	for (const target of providers) {
		const eventsRaw = safeCall(target.service, "getAllEvents");
		if (!Array.isArray(eventsRaw) || eventsRaw.length === 0) {
			continue;
		}

		let matchesSubscription: (subscriptionId: string) => boolean;
		if (target.kind === "ics") {
			matchesSubscription = (subscriptionId) =>
				selectedKeys.has(buildCalendarColorKey("ics", subscriptionId));
		} else {
			const providerId = target.key === "microsoft" ? "microsoft" : "google";
			const prefix = providerId === "microsoft" ? "microsoft-" : "google-";

			let primaryGoogleId: string | null = null;
			if (providerId === "google") {
				const calendarsRaw = safeCall(target.service, "getAvailableCalendars");
				if (Array.isArray(calendarsRaw)) {
					for (const cal of calendarsRaw) {
						if (
							isRecord(cal) &&
							cal.primary === true &&
							typeof cal.id === "string" &&
							cal.id.length > 0
						) {
							primaryGoogleId = cal.id;
							break;
						}
					}
				}
			}

			matchesSubscription = (subscriptionId) => {
				if (!subscriptionId.startsWith(prefix)) {
					return false;
				}
				const calId = subscriptionId.slice(prefix.length);
				if (selectedKeys.has(buildCalendarColorKey(providerId, calId))) {
					return true;
				}
				if (providerId === "google" && primaryGoogleId) {
					if (calId === "primary") {
						return selectedKeys.has(buildCalendarColorKey("google", primaryGoogleId));
					}
					if (calId === primaryGoogleId) {
						return selectedKeys.has(buildCalendarColorKey("google", "primary"));
					}
				}
				return false;
			};
		}

		for (const entry of eventsRaw) {
			if (!isRecord(entry) || typeof entry.subscriptionId !== "string") {
				continue;
			}
			if (!matchesSubscription(entry.subscriptionId)) {
				continue;
			}
			const title = typeof entry.title === "string" ? entry.title.trim() : "";
			if (!title) {
				continue;
			}
			for (const dateStr of collectEventDateStrings(entry)) {
				addHolidayTitle(groupedTitles, dateStr, title);
			}
		}
	}

	const result = new Map<string, string>();
	for (const [dateStr, titles] of groupedTitles.entries()) {
		result.set(dateStr, titles.join(" / "));
	}
	return result;
}

function getUtcWeekdayFromDateStr(dateStr: string): number | null {
	const parts = parseLocalDateParts(dateStr);
	if (!parts) {
		return null;
	}
	return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
}

function resolveDayInfo(
	dateStr: string,
	options: WeekendHolidayOptions,
	externalHolidays: ReadonlyMap<string, string>,
): { kind: CalendarDayKind | null; holidayName: string | null } {
	const weekday = getUtcWeekdayFromDateStr(dateStr);
	if (weekday === null) {
		return { kind: null, holidayName: null };
	}

	const jpName = options.enableJapaneseHolidays ? getJapaneseHolidayName(dateStr) : null;
	const extName = externalHolidays.get(dateStr) ?? null;

	const holidayName: string | null =
		jpName && extName
			? jpName === extName
				? jpName
				: `${jpName} / ${extName}`
			: (jpName ?? extName);

	if (holidayName !== null) {
		return { kind: "holiday", holidayName };
	}
	if (weekday === 0) {
		return { kind: "sunday", holidayName: null };
	}
	if (weekday === 6) {
		return { kind: "saturday", holidayName: null };
	}
	return { kind: null, holidayName: null };
}

function getTooltipTargetForDay(dayEl: HTMLElement): HTMLElement {
	if (dayEl.classList.contains("tnc-dg-day")) {
		return dayEl.querySelector<HTMLElement>(".tnc-dg-num") ?? dayEl;
	}
	if (dayEl.classList.contains("tnc-dh")) {
		return (
			dayEl.querySelector<HTMLElement>(".tnc-dh-label") ??
			dayEl.querySelector<HTMLElement>(".tnc-dh-num") ??
			dayEl
		);
	}
	if (dayEl.classList.contains("tnc-ym-day")) {
		return dayEl.querySelector<HTMLElement>(".tnc-ym-num") ?? dayEl;
	}
	if (dayEl.classList.contains("tnc-strip-day")) {
		return dayEl.querySelector<HTMLElement>(".tnc-strip-num") ?? dayEl;
	}
	if (dayEl.classList.contains("tnc-list-day")) {
		return dayEl.querySelector<HTMLElement>(".tnc-list-day-link") ?? dayEl;
	}
	return dayEl;
}

function clearDayTooltip(targetEl: HTMLElement): void {
	const prevHoliday = targetEl.getAttribute(HOLIDAY_TOOLTIP_ATTR);
	if (prevHoliday === null) {
		return;
	}
	setTooltip(targetEl, "");
	targetEl.removeAttribute(HOLIDAY_TOOLTIP_ATTR);
	if (targetEl.getAttribute("aria-label") === prevHoliday) {
		targetEl.removeAttribute("aria-label");
	}
	targetEl.removeAttribute("data-tooltip-position");
}

function syncDayTooltip(dayEl: HTMLElement, holidayName: string | null): void {
	const tooltipTarget = getTooltipTargetForDay(dayEl);
	if (holidayName === null) {
		clearDayTooltip(tooltipTarget);
		return;
	}
	if (tooltipTarget.getAttribute(HOLIDAY_TOOLTIP_ATTR) === holidayName) {
		return;
	}
	setTooltip(tooltipTarget, holidayName, { placement: "top" });
	tooltipTarget.setAttribute(HOLIDAY_TOOLTIP_ATTR, holidayName);
}

function setElementDayKind(el: HTMLElement, kind: CalendarDayKind | null): void {
	if (kind === null) {
		el.removeAttribute(DAY_KIND_ATTR);
		return;
	}
	if (el.getAttribute(DAY_KIND_ATTR) !== kind) {
		el.setAttribute(DAY_KIND_ATTR, kind);
	}
}

function updateHolidayLabelElement(
	parentEl: HTMLElement,
	modifierClass: string,
	holidayName: string | null,
	anchorBeforeEl: HTMLElement | null = null,
	anchorAfterEl: HTMLElement | null = null,
): void {
	const existing = parentEl.querySelector<HTMLElement>(`:scope > .${HOLIDAY_LABEL_CLASS}`);
	if (holidayName === null) {
		existing?.remove();
		return;
	}

	const labelEl = existing ?? parentEl.ownerDocument.createElement("span");
	const targetClass = `${HOLIDAY_LABEL_CLASS} ${modifierClass}`;
	if (labelEl.className !== targetClass) {
		labelEl.className = targetClass;
	}
	if (labelEl.textContent !== holidayName) {
		labelEl.textContent = holidayName;
	}
	if (labelEl.getAttribute("title") !== holidayName) {
		labelEl.setAttribute("title", holidayName);
	}

	if (anchorBeforeEl && anchorBeforeEl.parentElement === parentEl) {
		if (labelEl.parentElement !== parentEl || labelEl.nextElementSibling !== anchorBeforeEl) {
			anchorBeforeEl.before(labelEl);
		}
		return;
	}
	if (anchorAfterEl && anchorAfterEl.parentElement === parentEl) {
		if (labelEl.parentElement !== parentEl || anchorAfterEl.nextElementSibling !== labelEl) {
			anchorAfterEl.after(labelEl);
		}
		return;
	}
	if (labelEl.parentElement !== parentEl) {
		parentEl.appendChild(labelEl);
	}
}

function syncHolidayLabel(dayEl: HTMLElement, holidayName: string | null): void {
	if (dayEl.classList.contains("tnc-dg-day")) {
		const numEl = dayEl.querySelector<HTMLElement>(".tnc-dg-num");
		const topEl = dayEl.querySelector<HTMLElement>(".tnc-dg-top") ?? numEl?.parentElement ?? null;
		if (!topEl) {
			return;
		}
		updateHolidayLabelElement(topEl, `${HOLIDAY_LABEL_CLASS}--month`, holidayName, numEl);
		return;
	}

	if (dayEl.classList.contains("tnc-dh")) {
		const labelAnchor =
			dayEl.querySelector<HTMLElement>(":scope > .tnc-dh-link") ??
			dayEl.querySelector<HTMLElement>(":scope > .tnc-dh-label");
		updateHolidayLabelElement(
			dayEl,
			`${HOLIDAY_LABEL_CLASS}--dh`,
			holidayName,
			null,
			labelAnchor,
		);
		return;
	}

	if (dayEl.classList.contains("tnc-list-day")) {
		updateHolidayLabelElement(dayEl, `${HOLIDAY_LABEL_CLASS}--list`, holidayName);
	}
}

function isHolidayLabelNode(node: Node): boolean {
	return node.nodeType === 1 && (node as Element).classList.contains(HOLIDAY_LABEL_CLASS);
}

function weekdayToHeaderKind(weekday: number): "saturday" | "sunday" | null {
	if (weekday === 0) {
		return "sunday";
	}
	if (weekday === 6) {
		return "saturday";
	}
	return null;
}

/**
 * Highlights Saturdays in blue and Sundays/holidays in red (with holiday name tooltips)
 * across TaskNotes calendar views, cleaning up all DOM state cleanly on disable.
 */
export class WeekendHolidayHighlighter {
	private enabled = false;
	private workspaceEventRefs: EventRef[] = [];
	private providerUnsubscribe: (() => void) | null = null;
	private observedContainers = new Map<HTMLElement, MutationObserver>();
	private touchedContainers = new Set<HTMLElement>();
	private touchedDocs = new Set<Document>();
	private syncTimer: number | null = null;

	constructor(
		private readonly app: App,
		private readonly getOptions: () => WeekendHolidayOptions,
	) {}

	isEnabled(): boolean {
		return this.enabled;
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
				this.syncAllViews();
			});
		}

		this.syncAllViews();
	}

	disable(): void {
		if (
			!this.enabled &&
			this.observedContainers.size === 0 &&
			this.touchedContainers.size === 0 &&
			this.touchedDocs.size === 0
		) {
			return;
		}
		this.enabled = false;

		this.clearSyncTimer();
		this.disconnectAllObservers();
		this.unregisterWorkspaceListeners();
		this.clearProviderSubscription();
		this.cleanupAllDomState();
	}

	refresh(): void {
		if (!this.enabled) {
			return;
		}
		this.syncAllViews();
	}

	syncAllViews(): void {
		if (!this.enabled) {
			return;
		}

		this.ensureProviderSubscription();
		this.syncObservedContainers();

		const options = this.getOptions();
		const externalHolidays = collectExternalHolidayDateMap(
			this.app,
			options.holidayCalendarKeys,
		);

		const activeContainers = getBasesLeafContainers(this.app);
		for (const containerEl of activeContainers) {
			this.touchedContainers.add(containerEl);
			this.applyBodyClass(containerEl.ownerDocument);
			this.syncContainer(containerEl, options, externalHolidays);
		}

		for (const containerEl of Array.from(this.touchedContainers)) {
			if (!containerEl.isConnected) {
				this.touchedContainers.delete(containerEl);
			}
		}
	}

	private applyBodyClass(doc: Document | null | undefined): void {
		if (!doc?.body) {
			return;
		}
		this.touchedDocs.add(doc);
		doc.body.classList.add(WEEKEND_HOLIDAY_BODY_CLASS);
	}

	private syncContainer(
		containerEl: HTMLElement,
		options: WeekendHolidayOptions,
		externalHolidays: ReadonlyMap<string, string>,
	): void {
		for (const dayEl of containerEl.querySelectorAll<HTMLElement>(DAY_ELEMENT_SELECTOR)) {
			const dateStr = dayEl.dataset.date;
			if (!dateStr) {
				continue;
			}
			const { kind, holidayName } = resolveDayInfo(dateStr, options, externalHolidays);
			setElementDayKind(dayEl, kind);
			syncDayTooltip(dayEl, holidayName);
			syncHolidayLabel(dayEl, holidayName);
		}

		this.syncMonthHeaders(containerEl);
		this.syncYearHeaders(containerEl);
	}

	private syncMonthHeaders(containerEl: HTMLElement): void {
		for (const gridEl of containerEl.querySelectorAll<HTMLElement>(".tnc-dg-grid")) {
			const headDows = Array.from(
				gridEl.querySelectorAll<HTMLElement>(".tnc-dg-head > .tnc-dg-dow"),
			);
			const firstRowDays = Array.from(
				gridEl.querySelectorAll<HTMLElement>(".tnc-dg-row > .tnc-dg-day[data-date]"),
			).slice(0, headDows.length);
			if (headDows.length === 0 || firstRowDays.length === 0) {
				continue;
			}
			for (let index = 0; index < headDows.length; index += 1) {
				const headerEl = headDows[index];
				const sampleDayEl = firstRowDays[index];
				if (!headerEl || !sampleDayEl?.dataset.date) {
					continue;
				}
				const weekday = getUtcWeekdayFromDateStr(sampleDayEl.dataset.date);
				setElementDayKind(headerEl, weekday !== null ? weekdayToHeaderKind(weekday) : null);
			}
		}
	}

	private syncYearHeaders(containerEl: HTMLElement): void {
		for (const daysEl of containerEl.querySelectorAll<HTMLElement>(".tnc-ym-days")) {
			const dowHeaders = Array.from(daysEl.querySelectorAll<HTMLElement>(".tnc-ym-dow"));
			const firstDayEl = daysEl.querySelector<HTMLElement>(".tnc-ym-day[data-date]");
			if (dowHeaders.length === 0 || !firstDayEl?.dataset.date) {
				continue;
			}
			const firstWeekday = getUtcWeekdayFromDateStr(firstDayEl.dataset.date);
			if (firstWeekday === null) {
				continue;
			}
			const padCount = daysEl.querySelectorAll(".tnc-ym-pad").length;
			const col0Weekday = (((firstWeekday - (padCount % 7)) % 7) + 7) % 7;

			for (let col = 0; col < dowHeaders.length; col += 1) {
				const headerEl = dowHeaders[col];
				if (!headerEl) {
					continue;
				}
				setElementDayKind(headerEl, weekdayToHeaderKind((col0Weekday + col) % 7));
			}
		}
	}

	private cleanupAllDomState(): void {
		const containers = new Set<HTMLElement>([
			...this.touchedContainers,
			...getBasesLeafContainers(this.app),
		]);
		for (const containerEl of containers) {
			for (const markedEl of containerEl.querySelectorAll<HTMLElement>(
				`[${DAY_KIND_ATTR}]`,
			)) {
				markedEl.removeAttribute(DAY_KIND_ATTR);
			}
			for (const tooltipEl of containerEl.querySelectorAll<HTMLElement>(
				`[${HOLIDAY_TOOLTIP_ATTR}]`,
			)) {
				clearDayTooltip(tooltipEl);
			}
			for (const labelEl of containerEl.querySelectorAll<HTMLElement>(
				`.${HOLIDAY_LABEL_CLASS}`,
			)) {
				labelEl.remove();
			}
		}
		this.touchedContainers.clear();

		for (const doc of this.touchedDocs) {
			try {
				doc.body.classList.remove(WEEKEND_HOLIDAY_BODY_CLASS);
			} catch {
				// Ignore detached popup documents.
			}
		}
		this.touchedDocs.clear();
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
			// Observe childList only so attribute updates never re-trigger the observer loop.
			observer.observe(containerEl, { childList: true, subtree: true });
			this.observedContainers.set(containerEl, observer);
		}
	}

	private hasRelevantMutation(mutations: MutationRecord[]): boolean {
		for (const mutation of mutations) {
			if (mutation.type !== "childList") {
				continue;
			}
			const labelsOnly =
				Array.from(mutation.addedNodes).every(isHolidayLabelNode) &&
				Array.from(mutation.removedNodes).every(isHolidayLabelNode);
			if (!labelsOnly) {
				return true;
			}
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
			this.syncAllViews();
		}, 0);
	}

	private clearSyncTimer(): void {
		if (this.syncTimer !== null) {
			window.clearTimeout(this.syncTimer);
			this.syncTimer = null;
		}
	}
}
