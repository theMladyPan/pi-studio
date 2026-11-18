#!/usr/bin/env node
// Source install entry (`npm run install:local`): build the staged JavaScript tree with the
// existing build, then hand that tree to the same manager an update uses. The clone is only
// read; the installed copy and the launcher are the only things written.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFlags } from "./runtime.mjs";
import { installFromDir } from "./manage.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { flags } = parseFlags(process.argv.slice(2));

execFileSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" });
try {
	installFromDir(join(root, "dist"), flags);
} catch (error) {
	console.error(error.message);
	process.exit(1);
}
