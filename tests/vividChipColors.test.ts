// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import path from "node:path";
import { App, type PluginManifest } from "obsidian";
import { afterEach, describe, expect, it } from "vitest";
import TaskNotesCalendarEnhancerPlugin, {
	VIVID_CHIP_COLORS_BODY_CLASS,
} from "../src/main";

describe("vivid month chip colors", () => {
	afterEach(() => {
		document.body.className = "";
	});

	it("toggles the vivid chip colors body class across load, setting changes, and unload", async () => {
		const app = new App();
		const plugin = new TaskNotesCalendarEnhancerPlugin(app, {} as PluginManifest);

		await plugin.onload();
		expect(document.body.classList.contains(VIVID_CHIP_COLORS_BODY_CLASS)).toBe(true);

		plugin.settings.enableVividChipColors = false;
		plugin.applyFeatureStates();
		expect(document.body.classList.contains(VIVID_CHIP_COLORS_BODY_CLASS)).toBe(false);

		plugin.settings.enableVividChipColors = true;
		plugin.applyFeatureStates();
		expect(document.body.classList.contains(VIVID_CHIP_COLORS_BODY_CLASS)).toBe(true);

		plugin.onunload();
		expect(document.body.classList.contains(VIVID_CHIP_COLORS_BODY_CLASS)).toBe(false);
	});

	it("ships scoped CSS rules targeting TaskNotes month chips indicators", () => {
		const cssPath = path.resolve(import.meta.dirname, "..", "styles.css");
		const css = readFileSync(cssPath, "utf8");

		expect(css).toContain(`body.${VIVID_CHIP_COLORS_BODY_CLASS}`);
		expect(css).toContain(".tnc-dg--chips");
		expect(css).toContain("border-inline-start: 3px solid var(--tnce-chip-accent);");
		expect(css).toContain("body.theme-dark.tnce-vivid-chip-colors");
		expect(css).toContain("@supports (color: oklch(from red l c h))");
		expect(css).toContain('[data-ics-event="true"]:not(.is-completed)');
	});
});
