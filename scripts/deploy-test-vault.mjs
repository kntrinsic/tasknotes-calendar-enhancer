import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PLUGIN_ID = "tasknotes-calendar-enhancer";
const ARTIFACTS = ["manifest.json", "main.js", "styles.css"];

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const testVaultObsidianDir = path.join(repoRoot, "tasknotes-test-vault", ".obsidian");

if (!existsSync(testVaultObsidianDir)) {
	console.error(
		`Refusing to deploy: isolated test vault .obsidian directory not found at ${testVaultObsidianDir}`,
	);
	process.exit(1);
}

for (const fileName of ARTIFACTS) {
	const srcPath = path.join(repoRoot, fileName);
	if (!existsSync(srcPath)) {
		console.error(`Missing build artifact: ${srcPath}. Run "npm run build" first.`);
		process.exit(1);
	}
}

const targetPluginDir = path.join(testVaultObsidianDir, "plugins", PLUGIN_ID);
mkdirSync(targetPluginDir, { recursive: true });

for (const fileName of ARTIFACTS) {
	const srcPath = path.join(repoRoot, fileName);
	const destPath = path.join(targetPluginDir, fileName);
	copyFileSync(srcPath, destPath);
	console.log(`Deployed: ${destPath}`);
}
