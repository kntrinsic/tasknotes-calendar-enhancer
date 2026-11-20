export interface EventRef {
	readonly id: string;
}

export class TFile {
	path = "";
	extension = "md";
}

export class Vault {
	getAbstractFileByPath(_path: string): TFile | null {
		return null;
	}
}

export class WorkspaceLeaf {
	openFile(_file: TFile): Promise<void> {
		return Promise.resolve();
	}
}

export class Workspace {
	getLeavesOfType(_viewType: string): unknown[] {
		return [];
	}

	getLeaf(_newLeaf?: boolean): WorkspaceLeaf {
		return new WorkspaceLeaf();
	}

	openLinkText(_linktext: string, _sourcePath: string, _newLeaf?: boolean): Promise<void> {
		return Promise.resolve();
	}

	on(_name: string, _callback: (...args: unknown[]) => unknown): EventRef {
		return { id: "mock-event-ref" };
	}

	offref(_ref: EventRef): void {}

	onLayoutReady(callback: () => void): void {
		callback();
	}
}

export class App {
	readonly vault = new Vault();
	readonly workspace = new Workspace();
	private readonly localStorageStore = new Map<string, unknown>();

	loadLocalStorage(key: string): unknown {
		return this.localStorageStore.get(key) ?? null;
	}

	saveLocalStorage(key: string, data: unknown): void {
		if (data === null || data === undefined) {
			this.localStorageStore.delete(key);
			return;
		}
		this.localStorageStore.set(key, JSON.parse(JSON.stringify(data)) as unknown);
	}
}

export class Notice {
	readonly message: string;

	constructor(message: string) {
		this.message = message;
	}
}

export class Plugin {
	app: App;

	constructor(app: App = new App()) {
		this.app = app;
	}

	addSettingTab(_tab: PluginSettingTab): void {}

	loadData(): Promise<unknown> {
		return Promise.resolve(null);
	}

	saveData(_data: unknown): Promise<void> {
		return Promise.resolve();
	}
}

export interface MockSettingContainer {
	empty(): void;
}

function createMockContainerEl(): MockSettingContainer & Partial<HTMLElement> {
	if (typeof document !== "undefined") {
		const el = document.createElement("div") as HTMLDivElement & { empty: () => void };
		el.empty = () => {
			el.replaceChildren();
		};
		return el;
	}
	return {
		empty(): void {},
	};
}

export class PluginSettingTab {
	app: App;
	containerEl = createMockContainerEl();

	constructor(app: App, _plugin: Plugin) {
		this.app = app;
	}

	display(): void {}
}

export class ToggleComponent {
	setValue(_value: boolean): this {
		return this;
	}

	onChange(_cb: (value: boolean) => unknown): this {
		return this;
	}
}

export class ButtonComponent {
	setButtonText(_text: string): this {
		return this;
	}

	setDestructive(): this {
		return this;
	}

	setDisabled(_disabled: boolean): this {
		return this;
	}

	onClick(_cb: (evt: MouseEvent) => unknown): this {
		return this;
	}
}

export class ColorComponent {
	setValue(_value: string): this {
		return this;
	}

	setDisabled(_disabled: boolean): this {
		return this;
	}

	onChange(_cb: (value: string) => unknown): this {
		return this;
	}
}

export class ExtraButtonComponent {
	setIcon(_icon: string): this {
		return this;
	}

	setTooltip(_tooltip: string): this {
		return this;
	}

	setDisabled(_disabled: boolean): this {
		return this;
	}

	onClick(_cb: () => unknown): this {
		return this;
	}
}

export class Setting {
	readonly containerEl: unknown;

	constructor(containerEl: unknown) {
		this.containerEl = containerEl;
	}

	setName(_name: string | DocumentFragment): this {
		return this;
	}

	setDesc(_desc: string | DocumentFragment): this {
		return this;
	}

	setHeading(): this {
		return this;
	}

	addToggle(cb: (toggle: ToggleComponent) => unknown): this {
		cb(new ToggleComponent());
		return this;
	}

	addButton(cb: (button: ButtonComponent) => unknown): this {
		cb(new ButtonComponent());
		return this;
	}

	addColorPicker(cb: (colorPicker: ColorComponent) => unknown): this {
		cb(new ColorComponent());
		return this;
	}

	addExtraButton(cb: (extraButton: ExtraButtonComponent) => unknown): this {
		cb(new ExtraButtonComponent());
		return this;
	}
}

export function setIcon(parent: HTMLElement, iconId: string): void {
	parent.dataset.icon = iconId;
}

export function setTooltip(
	el: HTMLElement,
	tooltip: string,
	options?: { placement?: string },
): void {
	if (!tooltip) {
		el.removeAttribute("aria-label");
		el.removeAttribute("data-tooltip-position");
		return;
	}
	el.setAttribute("aria-label", tooltip);
	if (options?.placement) {
		el.setAttribute("data-tooltip-position", options.placement);
	}
}
