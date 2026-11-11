// @ts-nocheck -- lifted byte for byte; annotating it is its own commit.
/**
 * The daemon's assembly: the one request handler, the route table it walks, and the port it listens on.
 *
 * Importing this file builds the http server but never listens, so a test can reach the routes without
 * binding a socket. The one place that starts it is server.ts.
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { INSTANCE, STATE_DIR, STATE_FILE, buildHash, readJsonFile, writeJsonFile } from "./paths.ts";
import { createSession, endSession, hasSession, sessionCookie, token } from "./login.ts";
import { answer, fail, send, serveStatic } from "./http.ts";
import { activeConfig, activeHomeDefaults, describeWorkspace, ensureScratch, welcomeClients, workspaceList, workspaces } from "./workspaces.ts";
import { boardFrom, boards, flushBoard } from "./store.ts";
import { boardSettingsValues, settingsDocument } from "./settings-document.ts";
import { boardMeta, cardsFor } from "./cards.ts";
import { closedCards } from "./bus.ts";
import { gitPicture, refreshGit, unwatchGit, watchGit } from "./git/graph.ts";
import { BUILTIN_TOOLS, CHILD_EXTENSIONS, THINKING_LEVELS, modelCatalog, readScope, resolveScope, saidScopeProblems } from "./models.ts";
import { onDefaults, onOpenWorkspace, onPickFile, onPickFolder, onScratchEmpty, onSettingsDefaults } from "./routes/crossroads.ts";
import { onBrowse, onEdit, onNote, onOpenCard, onPrograms, onRename, onSource } from "./routes/board/content.ts";
import { rowWithThought } from "./thought.ts";
import { sessionFile, sessionImage, transcriptOf } from "./session.ts";
import { extensionsDir } from "./child/argv.ts";
import { LOOPBACK, bindHost, boardUrls, isLoopback } from "./listen.ts";
import { onMode, onPath, onThread, onThreadSpawn } from "./routes/board/thread.ts";
import { onAnswer, onAsk, onPause } from "./routes/board/answer.ts";
import { onMessage, onMessageDrop, onMessageEdit } from "./routes/board/message.ts";
import { onDrop } from "./routes/board/drop.ts";
import { onCompact, onConfig, onLayout, onModel, onThinking } from "./routes/board/config.ts";
import { onPrompt, onPromptWrite, onPrompts, onWorkspacePrompt, onWorkspacePromptWrite } from "./routes/board/prompts.ts";
import { onSkill } from "./routes/board/skill.ts";
import { onCardPdf } from "./routes/board/pdf.ts";
import { onClean, onCleanClosed, onClose, onFragmentRemove, onFragments, onKill, onNew, onReopen, onRemove, onRemovePreview, onStop, onThreadCollect, onUndo } from "./routes/board/lifecycle.ts";
import { onShell } from "./routes/board/shell.ts";


/** Opening a browser is what a desktop app does; a service run asks for `--no-open`. */
export const OPEN_BROWSER = !process.argv.includes("--no-open");



// ---------- the server -----------------------------------------------------

export { token };



/** The routes a child may reach. Everything else on this daemon belongs to the human. */
export const THREAD_ROUTES = new Set(["/card/note", "/card/source", "/card/ask", "/thread/spawn", "/thread/path", "/thread/collect", "/skill", "/close"]);



/**
 * Who is asking. The daemon's own token is the human at the keyboard; a token minted for a child is
 * that one thread and nothing else, so the depth rule and the board scope read a decision rather than
 * a field the caller wrote. It is a guardrail, not a wall: a child that can read the state folder can
 * read the human's token, and nothing short of a separate OS user changes that.
 */
export function callerOf(given) {
	if (!given) return null;
	if (given === token) return { human: true };
	for (const board of boards.values()) {
		for (const thread of board.threads.values()) {
			if (thread.token && thread.token === given) return { human: false, board, thread };
		}
	}
	return null;
}



/**
 * The refusal a thread earns for asking what only the human may do, or null when it may go ahead.
 *
 * A thread that answers for a card the human started may write cards on its own board — notes, sources,
 * the question it puts to the human — and ask for work of its own, which the depth rule then decides.
 * A spawned child may do none of it: it reports in its last message and the thread that spawned it draws,
 * which is what keeps a flow of six children from leaving eighteen cards behind. Closing a card that is
 * spent is a thread's too, and a pin is what holds it back: the close handler refuses a pinned card
 * from anyone but the human. Layout, kill, config and clean belong to the human, and so does every other
 * board. The human at the keyboard is refused nothing here.
 */
export function threadRefusal(caller, method, pathname, workspace) {
	if (caller.human) return null;
	if (caller.thread?.parentThread) return "a spawned child has no board tools";
	if (method !== "POST" || !THREAD_ROUTES.has(pathname)) return "a thread may not use that";
	if (workspace !== caller.board.id) return "a thread may not use another board";
	return null;
}



/**
 * Who is asking, given what the request carried. A token in the query is the only credential then, so a
 * wrong one is refused rather than rescued by a cookie. Without one, the session cookie speaks for the
 * human and for nobody else: it never reaches `callerOf`, so a thread's token or the master token put
 * in a cookie is refused.
 */
export function callerFor(askedToken, cookieHeader) {
	if (askedToken) return callerOf(askedToken);
	return hasSession(cookieHeader) ? { human: true, via: "cookie" } : null;
}



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



/**
 * Whether a change made on the strength of a cookie came from this daemon's own origin.
 *
 * `Sec-Fetch-Site` is the browser's own word and it is enough where it is sent, but a browser sends the
 * `Sec-Fetch-*` family only to an address it trusts: https, localhost, 127.0.0.1. This daemon is reached as
 * `http://192.168.x.x` too, where every request arrives without one, so `Origin` answers for it there. The
 * host and port are what decide: the scheme is left out because the LAN case is plain http behind no proxy,
 * and a site on another port is another origin. A form from another site sends no `Origin` at all, and a
 * sandboxed frame sends the string `null`, which is not a URL and is no origin here.
 */
export function sameOriginRequest(headers) {
	if (headers["sec-fetch-site"] === "same-origin") return true;
	const origin = headers.origin;
	if (typeof origin !== "string" || !origin || origin === "null") return false;
	let parts;
	try {
		parts = new URL(origin);
	} catch {
		// Garbage is refused as a stranger, not thrown: a guard that throws answers 500 instead of 403.
		return false;
	}
	const host = headers.host;
	return typeof host === "string" && host !== "" && parts.host === host;
}



export const server = createServer((req, res) => {
	void (async () => {
		const url = requestUrl(req.url);
		// Static assets carry no session data, so the token only guards the data routes.
		if (req.method === "GET") {
			// The link pi prints is traded for a cookie and sent back without the token. A wrong token earns
			// neither, and the page is served as before.
			const asked = url.searchParams.get("token");
			if (asked && (url.pathname === "/" || /^\/w\/[0-9a-f]{6,64}\/?$/.test(url.pathname)) && callerOf(asked)?.human) {
				url.searchParams.delete("token");
				res.writeHead(303, {
					"Set-Cookie": sessionCookie(createSession(), req.headers["x-forwarded-proto"]),
					Location: url.pathname + url.search,
					"Cache-Control": "no-store",
					"Referrer-Policy": "no-referrer",
				});
				res.end();
				return;
			}
			const statics = {
				"/": ["welcome.html", "text/html; charset=utf-8"],
				"/welcome.js": ["welcome.js", "text/javascript; charset=utf-8"],
				"/welcome.css": ["welcome.css", "text/css; charset=utf-8"],
				// Both surfaces name this one in their head, so a tab carries the mark before the page paints.
				"/favicon.svg": ["favicon.svg", "image/svg+xml"],
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
		const caller = callerFor(url.searchParams.get("token"), req.headers.cookie);
		if (!caller) {
			// A refused POST has to have its body taken off the wire, otherwise the client's next
			// request rides the same socket into the leftovers and reads as a reset.
			req.resume();
			fail(res, 403, "forbidden");
			return;
		}
		// What a thread may reach is decided beside callerOf, so the rule can be tested without a child.
		const refusal = threadRefusal(caller, req.method, url.pathname, url.searchParams.get("workspace"));
		if (refusal) {
			req.resume();
			fail(res, 403, refusal);
			return;
		}
		// A cookie is sent with whatever a page asks for, so a change made on its strength has to come from
		// this origin. A token has to be written into the request, which no other site can do.
		if (caller.via === "cookie" && req.method !== "GET" && req.method !== "HEAD" && !sameOriginRequest(req.headers)) {
			req.resume();
			fail(res, 403, "cross-site request");
			return;
		}
		if (req.method === "POST" && url.pathname === "/logout") {
			req.resume();
			endSession(req.headers.cookie);
			res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store", "Set-Cookie": sessionCookie("", req.headers["x-forwarded-proto"]) });
			res.end("{}");
			return;
		}

		// ----- streams -----
		if (req.method === "GET" && url.pathname === "/events") {
			res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
			const scope = url.searchParams.get("scope");
			if (scope === "welcome") {
				// The crossroads only needs counts and previews, and it needs them as they change.
				send(new Set([res]), { type: "workspaces", workspaces: workspaceList().map(describeWorkspace) });
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
			answer(res, 200, { workspaces: workspaceList().map(describeWorkspace), instance: INSTANCE });
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
		// A prompt is a file every board reads and none of them owns, so this route takes no workspace: the
		// settings page can be the first page a human sees, with no workspace opened yet.
		if (req.method === "POST" && url.pathname === "/prompt") {
			await onPromptWrite(req, res);
			return;
		}
		// The same values as a document the settings page draws: the tree, this machine's catalogue, and
		// pi's levels, so the page needs nothing else to render a control per setting.
		if (req.method === "GET" && url.pathname === "/settings/defaults") {
			await onSettingsDefaults(res);
			return;
		}
		if (req.method === "POST" && url.pathname === "/workspace") {
			await onOpenWorkspace(req, res);
			return;
		}
		// The scratch row's empty press: the files and the cards, with the settings kept. It is not in
		// `THREAD_ROUTES`, so a child cannot reach it and only the human at the keyboard can empty it.
		if (req.method === "POST" && url.pathname === "/scratch/empty") {
			await onScratchEmpty(req, res);
			return;
		}
		if (req.method === "POST" && url.pathname === "/pick-folder") {
			req.resume();
			onPickFolder(res);
			return;
		}
		// The same dialog, opened on a file: the path to the text editor a code card opens in.
		if (req.method === "POST" && url.pathname === "/pick-file") {
			req.resume();
			onPickFile(res);
			return;
		}
		if (req.method === "GET" && url.pathname === "/browse") {
			onBrowse(url, res);
			return;
		}
		// The programs a `!` command can name. It is a GET like `/browse`, so `threadRefusal` keeps it to
		// the human: a thread names a command through the shell route, which is not in `THREAD_ROUTES`.
		if (req.method === "GET" && url.pathname === "/programs") {
			await onPrograms(url, res);
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
		// One picture out of a session file. The transcript names a picture by its number instead of
		// carrying its base64, so what the drawer polls for the words stays the size of the words; the
		// browser fetches each picture once and keeps it.
		const pictureAt = /^\/transcript\/([^/]+)\/image\/(\d+)$/.exec(url.pathname);
		if (req.method === "GET" && pictureAt) {
			const board = boardFrom(url, res);
			if (!board) return;
			const thread = board.threads.get(decodeURIComponent(pictureAt[1]));
			if (!thread) return void fail(res, 404, "no such thread");
			const file = thread.sessionId ? sessionFile({ id: board.id }, thread.sessionId) : "";
			const picture = file ? sessionImage(file, Number(pictureAt[2])) : null;
			if (!picture) return void fail(res, 404, "no picture there");
			const bytes = Buffer.from(picture.data, "base64");
			res.writeHead(200, { "Content-Type": picture.mime, "Content-Length": bytes.length, "Cache-Control": "private, max-age=60" });
			res.end(bytes);
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
		if (req.method === "GET" && url.pathname === "/prompts") {
			// The files a role, a mode and a flow are, listed for the settings page. Reading one is a
			// separate call, so the list stays small even when a prompt is long.
			onPrompts(res);
			return;
		}
		if (req.method === "GET" && url.pathname === "/prompt") {
			onPrompt(url, res);
			return;
		}
		if (req.method === "GET" && url.pathname === "/workspace-prompt") {
			// The two instruction files a workspace may keep in its own folder. They belong to a board rather
			// than to the studio's `prompts/`, so the folder is the board's and the name is one of two.
			const board = boardFrom(url, res);
			if (!board) return;
			onWorkspacePrompt(url, res, board);
			return;
		}
		if (req.method === "GET" && url.pathname === "/state") {
			const board = boardFrom(url, res);
			if (!board) return;
			answer(res, 200, {
				workspace: describeWorkspace({ id: board.id, folder: board.folder, name: board.name, openedAt: 0 }),
				threads: [...board.threads.values()].map(({ token: _token, ...thread }) => ({ ...thread, live: board.children.has(thread.id) })),
				cards: cardsFor(board),
				closed: closedCards(board),
				activity: board.activity,
				meta: boardMeta(board),
				// What the strip draws, read now rather than cached: a script asking gets the disk's answer.
				git: gitPicture(board),
			});
			return;
		}
		// What earlier trash actions left behind: a worktree, a folder or a branch no thread answers for. Read
		// per call, because it is git's answer and not the board's.
		if (req.method === "GET" && url.pathname === "/fragments") {
			const board = boardFrom(url, res);
			if (!board) return;
			// Awaited: the scan is a read that runs while the daemon keeps answering, and a failure in it
			// reaches the catch below instead of the process.
			await onFragments(req, res, board);
			return;
		}
		// This board's settings as one document: the tree the panel draws, the value each control holds, and
		// the route a change goes back through. Read per call, so a prompt file added while the daemon runs
		// is a leaf the panel offers without a restart.
		if (req.method === "GET" && url.pathname === "/settings/board") {
			const board = boardFrom(url, res);
			if (!board) return;
			answer(
				res,
				200,
				settingsDocument({
					scope: "board",
					// The editor is one program for the whole studio, so a board's page reads it from the defaults
					// rather than from its own config, where a copy taken at birth would go stale.
					values: boardSettingsValues(activeConfig(board), activeHomeDefaults()),
					title: "this board",
					subtitle: `${board.name} · ${board.folder}`,
					foot: "new threads only · a run in flight is untouched",
				}),
			);
			return;
		}
		if (req.method === "POST") {
			const routing = {
				"/thread": onThread,
				"/thread/spawn": onThreadSpawn,
				"/thread/path": onPath,
				"/mode": onMode,
				"/card/note": onNote,
				"/card/source": onSource,
				// Opening a file in the human's editor starts a program on their desktop, so this one is not in
				// THREAD_ROUTES: a child may draw a card, and may not run what a card names.
				"/card/open": onOpenCard,
				// The press that saves a note as a pdf. What answers is the file itself, which the browser takes as a
				// download, so this is not in THREAD_ROUTES: a child may write a card, and may not take a document
				// out of the studio.
				"/card/pdf": onCardPdf,
				"/skill": onSkill,
				"/card/ask": onAsk,
				"/edit": onEdit,
				"/rename": onRename,
				"/answer": onAnswer,
				// The human's clock on a question they are reading. Not in THREAD_ROUTES: a child may ask, and may
				// not take the stopwatch off its own question.
				"/card/pause": onPause,
				"/message": onMessage,
				"/message/edit": onMessageEdit,
				"/message/drop": onMessageDrop,
				"/layout": onLayout,
				"/close": onClose,
				// A thread tidies the closed children it spawned, with the same proof a sweep asks for.
				"/thread/collect": onThreadCollect,
				"/reopen": onReopen,
				"/undo": onUndo,
				"/model": onModel,
				"/thinking": onThinking,
				"/kill": onKill,
				"/config": onConfig,
				"/compact": onCompact,
				"/clean": onClean,
				"/new": onNew,
				// A command the human typed after `!`. Never in THREAD_ROUTES above: a shell is the human's.
				"/shell": onShell,
				// Removing a thread and its work is the human's, so none of these is in THREAD_ROUTES.
				"/remove/preview": onRemovePreview,
				"/remove": onRemove,
				"/fragments/remove": onFragmentRemove,
				// The Closed panel's one button: every card put away, retired with the proof `clean` uses.
				"/thread/clean-closed": onCleanClosed,
				// The two instruction files a workspace keeps beside its code. The human's page writes them,
				// so neither is in THREAD_ROUTES: a thread reads its instructions, it does not set them.
				"/workspace-prompt": onWorkspacePromptWrite,
			};
			const handler = routing[url.pathname];
			if (handler) {
				const board = boardFrom(url, res);
				if (!board) return;
				await handler(req, res, board, caller);
				return;
			}
			if (url.pathname === "/stop") {
				const board = boardFrom(url, res);
				if (!board) return;
				await onStop(req, res, board);
				return;
			}
			// A file dropped onto a message field. The body is the file itself and the name rides in the query,
			// so this one is read here rather than from `routing`: a handler there is handed no query.
			if (url.pathname === "/drop") {
				const board = boardFrom(url, res);
				if (!board) return;
				await onDrop(req, res, board, url.searchParams.get("name") ?? "");
				return;
			}
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



/** The address this daemon holds: this machine only, unless the entry was told otherwise. */
let bindAddress = LOOPBACK;



export function startListening(wanted, host = bindAddress) {
	bindAddress = host;
	server.once("error", onListenError);
	server.listen(wanted, host, onListening);
}



/**
 * A port somebody else took, or an address this machine does not have. The first is answered with any
 * free port, which is what the note on port reuse already promised; the second is a typo, and a typo
 * deserves one sentence rather than a stack from inside the socket.
 */
function onListenError(error) {
	if (error.code === "EADDRINUSE") return startListening(0, bindAddress);
	if (error.code === "EADDRNOTAVAIL" || error.code === "ENOTFOUND") {
		console.error(`pi-studio: this machine has no address ${bindAddress}. 0.0.0.0 answers on all of them; leaving --host off answers on this machine only.`);
		return void process.exit(1);
	}
	console.error(`pi-studio: could not listen on ${bindAddress}: ${error.message || error}`);
	process.exit(1);
}



export function onListening() {
	port = server.address().port;
	writeJsonFile(STATE_FILE, { token, port, at: new Date().toISOString() });
	const links = boardUrls(bindAddress, port, token);
	const url = links[0];
	console.log(`pi-studio${INSTANCE ? ` [${INSTANCE}]` : ""} listening on ${url}`);
	for (const link of links.slice(1)) console.log(`  also on ${link}`);
	// The link is a credential, and what it costs is worth knowing before it is shared.
	console.log(`that link signs a browser in for 30 days and then leaves the address bar; the token is also in ${STATE_FILE}`);
	if (!isLoopback(bindAddress)) {
		console.log(`open beyond this machine on ${bindAddress}: share the link only on a network you trust, and the session cookie travels as plain http unless a TLS proxy carries it`);
	}
	// Which build is answering matters the moment a tab looks wrong, so it is said out loud.
	console.log(`build ${buildHash()}${INSTANCE ? `, state ${STATE_DIR}` : ""}`);
	// The scratch folder is made at boot rather than on the first request, so the crossroads never draws a
	// row for a folder that is not there yet. A temp area that refuses it is said out loud here, once, rather
	// than as a row nobody can open on every refresh.
	const scratch = ensureScratch();
	const opened = scratch ? workspaces.filter((workspace) => workspace.folder !== scratch.folder) : workspaces;
	if (opened.length) console.log(`${opened.length} workspace${opened.length === 1 ? "" : "s"}, newest ${opened[0].name}`);
	else console.log("no workspace yet — open one on the crossroads");
	console.log(scratch ? `scratch ${scratch.folder}` : "the scratch folder could not be made — no throwaway row this session");
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
	let host;
	try {
		host = bindHost();
	} catch (error) {
		console.error(`pi-studio: ${error.message}`);
		process.exit(1);
	}
	startListening(Number(process.env.PI_STUDIO_PORT) || lastPort(), host);
}
