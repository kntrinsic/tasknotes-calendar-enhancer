// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import path from "node:path";
import { App, type PluginManifest } from "obsidian";
import { afterEach, describe, expect, it } from "vitest";
import TaskNotesCalendarEnhancerPlugin, {
	MOBILE_DAY_POPOVER_BODY_CLASS,
} from "../src/main";

describe("mobile day popover layout", () => {
	afterEach(() => {
		document.body.className = "";
	});

	it("toggles the mobile day popover body class across load, setting changes, and unload", async () => {
		const app = new App();
		const plugin = new TaskNotesCalendarEnhancerPlugin(app, {} as PluginManifest);

		await plugin.onload();
		expect(document.body.classList.contains(MOBILE_DAY_POPOVER_BODY_CLASS)).toBe(true);

		plugin.settings.enableMobileDayPopoverLayout = false;
		plugin.applyFeatureStates();
		expect(document.body.classList.contains(MOBILE_DAY_POPOVER_BODY_CLASS)).toBe(false);

		plugin.settings.enableMobileDayPopoverLayout = true;
		plugin.applyFeatureStates();
		expect(document.body.classList.contains(MOBILE_DAY_POPOVER_BODY_CLASS)).toBe(true);

		plugin.onunload();
		expect(document.body.classList.contains(MOBILE_DAY_POPOVER_BODY_CLASS)).toBe(false);
	});

	it("ships mobile-only scoped CSS rules keeping pill styling while preventing edge clipping", () => {
		const cssPath = path.resolve(import.meta.dirname, "..", "styles.css");
		const css = readFileSync(cssPath, "utf8");

		expect(css).toContain("Phase 9: Mobile Day Popover Layout");
		const phaseIndex = css.indexOf(`body.is-mobile.${MOBILE_DAY_POPOVER_BODY_CLASS}`);
		expect(phaseIndex).toBeGreaterThan(-1);
		const phaseCss = css.slice(phaseIndex).replace(/\/\*[\s\S]*?\*\//g, "");

		const selectors = phaseCss
			.split("}")
			.map((block) => block.split("{")[0]?.trim() ?? "")
			.filter((header) => header.length > 0);
		expect(selectors.length).toBeGreaterThan(0);
		for (const selectorGroup of selectors) {
			for (const selector of selectorGroup.split(",")) {
				expect(selector.trim().startsWith(`body.is-mobile.${MOBILE_DAY_POPOVER_BODY_CLASS}`)).toBe(
					true,
				);
			}
		}

		expect(phaseCss).toContain("border-radius: min(var(--tn-radius-md, 20px), 20px);");
		expect(phaseCss).toContain("border-radius: var(--tn-radius-full, 999px);");
		expect(phaseCss).toContain("padding: 8px 16px;");
		expect(phaseCss).toContain("top: 50%;");
		expect(phaseCss).toContain(".tnc-resize");
		expect(phaseCss).toContain("display: none;");
	});
});
