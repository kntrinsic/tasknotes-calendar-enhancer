import { type App, TFile } from "obsidian";

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

/**
 * Parses a YYYY-MM-DD date string into the UTC epoch day number expected by `@tasknotes/calendar`.
 */
export function parseDayNumber(dateStr: string): number | null {
	const match = ISO_DATE_PATTERN.exec(dateStr.trim());
	if (!match) {
		return null;
	}
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	if (month < 1 || month > 12 || day < 1 || day > 31) {
		return null;
	}
	const date = new Date(0);
	date.setUTCFullYear(year, month - 1, day);
	date.setUTCHours(0, 0, 0, 0);
	if (
		date.getUTCFullYear() !== year ||
		date.getUTCMonth() !== month - 1 ||
		date.getUTCDate() !== day
	) {
		return null;
	}
	return Math.floor(date.getTime() / MS_PER_DAY);
}

export type ExternalCalendarProviderId = "google" | "microsoft" | "ics";

export interface ExternalCalendarItem {
	provider: ExternalCalendarProviderId;
	id: string;
	configKey: string;
	name: string;
	color?: string;
	primary?: boolean;
}

export interface ExternalCalendarGroup {
	provider: ExternalCalendarProviderId;
	title: string;
	items: ExternalCalendarItem[];
}

export interface HostedGoogleStatus {
	isHostedActive: boolean;
	isSignedIn: boolean;
	isConnected: boolean;
	shownCount: number;
	totalCount: number;
}

export interface ExternalCalendarSnapshot {
	groups: ExternalCalendarGroup[];
	hostedGoogle: HostedGoogleStatus | null;
}

export interface CalendarViewHandle {
	readonly rawView: object;
	readonly containerEl: HTMLElement;
	readonly toolbarEl: HTMLElement | null;
	getBooleanConfig(key: string, fallback: boolean): boolean;
	setCalendarToggle(key: string, visible: boolean): boolean;
	isMonthDayPanelEnabled(): boolean;
	isSelectionModeActive(): boolean;
	isCalendarEngineDragging(): boolean;
	hasEngineItemMeta(el: HTMLElement): boolean;
	openDayMorePopover(
		dateStr: string,
		anchorEl: HTMLElement,
		event: MouseEvent | KeyboardEvent,
	): boolean;
	openTaskFromPath(taskPath: string): Promise<boolean>;
}

type DynamicCallable = (...args: unknown[]) => unknown;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asCallable(value: unknown): DynamicCallable | null {
	return typeof value === "function" ? (value as DynamicCallable) : null;
}

function asNonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function isElementLike(value: unknown): value is HTMLElement {
	return (
		isRecord(value) &&
		typeof value.querySelector === "function" &&
		typeof value.closest === "function"
	);
}

function safeCall(target: unknown, methodName: string, ...args: unknown[]): unknown {
	if (!isRecord(target)) {
		return undefined;
	}
	const method = asCallable(target[methodName]);
	if (!method) {
		return undefined;
	}
	try {
		return method.apply(target, args);
	} catch (error) {
		console.warn(`TaskNotes bridge call "${methodName}" failed:`, error);
		return undefined;
	}
}

/**
 * Safely retrieves the active TaskNotes plugin instance without hard coupling.
 */
export function getTaskNotesPlugin(app: App): Record<string, unknown> | null {
	try {
		const pluginsRoot = (app as unknown as Record<string, unknown>).plugins;
		if (!isRecord(pluginsRoot)) {
			return null;
		}
		const pluginMap = pluginsRoot.plugins;
		if (!isRecord(pluginMap)) {
			return null;
		}
		const candidate = pluginMap.tasknotes;
		return isRecord(candidate) ? candidate : null;
	} catch {
		return null;
	}
}

export function isTaskNotesAvailable(app: App): boolean {
	return getTaskNotesPlugin(app) !== null;
}

/**
 * Finds the Obsidian Bases toolbar associated with a Bases view container element.
 */
export function findToolbarForContainer(containerEl: HTMLElement): HTMLElement | null {
	try {
		const basesViewEl = containerEl.closest(".bases-view");
		const parentToolbar =
			basesViewEl?.parentElement?.querySelector<HTMLElement>(".bases-toolbar") ?? null;
		if (parentToolbar) {
			return parentToolbar;
		}
		return containerEl.querySelector<HTMLElement>(".bases-toolbar");
	} catch {
		return null;
	}
}

/**
 * Collects DOM containers for all open Obsidian Bases leaves so observers stay scoped.
 */
export function getBasesLeafContainers(app: App): HTMLElement[] {
	const containers: HTMLElement[] = [];
	try {
		const workspace = app.workspace as unknown as Record<string, unknown>;
		const leaves = safeCall(workspace, "getLeavesOfType", "bases");
		if (!Array.isArray(leaves)) {
			return containers;
		}
		for (const leaf of leaves) {
			if (!isRecord(leaf) || !isRecord(leaf.view)) {
				continue;
			}
			const leafView = leaf.view;
			if (safeCall(leafView, "getViewType") !== "bases") {
				continue;
			}
			if (isElementLike(leafView.containerEl)) {
				containers.push(leafView.containerEl);
			}
		}
	} catch {
		return containers;
	}
	return containers;
}

function createCalendarViewHandle(
	app: App,
	innerView: Record<string, unknown>,
	containerEl: HTMLElement,
	config: Record<string, unknown>,
): CalendarViewHandle {
	const getBooleanConfig = (key: string, fallback: boolean): boolean => {
		const value = safeCall(config, "get", key);
		return typeof value === "boolean" ? value : fallback;
	};

	const setCalendarToggle = (key: string, visible: boolean): boolean => {
		// Guard against Bases API bug #1397 by refusing config writes on detached views.
		if (!containerEl.isConnected) {
			return false;
		}
		const getConfigFn = asCallable(config.get);
		const setConfigFn = asCallable(config.set);
		if (!getConfigFn || !setConfigFn) {
			return false;
		}

		try {
			setConfigFn.call(config, key, visible);
		} catch (error) {
			console.warn("Failed to update Bases calendar config toggle:", error);
			return false;
		}

		safeCall(innerView, "readEventToggles");
		if (asCallable(innerView.refresh)) {
			safeCall(innerView, "refresh");
		} else if (asCallable(innerView.refetchEvents)) {
			const pending = safeCall(innerView, "refetchEvents");
			if (isRecord(pending) && typeof pending.then === "function") {
				void Promise.resolve(pending).catch((error: unknown) => {
					console.warn("Failed to refetch TaskNotes calendar events:", error);
				});
			}
		}
		return true;
	};

	const isMonthDayPanelEnabled = (): boolean => {
		try {
			if (
				isRecord(innerView.viewOptions) &&
				innerView.viewOptions.showMonthDayPanel === true
			) {
				return true;
			}
			return containerEl.querySelector(".tn-calendar-composition") !== null;
		} catch {
			return false;
		}
	};

	const isSelectionModeActive = (): boolean => {
		try {
			const tasknotes = getTaskNotesPlugin(app);
			if (
				tasknotes &&
				safeCall(tasknotes.taskSelectionService, "isSelectionModeActive") === true
			) {
				return true;
			}
			return (
				containerEl.querySelector(".tn-selection-mode") !== null ||
				containerEl.closest(".tn-selection-mode") !== null
			);
		} catch {
			return false;
		}
	};

	const isCalendarEngineDragging = (): boolean => {
		try {
			if (containerEl.querySelector(".tnc-dragging") !== null) {
				return true;
			}
			const calendar = innerView.calendar;
			return (
				isRecord(calendar) &&
				isRecord(calendar.session) &&
				calendar.session.active === true
			);
		} catch {
			return false;
		}
	};

	const hasEngineItemMeta = (el: HTMLElement): boolean => {
		try {
			const calendar = innerView.calendar;
			if (!isRecord(calendar)) {
				return false;
			}
			return safeCall(calendar.meta, "has", el) === true;
		} catch {
			return false;
		}
	};

	const openDayMorePopover = (
		dateStr: string,
		anchorEl: HTMLElement,
		event: MouseEvent | KeyboardEvent,
	): boolean => {
		const day = parseDayNumber(dateStr);
		if (day === null) {
			return false;
		}
		const calendar = innerView.calendar;
		if (!isRecord(calendar)) {
			return false;
		}
		const openMoreFn = asCallable(calendar.openMore);
		if (!openMoreFn) {
			return false;
		}
		try {
			openMoreFn.call(calendar, day, anchorEl, event);
			return true;
		} catch (error) {
			console.warn("Failed to open TaskNotes day popover:", error);
			return false;
		}
	};

	const openTaskFromPath = async (taskPath: string): Promise<boolean> => {
		if (!taskPath) {
			return false;
		}
		const tasknotes = getTaskNotesPlugin(app);
		if (!tasknotes) {
			return false;
		}
		try {
			const cacheManager = tasknotes.cacheManager;
			if (!isRecord(cacheManager) || !asCallable(cacheManager.getTaskInfo)) {
				return false;
			}
			const task = await Promise.resolve(safeCall(cacheManager, "getTaskInfo", taskPath));
			if (!isRecord(task)) {
				return false;
			}

			const singleClickAction =
				isRecord(tasknotes.settings) &&
				typeof tasknotes.settings.singleClickAction === "string"
					? tasknotes.settings.singleClickAction
					: "edit";

			if (singleClickAction === "openNote") {
				const vault = app.vault as unknown as Record<string, unknown>;
				const file = safeCall(vault, "getAbstractFileByPath", taskPath);
				const workspace = app.workspace as unknown as Record<string, unknown>;
				if (file instanceof TFile) {
					const leaf = safeCall(workspace, "getLeaf", false);
					if (isRecord(leaf) && asCallable(leaf.openFile)) {
						await Promise.resolve(safeCall(leaf, "openFile", file));
						return true;
					}
				}
				if (asCallable(workspace.openLinkText)) {
					await Promise.resolve(safeCall(workspace, "openLinkText", taskPath, "", false));
					return true;
				}
				return false;
			}

			const openEditFn = asCallable(tasknotes.openTaskEditModal);
			if (!openEditFn) {
				return false;
			}
			openEditFn.call(tasknotes, task);
			return true;
		} catch (error) {
			console.warn("Failed to open task detail from month tap:", error);
			return false;
		}
	};

	return {
		rawView: innerView,
		containerEl,
		toolbarEl: findToolbarForContainer(containerEl),
		getBooleanConfig,
		setCalendarToggle,
		isMonthDayPanelEnabled,
		isSelectionModeActive,
		isCalendarEngineDragging,
		hasEngineItemMeta,
		openDayMorePopover,
		openTaskFromPath,
	};
}

/**
 * Returns active TaskNotes main CalendarView handles (`type === "tasknotesCalendar"`).
 */
export function getActiveCalendarViews(app: App): CalendarViewHandle[] {
	const handles: CalendarViewHandle[] = [];
	try {
		const workspace = app.workspace as unknown as Record<string, unknown>;
		const leaves = safeCall(workspace, "getLeavesOfType", "bases");
		if (!Array.isArray(leaves)) {
			return handles;
		}

		for (const leaf of leaves) {
			if (!isRecord(leaf) || !isRecord(leaf.view)) {
				continue;
			}
			const leafView = leaf.view;
			if (safeCall(leafView, "getViewType") !== "bases") {
				continue;
			}
			const controller = leafView.controller;
			if (!isRecord(controller) || !isRecord(controller.view)) {
				continue;
			}
			const innerView = controller.view;
			if (innerView.type !== "tasknotesCalendar") {
				continue;
			}
			const config = innerView.config;
			if (!isRecord(config) || !asCallable(config.get) || !asCallable(config.set)) {
				continue;
			}
			const containerEl = isElementLike(innerView.containerEl)
				? innerView.containerEl
				: isElementLike(leafView.containerEl)
					? leafView.containerEl
					: null;
			if (!containerEl) {
				continue;
			}
			handles.push(createCalendarViewHandle(app, innerView, containerEl, config));
		}
	} catch (error) {
		console.warn("Failed to inspect active Bases calendar views:", error);
	}
	return handles;
}

function readProviderCalendars(
	service: unknown,
	provider: "google" | "microsoft",
	keyPrefix: string,
): ExternalCalendarItem[] {
	const rawList = safeCall(service, "getAvailableCalendars");
	if (!Array.isArray(rawList)) {
		return [];
	}

	const items: ExternalCalendarItem[] = [];
	const seenIds = new Set<string>();
	for (const entry of rawList) {
		if (!isRecord(entry)) {
			continue;
		}
		const id = asNonEmptyString(entry.id);
		if (!id || seenIds.has(id)) {
			continue;
		}
		seenIds.add(id);

		const name = asNonEmptyString(entry.summary) ?? id;
		const color = asNonEmptyString(entry.backgroundColor) ?? undefined;
		const primary = typeof entry.primary === "boolean" ? entry.primary : undefined;

		items.push({
			provider,
			id,
			configKey: `${keyPrefix}${id}`,
			name,
			...(color !== undefined ? { color } : {}),
			...(primary !== undefined ? { primary } : {}),
		});
	}
	return items;
}

function readIcsSubscriptions(service: unknown): ExternalCalendarItem[] {
	const rawList = safeCall(service, "getSubscriptions");
	if (!Array.isArray(rawList)) {
		return [];
	}

	const items: ExternalCalendarItem[] = [];
	const seenIds = new Set<string>();
	for (const entry of rawList) {
		if (!isRecord(entry)) {
			continue;
		}
		if (entry.enabled === false) {
			continue;
		}
		const id = asNonEmptyString(entry.id);
		if (!id || seenIds.has(id)) {
			continue;
		}
		seenIds.add(id);

		const name = asNonEmptyString(entry.name) ?? id;
		const color = asNonEmptyString(entry.color) ?? undefined;

		items.push({
			provider: "ics",
			id,
			configKey: `showICS_${id}`,
			name,
			...(color !== undefined ? { color } : {}),
		});
	}
	return items;
}

function countUniqueCalendars(rawList: unknown): number {
	if (!Array.isArray(rawList)) {
		return 0;
	}
	const seenIds = new Set<string>();
	let fallbackCount = 0;
	for (const entry of rawList) {
		if (!isRecord(entry)) {
			continue;
		}
		const id = asNonEmptyString(entry.id);
		if (id) {
			seenIds.add(id);
		} else {
			fallbackCount += 1;
		}
	}
	return seenIds.size + fallbackCount;
}

function readHostedGoogleStatus(tasknotes: Record<string, unknown>): HostedGoogleStatus | null {
	try {
		const hosted = tasknotes.hostedGoogleCalendarService;
		if (!isRecord(hosted)) {
			return null;
		}
		const isSignedIn = safeCall(hosted, "isSignedIn") === true;
		const isConnected = safeCall(hosted, "isConnected") === true;
		const isHostedActive = tasknotes.googleCalendarService === hosted || isSignedIn;

		const availableRaw = safeCall(hosted, "getAvailableCalendars");
		const allRaw = safeCall(hosted, "getAllCalendars");
		const shownCount = countUniqueCalendars(availableRaw);
		const totalCount = Math.max(shownCount, countUniqueCalendars(allRaw));

		return {
			isHostedActive,
			isSignedIn,
			isConnected,
			shownCount,
			totalCount,
		};
	} catch {
		return null;
	}
}

/**
 * Reads available Google, Microsoft, and enabled ICS calendars plus Hosted Google status.
 */
export function getExternalCalendarSnapshot(app: App): ExternalCalendarSnapshot {
	const tasknotes = getTaskNotesPlugin(app);
	if (!tasknotes) {
		return { groups: [], hostedGoogle: null };
	}

	const groups: ExternalCalendarGroup[] = [];

	const googleItems = readProviderCalendars(
		tasknotes.googleCalendarService,
		"google",
		"showGoogleCalendar_",
	);
	if (googleItems.length > 0) {
		groups.push({
			provider: "google",
			title: "Google Calendar",
			items: googleItems,
		});
	}

	const microsoftItems = readProviderCalendars(
		tasknotes.microsoftCalendarService,
		"microsoft",
		"showMicrosoftCalendar_",
	);
	if (microsoftItems.length > 0) {
		groups.push({
			provider: "microsoft",
			title: "Microsoft Calendar",
			items: microsoftItems,
		});
	}

	const icsItems = readIcsSubscriptions(tasknotes.icsSubscriptionService);
	if (icsItems.length > 0) {
		groups.push({
			provider: "ics",
			title: "ICS Subscriptions",
			items: icsItems,
		});
	}

	const hostedGoogle = readHostedGoogleStatus(tasknotes);
	return { groups, hostedGoogle };
}

function subscribeProviderEvent(
	provider: Record<string, unknown>,
	eventName: string,
	callback: () => void,
): (() => void) | null {
	const onFn = asCallable(provider.on);
	if (!onFn) {
		return null;
	}

	const handler = (): void => {
		callback();
	};

	try {
		const ref = onFn.call(provider, eventName, handler);
		if (typeof ref === "function") {
			return () => {
				try {
					(ref as () => void)();
				} catch {
					// Ignore cleanup errors during teardown.
				}
			};
		}
		if (ref !== undefined && ref !== null && asCallable(provider.offref)) {
			return () => {
				safeCall(provider, "offref", ref);
			};
		}
		if (asCallable(provider.off)) {
			return () => {
				safeCall(provider, "off", eventName, handler);
			};
		}
	} catch (error) {
		console.warn(`Failed to subscribe to TaskNotes event "${eventName}":`, error);
	}
	return null;
}

/**
 * Subscribes to external calendar data/session updates from available TaskNotes providers.
 */
export function subscribeExternalCalendarChanges(
	app: App,
	callback: () => void,
): () => void {
	const tasknotes = getTaskNotesPlugin(app);
	if (!tasknotes) {
		return () => {};
	}

	const disposers: Array<() => void> = [];
	const providers = new Set<Record<string, unknown>>();
	for (const key of [
		"icsSubscriptionService",
		"googleCalendarService",
		"ownGoogleCalendarService",
		"hostedGoogleCalendarService",
		"microsoftCalendarService",
	]) {
		const candidate = tasknotes[key];
		if (isRecord(candidate)) {
			providers.add(candidate);
		}
	}

	for (const provider of providers) {
		const disposer = subscribeProviderEvent(provider, "data-changed", callback);
		if (disposer) {
			disposers.push(disposer);
		}
	}

	const hosted = tasknotes.hostedGoogleCalendarService;
	if (isRecord(hosted)) {
		const sessionDisposer = subscribeProviderEvent(hosted, "session-changed", callback);
		if (sessionDisposer) {
			disposers.push(sessionDisposer);
		}
	}

	let disposed = false;
	return () => {
		if (disposed) {
			return;
		}
		disposed = true;
		for (const dispose of disposers) {
			dispose();
		}
	};
}

/**
 * Opens Obsidian Settings to the TaskNotes plugin tab when available.
 */
export function openTaskNotesSettings(app: App): boolean {
	try {
		const setting = (app as unknown as Record<string, unknown>).setting;
		if (!isRecord(setting)) {
			return false;
		}
		const openFn = asCallable(setting.open);
		const openTabByIdFn = asCallable(setting.openTabById);
		if (!openFn && !openTabByIdFn) {
			return false;
		}
		openFn?.call(setting);
		openTabByIdFn?.call(setting, "tasknotes");
		return true;
	} catch {
		return false;
	}
}
