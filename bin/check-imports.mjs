#!/usr/bin/env node
/**
 * The two things a move between files breaks first, checked without a browser and without a daemon.
 *
 * A move is mechanical: cut a block, add the `import` line and the `export` line. What can go wrong is
 * the specifier — a path counted one directory short, a file left behind, or a client module that
 * exists on disk but is not in the daemon's four-path static allowlist. The last one is the quietest:
 * the import 404s, the module graph stops there, and the board comes up blank with nothing in the
 * console that points at the move. `node --check` sees none of the three, because each file is valid
 * on its own.
 *
 *   node bin/check-imports.mjs    # one line per check, exit 1 on the first failure
 *
 * Neither check knows where the modules live. The first covers every source under the roots below, so
 * a new `server/` or `public/lib/` folder is covered by existing. The second starts at the client entry
 * and follows its imports, so it says exactly what a page load would reach and nothing it would not.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const publicDir = join(repo, "public");
/** The file `index.html` loads. Everything the client needs has to be reachable from it. */
const clientEntry = join(publicDir, "client", "board.js");
/** Directories in the order they are walked. A name that does not exist is skipped, not an error. */
const roots = ["server.mjs", "server.ts", "server", "public", "bin"];
const skip = new Set([".git", ".agents", ".history", "node_modules"]);

function said(ok, what, note = "") {
	console.log(`${ok ? "ok  " : "FAIL"} ${what}${note ? ` — ${note}` : ""}`);
	if (!ok) throw new Error(`imports: ${what}`);
}

function sourceFiles(path) {
	if (!existsSync(path)) return [];
	if (statSync(path).isFile()) return [path];
	const found = [];
	for (const entry of readdirSync(path, { withFileTypes: true })) {
		if (skip.has(entry.name)) continue;
		const full = join(path, entry.name);
		if (entry.isDirectory()) found.push(...sourceFiles(full));
		else if (/\.[mc]?[jt]s$/.test(entry.name) || isScript(full)) found.push(full);
	}
	return found;
}

/** `bin/pi-studio` carries no extension, and it is the import that starts the daemon. */
function isScript(file) {
	const first = readFileSync(file, "utf8").split("\n", 1)[0];
	return first.startsWith("#!") && first.includes("node");
}

/**
 * Every module reference on a line: the `from` of an `import` or an `export … from`, the bare
 * `import "x"` that only runs side effects, and the `import("x")` a launcher such as `bin/pi-studio`
 * uses to start the daemon. One pattern rather than three passes, so a line holding two of them is
 * still read twice.
 */
const reference = /\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']/g;

function references(file) {
	const found = [];
	readFileSync(file, "utf8")
		.split("\n")
		.forEach((line, index) => {
			// Prose about an import is common in this repository, and a commented example of one is not
			// an import. Only the leading `//` and block comment forms are worth excluding; anything
			// deeper is a real reference by the time it is on its own line.
			const trimmed = line.trimStart();
			if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
			for (const match of line.matchAll(reference)) found.push({ specifier: match[1] ?? match[2] ?? match[3], line: index + 1 });
		});
	return found;
}

/**
 * The static allowlist, read out of whichever daemon file holds it rather than from a hardcoded path,
 * so the move that puts it in `server/http.mjs` does not make this check lie. A table that cannot be
 * found is a failure, not a pass: it means the shape changed under the reader.
 */
function serveTable(files) {
	for (const file of files) {
		const source = readFileSync(file, "utf8");
		const start = source.indexOf("const statics = {");
		if (start < 0) continue;
		const end = source.indexOf("};", start);
		const table = new Map();
		for (const match of source.slice(start, end).matchAll(/"(\/[^"]*)"\s*:\s*\[\s*"([^"]+)"/g)) table.set(match[1], match[2]);
		return { table, file };
	}
	return null;
}

/** What the page load reaches: the entry, then every relative import below it, to any depth. */
function clientGraph(entry) {
	const reached = new Set();
	const queue = [entry];
	while (queue.length) {
		const file = queue.shift();
		if (reached.has(file) || !existsSync(file)) continue;
		reached.add(file);
		for (const ref of references(file)) if (ref.specifier.startsWith(".")) queue.push(resolve(dirname(file), ref.specifier));
	}
	return reached;
}

function main() {
	const files = roots.flatMap((root) => sourceFiles(join(repo, root)));
	said(files.length >= 2, "the sources are where they are expected", `${files.length} files under ${roots.join(", ")}`);

	let seen = 0;
	let linked = 0;
	const unresolved = [];
	for (const file of files) {
		for (const ref of references(file)) {
			seen += 1;
			// Bare specifiers are Node builtins or installed packages, and neither is this check's question.
			if (!ref.specifier.startsWith(".")) continue;
			linked += 1;
			if (!existsSync(resolve(dirname(file), ref.specifier))) unresolved.push(`${relative(repo, file)}:${ref.line} ${ref.specifier}`);
		}
	}
	// A zero here would mean the reader stopped seeing imports, not that the tree is clean, so the count
	// of imports of every kind is the check that the reader still works.
	said(seen > 0, "the reader finds the imports", `${seen} specifiers in ${files.length} files`);
	said(
		unresolved.length === 0,
		"every relative import resolves to a file on disk",
		unresolved.length ? `${unresolved.length} broken: ${unresolved.slice(0, 6).join(" | ")}` : `${linked} relative of ${seen}`,
	);

	const served = serveTable(files);
	said(served !== null, "the static allowlist was found", served ? relative(repo, served.file) : "no `const statics = {` anywhere");

	const reached = clientGraph(clientEntry);
	said(reached.size > 0, "the client entry was reached", `${reached.size} modules from ${relative(repo, clientEntry)}`);

	// One rule serves every client module: the daemon accepts `/client/**/*.js` and nothing else. The same
	// shape is asked of each module the page reaches, so a module outside it is a blank board waiting.
	const CLIENT_URL = /^\/client\/[a-z0-9/_-]+\.js$/;
	const ruled = files.some((file) => readFileSync(file, "utf8").includes("/^\\/client\\/[a-z0-9/_-]+\\.js$/"));
	said(ruled, "the daemon serves the client by one rule", ruled ? "found in the server sources" : "no /client/ rule in any server module");

	const unserved = [];
	for (const file of reached) {
		const url = `/${relative(publicDir, file).split("\\").join("/")}`;
		if (!CLIENT_URL.test(url)) unserved.push(`${url} does not match the /client/ rule`);
	}
	said(
		unserved.length === 0,
		"every module the client reaches is served under /client/",
		unserved.length ? unserved.join(" | ") : `${reached.size} modules`,
	);
}

try {
	main();
	console.log("all checks passed");
} catch (error) {
	console.error(String(error?.message ?? error));
	process.exitCode = 1;
}
