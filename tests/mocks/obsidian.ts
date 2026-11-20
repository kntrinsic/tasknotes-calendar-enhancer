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

export class PluginSettingTab {
	app: App;
	containerEl = {
		empty(): void {},
	};

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

	onClick(_cb: (evt: MouseEvent) => unknown): this {
		return this;
	}
}

export class Setting {
	readonly containerEl: unknown;

	constructor(containerEl: unknown) {
		this.containerEl = containerEl;
	}

	setName(_name: string): this {
		return this;
	}

	setDesc(_desc: string): this {
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
}

export function setIcon(parent: HTMLElement, iconId: string): void {
	parent.dataset.icon = iconId;
}
