// @ts-nocheck -- lifted byte for byte; annotating it is its own commit.
/**
 * The daemon's assembly: the one request handler, the route table it walks, and the port it listens on.
 *
 * Importing this file builds the http server but never listens, so a test can reach the routes without
 * binding a socket. The one place that starts it is server.ts.
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { INSTANCE, STATE_DIR, STATE_FILE, buildHash, randomToken, readJsonFile, writeJsonFile } from "./paths.ts";
import { answer, fail, send, serveStatic } from "./http.ts";
import { activeHomeDefaults, describeWorkspace, welcomeClients, workspaces } from "./workspaces.ts";
import { boardFrom, boards, flushBoard } from "./store.ts";
import { boardMeta, cardsFor } from "./cards.ts";
import { closedCards } from "./bus.ts";
import { gitPicture, refreshGit, unwatchGit, watchGit } from "./git/graph.ts";
import { BUILTIN_TOOLS, CHILD_EXTENSIONS, THINKING_LEVELS, modelCatalog, readScope, resolveScope, saidScopeProblems } from "./models.ts";
import { onDefaults, onOpenWorkspace, onPickFolder } from "./routes/crossroads.ts";
import { onBrowse, onEdit, onNote, onRename, onSource } from "./routes/board/content.ts";
import { rowWithThought } from "./thought.ts";
import { sessionFile, transcriptOf } from "./session.ts";
import { extensionsDir } from "./child/argv.ts";
import { onThread } from "./routes/board/thread.ts";
import { onAnswer, onAsk } from "./routes/board/answer.ts";
import { onMessage } from "./routes/board/message.ts";
import { onConfig, onLayout, onModel, onThinking } from "./routes/board/config.ts";
import { onClean, onClose, onKill, onNew, onReopen, onStop } from "./routes/board/lifecycle.ts";


/** Opening a browser is what a desktop app does; a service run asks for `--no-open`. */
export const OPEN_BROWSER = !process.argv.includes("--no-open");



// ---------- the server -----------------------------------------------------

export const token = (() => {
	const saved = readJsonFile(STATE_FILE, null);
	return typeof saved?.token === "string" && saved.token ? saved.token : randomToken();
})();



/**
 * The path a route is compared against. The client never writes `//` or a trailing slash, but a URL
 * typed by hand, pasted from a log or built by a proxy can, and an unfolded one matched nothing and
 * fell through to an answer that was neither the page nor a plain not-found. Root stays root.
 */
export function foldPath(pathname) {
	const folded = pathname.replace(/\/{2,}/g, "/").replace(/(.)\/+$/, "$1");
	return folded || "/";
}



/**
 * The request target as a URL, which `new URL(req.url, base)` cannot do on its own: `new URL("//state",
 * base)` reads `state` as a host, so a doubled slash turned into the root page or into an exception the
 * catch below answered with a 500. The path is folded before parsing, and the query is left alone — a
 * doubled slash can be deliberate in a folder path.
 */
export function requestUrl(target) {
	const raw = String(target || "/");
	if (!raw.startsWith("/")) return new URL(raw.startsWith("http") ? raw : `/${raw}`, "http://127.0.0.1");
	const cut = raw.indexOf("?");
	const path = cut === -1 ? raw : raw.slice(0, cut);
	const query = cut === -1 ? "" : raw.slice(cut);
	return new URL(`http://127.0.0.1${foldPath(path)}${query}`);
}



export const server = createServer((req, res) => {
	void (async () => {
		const url = requestUrl(req.url);
		// Static assets carry no session data, so the token only guards the data routes.
		if (req.method === "GET") {
			const statics = {
				"/": ["welcome.html", "text/html; charset=utf-8"],
				"/welcome.js": ["welcome.js", "text/javascript; charset=utf-8"],
				"/welcome.css": ["welcome.css", "text/css; charset=utf-8"],
			};
			const hit = statics[url.pathname];
			if (hit) {
				serveStatic(res, hit[0], hit[1]);
				return;
			}
			// Every client module lives under public/client/ and is served by one rule rather than an entry
			// per file. The shape is checked before the path is joined, so `..` cannot walk out of public/.
			if (/^\/client\/[a-z0-9/_-]+\.js$/.test(url.pathname)) {
				serveStatic(res, url.pathname.slice(1), "text/javascript; charset=utf-8");
				return;
			}
			// A workspace's board is the same page for every folder; the id in the path tells it which.
			if (/^\/w\/[0-9a-f]{6,64}\/?$/.test(url.pathname)) {
				serveStatic(res, "index.html", "text/html; charset=utf-8");
				return;
			}
		}
		if (url.searchParams.get("token") !== token) {
			// A refused POST has to have its body taken off the wire, otherwise the client's next
			// request rides the same socket into the leftovers and reads as a reset.
			req.resume();
			fail(res, 403, "forbidden");
			return;
		}

		// ----- streams -----
		if (req.method === "GET" && url.pathname === "/events") {
			res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
			const scope = url.searchParams.get("scope");
			if (scope === "welcome") {
				// The crossroads only needs counts and previews, and it needs them as they change.
				send(new Set([res]), { type: "workspaces", workspaces: workspaces.map(describeWorkspace) });
				welcomeClients.add(res);
				const keepAlive = setInterval(() => res.write(": ping\n\n"), 20_000);
				const forget = () => {
					clearInterval(keepAlive);
					welcomeClients.delete(res);
				};
				req.on("close", forget);
				res.on("error", forget);
				return;
			}
			const board = boardFrom(url, res);
			if (!board) return;
			send(new Set([res]), {
				type: "snapshot",
				cards: cardsFor(board),
				closed: closedCards(board),
				activity: board.activity,
				meta: boardMeta(board),
				// Read before the snapshot goes out, so a tab that has just opened draws the strip at once
				// instead of waiting a tick for its first git event.
				git: refreshGit(board, true),
			});
			board.clients.add(res);
			watchGit(board);
			const keepAlive = setInterval(() => res.write(": ping\n\n"), 20_000);
			const forget = () => {
				clearInterval(keepAlive);
				board.clients.delete(res);
				unwatchGit(board);
			};
			req.on("close", forget);
			res.on("error", forget);
			return;
		}

		// ----- crossroads -----
		if (req.method === "GET" && url.pathname === "/workspaces") {
			answer(res, 200, { workspaces: workspaces.map(describeWorkspace), instance: INSTANCE });
			return;
		}
		// What every board opened from here is born with. The crossroads sets it; a board may then
		// change its own copy without touching the next workspace.
		if (req.method === "GET" && url.pathname === "/defaults") {
			answer(res, 200, { defaults: activeHomeDefaults(), levels: THINKING_LEVELS });
			return;
		}
		if (req.method === "POST" && url.pathname === "/defaults") {
			await onDefaults(req, res);
			return;
		}
		if (req.method === "POST" && url.pathname === "/workspace") {
			await onOpenWorkspace(req, res);
			return;
		}
		if (req.method === "POST" && url.pathname === "/pick-folder") {
			req.resume();
			onPickFolder(res);
			return;
		}
		if (req.method === "GET" && url.pathname === "/browse") {
			onBrowse(url, res);
			return;
		}
		// The row itself is the payload: a tool row keeps its arguments and its output, a reply keeps
		// the thinking that led to it, and the panel shows whichever fields it finds.
		if (req.method === "GET" && url.pathname.startsWith("/activity/")) {
			const board = boardFrom(url, res);
			if (!board) return;
			const id = decodeURIComponent(url.pathname.slice("/activity/".length));
			const row = board.activity.find((candidate) => candidate.id === id);
			if (!row) {
				fail(res, 404, "no detail kept for this row");
				return;
			}
			answer(res, 200, rowWithThought(row));
			return;
		}
		// The conversation behind a thread, rendered for reading: what the activity rail summarises and
		// what the card shows one answer of.
		if (req.method === "GET" && url.pathname.startsWith("/transcript/")) {
			const board = boardFrom(url, res);
			if (!board) return;
			const id = decodeURIComponent(url.pathname.slice("/transcript/".length));
			const thread = board.threads.get(id);
			if (!thread) return void fail(res, 404, "no such thread");
			const file = thread.sessionId ? sessionFile({ id: board.id }, thread.sessionId) : "";
			const entries = file ? transcriptOf(file) : null;
			if (!entries) return void fail(res, 404, "this thread has no session file yet");
			answer(res, 200, {
				threadId: thread.id,
				title: thread.title,
				status: thread.status,
				branch: thread.worktree?.branch ?? "",
				base: thread.worktree?.base ?? "",
				sessionId: thread.sessionId,
				entries,
			});
			return;
		}

		// ----- board -----
		// What the composer's pickers offer: every model this machine can run, the levels pi names, and
		// the scope pi cycles — pi's own `enabledModels`, which is where /scoped-models writes it. The
		// scope is read here rather than cached with the catalogue, so an edit made in a console pi lands
		// on the next open of the picker.
		if (req.method === "GET" && url.pathname === "/models") {
			const { models, levels } = await modelCatalog();
			const scope = readScope();
			const { scoped, problems } = resolveScope(scope, models);
			for (const pattern of problems) {
				if (saidScopeProblems.has(pattern)) continue;
				saidScopeProblems.add(pattern);
				console.error(`pi-studio: pi's scope pattern ${JSON.stringify(pattern)} matched no model here`);
			}
			answer(res, 200, { models, levels, scope, scoped, problems });
			return;
		}
		if (req.method === "GET" && url.pathname === "/tools") {
			// What the settings panel draws: pi's own four by name, and the extension folders this
			// machine has. Read once when the panel first opens, so installing an extension shows up
			// after a daemon restart rather than mid-session.
			answer(res, 200, {
				builtin: BUILTIN_TOOLS,
				extensions: CHILD_EXTENSIONS.map((one) => ({ name: one.name })),
				folder: extensionsDir(),
			});
			return;
		}
		if (req.method === "GET" && url.pathname === "/state") {
			const board = boardFrom(url, res);
			if (!board) return;
			answer(res, 200, {
				workspace: describeWorkspace({ id: board.id, folder: board.folder, name: board.name, openedAt: 0 }),
				threads: [...board.threads.values()].map((thread) => ({ ...thread, live: board.children.has(thread.id) })),
				cards: cardsFor(board),
				closed: closedCards(board),
				activity: board.activity,
				meta: boardMeta(board),
				// What the strip draws, read now rather than cached: a script asking gets the disk's answer.
				git: gitPicture(board),
			});
			return;
		}
		if (req.method === "POST") {
			const routing = {
				"/thread": onThread,
				"/card/note": onNote,
				"/card/source": onSource,
				"/card/ask": onAsk,
				"/edit": onEdit,
				"/rename": onRename,
				"/answer": onAnswer,
				"/message": onMessage,
				"/layout": onLayout,
				"/close": onClose,
				"/reopen": onReopen,
				"/model": onModel,
				"/thinking": onThinking,
				"/kill": onKill,
				"/config": onConfig,
				"/clean": onClean,
				"/new": onNew,
			};
			const handler = routing[url.pathname];
			if (handler) {
				const board = boardFrom(url, res);
				if (!board) return;
				await handler(req, res, board);
				return;
			}
			if (url.pathname === "/stop") {
				const board = boardFrom(url, res);
				if (!board) return;
				await onStop(req, res, board);
				return;
			}
			// Everything the board had for a single session: kept honest by refusing rather than lying.
			if (url.pathname === "/compact") return void fail(res, 409, "compaction belongs to the child, and no run is waiting on it");
		}
		fail(res, 404, "not found");
	})().catch((error) => {
		// A handler that throws used to leave the request unanswered, which the browser shows as a
		// reset. Answer something and keep the daemon serving.
		console.error(`pi-studio: ${error.stack ?? error}`);
		if (!res.headersSent) fail(res, 500, "board error");
		else res.end();
	});
});



export function shutdown() {
	// What the debounce still holds is the last thing the human did, so it goes to disk first.
	for (const board of boards.values()) flushBoard(board);
	for (const board of boards.values()) for (const child of board.children.values()) child.kill("SIGKILL");
	server.close(() => process.exit(0));
	// A socket that will not close must not keep a stopped daemon alive.
	setTimeout(() => process.exit(0), 1000).unref();
}



export let port = 0;



/**
 * The port the last daemon printed, so a restart keeps the URL a tab is already on. A development
 * reload is the reason: a fresh port per restart would make every edit a new link. If something else
 * has taken it, fall back to any free port rather than refuse to start.
 */
export function lastPort() {
	const saved = readJsonFile(STATE_FILE, null);
	const held = Number(saved?.port);
	return Number.isInteger(held) && held > 0 && held < 65536 ? held : 0;
}



export function startListening(wanted) {
	server.listen(wanted, "127.0.0.1", onListening);
}



export function onListening() {
	port = server.address().port;
	writeJsonFile(STATE_FILE, { token, port, at: new Date().toISOString() });
	const url = `http://127.0.0.1:${port}/?token=${token}`;
	console.log(`pi-studio${INSTANCE ? ` [${INSTANCE}]` : ""} listening on ${url}`);
	// Which build is answering matters the moment a tab looks wrong, so it is said out loud.
	console.log(`build ${buildHash()}${INSTANCE ? `, state ${STATE_DIR}` : ""}`);
	if (workspaces.length) console.log(`${workspaces.length} workspace${workspaces.length === 1 ? "" : "s"}, newest ${workspaces[0].name}`);
	else console.log("no workspace yet — open one on the crossroads");
	// The crossroads is where a desktop app starts, so it starts in the browser.
	if (OPEN_BROWSER) {
		try {
			spawn("xdg-open", [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
		} catch {
			// A machine without a browser opener still has the URL above.
		}
	}
}



/**
 * Boots the daemon: the port it should try, and the one line a human needs to open the board.
 *
 * The entry calls this and nothing else, so importing this file never binds a socket.
 */
export function start() {
	startListening(Number(process.env.PI_STUDIO_PORT) || lastPort());
}
