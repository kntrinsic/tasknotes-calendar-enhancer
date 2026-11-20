import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const restrictedHtmlProperties = [
	{
		property: "innerHTML",
		message:
			"Do not use innerHTML; use textContent or Obsidian DOM builders (createEl, createDiv, createSpan) instead.",
	},
	{
		property: "outerHTML",
		message: "Do not use outerHTML; use Obsidian DOM builders instead.",
	},
	{
		property: "insertAdjacentHTML",
		message: "Do not use insertAdjacentHTML; use Obsidian DOM builders instead.",
	},
	{
		object: "document",
		property: "write",
		message: "Do not use document.write.",
	},
	{
		object: "document",
		property: "writeln",
		message: "Do not use document.writeln.",
	},
];

const restrictedBracketHtmlSyntax = [
	{
		selector: "MemberExpression[computed=true][property.value='innerHTML']",
		message: "Do not access innerHTML via bracket notation.",
	},
	{
		selector: "MemberExpression[computed=true][property.value='outerHTML']",
		message: "Do not access outerHTML via bracket notation.",
	},
	{
		selector: "MemberExpression[computed=true][property.value='insertAdjacentHTML']",
		message: "Do not access insertAdjacentHTML via bracket notation.",
	},
];

function scopeConfigs(files, configs, overrides = {}) {
	return configs.map((config) => ({
		...config,
		files,
		...overrides,
	}));
}

export default [
	{
		ignores: [
			"main.js",
			"node_modules/**",
			"tasknotes-test-vault/**",
			"dist/**",
			"coverage/**",
		],
	},
	{
		files: ["**/*.mjs", "scripts/**/*.mjs"],
		...js.configs.recommended,
		languageOptions: {
			globals: {
				...globals.node,
			},
		},
	},
	...scopeConfigs(["src/**/*.ts", "tests/**/*.ts"], [
		js.configs.recommended,
		...tseslint.configs.strictTypeChecked,
	]),
	{
		files: ["src/**/*.ts", "tests/**/*.ts"],
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			"no-eval": "error",
			"no-implied-eval": "error",
			"no-restricted-properties": ["error", ...restrictedHtmlProperties],
			"no-restricted-syntax": ["error", ...restrictedBracketHtmlSyntax],
			"no-console": ["error", { allow: ["warn", "error"] }],
			"@typescript-eslint/no-unused-vars": [
				"error",
				{ argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
			],
		},
	},
	...scopeConfigs(["vitest.config.ts"], [
		js.configs.recommended,
		...tseslint.configs.strictTypeChecked,
	]),
	{
		files: ["vitest.config.ts"],
		languageOptions: {
			globals: {
				...globals.node,
			},
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
];
