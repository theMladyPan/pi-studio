// @ts-nocheck -- lifted byte for byte; annotating it is its own commit.
/**
 * The daemon's assembly: the one request handler, the route table it walks, and the port it listens on.
 *
 * Importing this file builds the http server but never listens, so a test can reach the routes without
 * binding a socket. The one place that starts it is server.ts.
 */
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { spawn } from "node:child_process";
import { INSTANCE, STATE_DIR, STATE_FILE, buildHash, readJsonFile, writeJsonFile } from "./paths.ts";
import { createSession, endSession, hasSession, passwordIsSet, reloadLoginState, sessionCookie, token, unlockLockSecondsLeft, verifyMasterPassword } from "./login.ts";
import { MAX_PASSWORD_CHARS, UNLOCK_BODY_BYTES } from "./limits.ts";
import { answer, fail, readBody, rejectUpgrade, send, serveStatic, upgradeWebSocket } from "./http.ts";
import { activeConfig, activeHomeDefaults, describeWorkspace, ensureScratch, reloadWorkspaces, welcomeClients, workspaceById, workspaceList, workspaces } from "./workspaces.ts";
import { boardFor, boardFrom, boards, flushBoard } from "./store.ts";
import { boardSettingsValues, settingsDocument } from "./settings-document.ts";
import { boardMeta, cardsFor } from "./cards.ts";
import { closedCards } from "./bus.ts";
import { BUILTIN_TOOLS, CHILD_EXTENSIONS, THINKING_LEVELS, modelCatalog, readScope, resolveScope, saidScopeProblems } from "./models.ts";
import { onDefaults, onForgetWorkspace, onOpenWorkspace, onPickFile, onPickFolder, onScratchEmpty, onSettingsDefaults, onSettingsGeneral } from "./routes/crossroads.ts";
import { onBrowse, onEdit, onNote, onOpenCard, onPrograms, onRename, onSource } from "./routes/board/content.ts";
import { onFileCopy, onFileDelete, onFileMove, onFileNew, onFileRaw, onFileRead, onFileRename, onFileWrite, onFilesList } from "./routes/board/files.ts";
import { rowWithThought } from "./thought.ts";
import { sessionFile, sessionImage, transcriptOf } from "./session.ts";
import { extensionsDir } from "./child/argv.ts";
import { LOOPBACK, bindHost, bindSource, boardUrls, isLoopback, publishConfig, tlsConfig } from "./listen.ts";
import { onMode, onPath, onThread, onThreadSpawn } from "./routes/board/thread.ts";
import { onAnswer, onAsk, onPause } from "./routes/board/answer.ts";
import { onMessage, onMessageDrop, onMessageEdit } from "./routes/board/message.ts";
import { onDrop } from "./routes/board/drop.ts";
import { onCompact, onConfig, onLayout, onModel, onThinking } from "./routes/board/config.ts";
import { onPrompt, onPromptWrite, onPrompts, onWorkspacePrompt, onWorkspacePromptWrite } from "./routes/board/prompts.ts";
import { flowDiagrams } from "./flow-diagrams.ts";
import { onSkill } from "./routes/board/skill.ts";
import { onCardPdf } from "./routes/board/pdf.ts";
import { onClean, onCleanClosed, onClose, onFragmentRemove, onFragments, onKill, onNew, onReopen, onRemove, onRemovePreview, onStop, onThreadCollect, onUndo } from "./routes/board/lifecycle.ts";
import { onShell } from "./routes/board/shell.ts";
import { onGitInit, onGitMsg, onGitPage } from "./routes/gitgraph.ts";
import { onPluginRegistry, onPluginReload, onVisualFile, onVisualPanels, onVisualRequest, VISUAL_PREFIX } from "./routes/plugins.ts";
import { onCommand } from "./routes/board/command.ts";
import { onSourceControlCommit, onSourceControlConflict, onSourceControlContinue, onSourceControlDiff, onSourceControlDiscard, onSourceControlFileAtHead, onSourceControlIgnore, onSourceControlMessage, onSourceControlResolve, onSourceControlStage, onSourceControlStatus, onSourceControlUnstage } from "./routes/board/source-control.ts";
import { attachTerminal, stopAllTerminals, terminalSize } from "./terminal.ts";
import { startPlugins, stopPlugins } from "./plugins/manager.ts";
import { createPluginService } from "./plugins/service.ts";
import { commandList, forMenu } from "./commands.ts";
import { workdirOf } from "./worktrees/make.ts";
import { migrateLegacyGlobalState } from "./state-storage.ts";


/** Opening a browser is what a desktop app does; a service run asks for `--no-open`. */
export const OPEN_BROWSER = !process.argv.includes("--no-open");



// ---------- the server -----------------------------------------------------

export { token };



/** The routes a child may reach. Everything else on this daemon belongs to the human. */
export const THREAD_ROUTES = new Set(["/card/note", "/card/source", "/card/ask", "/thread/spawn", "/thread/collect", "/skill", "/close"]);



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
	const forwardedHost = headers["x-forwarded-host"] || headers.host;
	const host = typeof forwardedHost === "string" ? forwardedHost.split(",")[0].trim() : "";
	return host !== "" && parts.host === host;
}




/** Upgrade one live request to a WebSocket before it can join a board or the welcome stream. */
function startLiveStream(req, socket, head) {
	let url;
	try {
		url = requestUrl(req.url);
	} catch {
		rejectUpgrade(socket, 400, "bad request target");
		return;
	}
	if (req.method !== "GET" || url.pathname !== "/events") {
		socket.destroy();
		return;
	}
	const caller = callerFor(url.searchParams.get("token"), req.headers.cookie);
	if (!caller) {
		rejectUpgrade(socket, 403, "forbidden");
		return;
	}
	const refusal = threadRefusal(caller, "GET", url.pathname, url.searchParams.get("workspace"));
	if (refusal) {
		rejectUpgrade(socket, 403, refusal);
		return;
	}
	if (caller.via === "cookie" && !sameOriginRequest(req.headers)) {
		rejectUpgrade(socket, 403, "cross-site request");
		return;
	}
	const scope = url.searchParams.get("scope");
	let board = null;
	if (scope !== "welcome") {
		const workspace = workspaceById(url.searchParams.get("workspace") ?? "");
		if (!workspace) {
			rejectUpgrade(socket, 409, "no such workspace");
			return;
		}
		try {
			board = boardFor(workspace);
		} catch (error) {
			// An unsafe or unwritable project home (a linked `.pi-studio`, a read-only folder) is a
			// clear refusal here, never a thrown upgrade that takes the daemon down with it.
			rejectUpgrade(socket, 503, `project state could not be opened: ${error.message}`);
			return;
		}
	}
	const client = upgradeWebSocket(req, socket, head);
	if (!client || client.writableEnded || client.destroyed) return;
	if (scope === "welcome") {
		const keepAlive = setInterval(() => client.ping(), 20_000);
		if (typeof keepAlive.unref === "function") keepAlive.unref();
		const forget = () => {
			clearInterval(keepAlive);
			welcomeClients.delete(client);
		};
		client.onClose = forget;
		send(new Set([client]), { type: "workspaces", workspaces: workspaceList().map(describeWorkspace) });
		if (!client.writableEnded && !client.destroyed) welcomeClients.add(client);
		return;
	}
	const keepAlive = setInterval(() => client.ping(), 20_000);
	if (typeof keepAlive.unref === "function") keepAlive.unref();
	const forget = () => {
		clearInterval(keepAlive);
		board.clients.delete(client);
	};
	client.onClose = forget;
	send(new Set([client]), {
		type: "snapshot",
		cards: cardsFor(board),
		closed: closedCards(board),
		activity: board.activity,
		meta: boardMeta(board),
	});
	if (!client.writableEnded && !client.destroyed) {
		board.clients.add(client);
	}
}

/** Upgrade one terminal request to a WebSocket before it can join its board's shell. */
function startTerminalStream(req, socket, head) {
	let url;
	try {
		url = requestUrl(req.url);
	} catch {
		rejectUpgrade(socket, 400, "bad request target");
		return;
	}
	if (req.method !== "GET" || url.pathname !== "/terminal") {
		socket.destroy();
		return;
	}
	const caller = callerFor(url.searchParams.get("token"), req.headers.cookie);
	if (!caller) {
		rejectUpgrade(socket, 403, "forbidden");
		return;
	}
	// A thread may not use it: `/terminal` names no thread route, so every caller but the human
	// is refused here, the same way the live stream refuses one.
	const refusal = threadRefusal(caller, "GET", url.pathname, url.searchParams.get("workspace"));
	if (refusal) {
		rejectUpgrade(socket, 403, refusal);
		return;
	}
	if (caller.via === "cookie" && !sameOriginRequest(req.headers)) {
		rejectUpgrade(socket, 403, "cross-site request");
		return;
	}
	const workspace = workspaceById(url.searchParams.get("workspace") ?? "");
	if (!workspace) {
		rejectUpgrade(socket, 409, "no such workspace");
		return;
	}
	// The handle is made by the first message that needs the shell, so the shell is born at the
	// size the drawer measured rather than the default. `client` is assigned by the upgrade the
	// messages arrive through, so the emit closes over the one the handler finds.
	let client;
	let handle = null;
	const emit = (event) => {
		if (!client || client.writableEnded || client.destroyed) return;
		client.write(JSON.stringify(event));
	};
	const attach = () => {
		if (!handle) handle = attachTerminal(workspace.id, workspace.folder, emit);
		return handle;
	};
	client = upgradeWebSocket(req, socket, head, (payload) => {
		let message;
		try {
			message = JSON.parse(String(payload));
		} catch {
			return;
		}
		if (message?.type === "resize") attach().resize(terminalSize(message));
		else if (message?.type === "input" && typeof message.data === "string") attach().write(message.data);
	});
	if (!client || client.writableEnded || client.destroyed) {
		// A message that arrived in the upgrade head may have attached a listener before this
		// return; a dead tab must not stay attached to the shell.
		handle?.detach();
		return;
	}
	const keepAlive = setInterval(() => client.ping(), 20_000);
	if (typeof keepAlive.unref === "function") keepAlive.unref();
	// A closed tab detaches from the shell; the shell itself outlives it, as a terminal left
	// open in another window would.
	client.onClose = () => {
		clearInterval(keepAlive);
		handle?.detach();
	};
}

/** Native TLS, set by `start()` before the socket opens; null on a plain-http daemon. */
let tlsOptions = null;
/** The HTTPS listener, when TLS is on; the exported `server` stays the plain-http one. */
let httpsServer = null;
/** The HTTPS port plain-http redirects point at, once the main socket is open. */
let tlsPort = 0;
/** Whether plain http may be spoken beyond loopback, from the publish choice at start. */
let plainHttpAllowed = true;

/** Whether this request arrived on the daemon's own HTTPS listener. */
function servedTlsOf(req) {
	return Boolean(req?.socket?.encrypted);
}

/**
 * Whether the other end of this socket is this machine. The Host header cannot say it — any peer can
 * claim it — so the peer's address decides the loopback exemption.
 */
function isLoopbackAddress(address) {
	const normalised = String(address ?? "").replace(/^::ffff:/, "");
	return normalised === "127.0.0.1" || normalised === "::1";
}

/** The bare hostname from a Host header, port and brackets stripped for the redirect target. */
function hostHeaderHostname(value) {
	const header = String(value ?? "").trim();
	if (!header) return "";
	if (header.startsWith("[")) {
		const close = header.indexOf("]");
		return close === -1 ? header : header.slice(0, close + 1);
	}
	return header.split(":")[0];
}

/**
 * Where a plain-http request beyond loopback goes when plain http is refused and TLS answers: the same
 * path and query on the HTTPS port. Loopback requests and requests already on HTTPS never redirect,
 * so the printed local link keeps working over plain http.
 */
export function httpsRedirectLocation(req, url) {
	if (tlsPort <= 0 || plainHttpAllowed) return null;
	if (isLoopback(bindAddress)) return null;
	if (servedTlsOf(req)) return null;
	if (isLoopbackAddress(req.socket?.remoteAddress)) return null;
	const hostname = hostHeaderHostname(req.headers?.host) || (bindAddress.includes(":") ? `[${bindAddress}]` : bindAddress);
	return `https://${hostname}:${tlsPort}${url.pathname}${url.search}`;
}

function requestHandler(req, res) {
	void (async () => {
		const url = requestUrl(req.url);
		const httpsLocation = httpsRedirectLocation(req, url);
		if (httpsLocation) {
			res.writeHead(308, { Location: httpsLocation, "Cache-Control": "no-store" });
			res.end();
			return;
		}
		// Static assets carry no session data, so the token only guards the data routes.
		if (req.method === "GET") {
			// The link pi prints is traded for a cookie and sent back without the token. A wrong token earns
			// neither, and the page is served as before. A Git Graph page is one of the pages this trades for:
			// it too is opened from a printed link, and its commands then travel on the cookie that link left.
			const asked = url.searchParams.get("token");
			if (asked && (url.pathname === "/" || /^\/w\/[0-9a-f]{6,64}\/?$/.test(url.pathname) || /^\/git\/[0-9a-f]{6,64}\/?$/.test(url.pathname)) && callerOf(asked)?.human) {
				url.searchParams.delete("token");
				res.writeHead(303, {
					"Set-Cookie": sessionCookie(createSession(), req.headers["x-forwarded-proto"], servedTlsOf(req)),
					Location: url.pathname + url.search,
					"Cache-Control": "no-store",
					"Referrer-Policy": "no-referrer",
				});
				res.end();
				return;
			}
			if (url.pathname === "/unlock") {
				// The doorbell for a signed-out browser: the password form when one is set, and a plain
				// sentence when none is, so nobody stares at a dead form.
				if (!passwordIsSet()) {
					res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
					res.end("<!doctype html><html><head><meta charset=utf-8><title>pi-studio</title></head><body><p>No master password is set on this daemon. Open the link pi printed on this machine, or set one there with <code>pi-studio password</code>.</p></body></html>");
					return;
				}
				serveStatic(res, "unlock.html", "text/html; charset=utf-8", { "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'", "Referrer-Policy": "no-referrer" });
				return;
			}
			const statics = {
				"/": ["welcome.html", "text/html; charset=utf-8"],
				"/welcome.js": ["welcome.js", "text/javascript; charset=utf-8"],
				"/welcome.css": ["welcome.css", "text/css; charset=utf-8"],
				// Both surfaces name this one in their head, so a tab carries the mark before the page paints.
				"/favicon.svg": ["favicon.svg", "image/svg+xml"],
				// The Explorer's icon set and font. They are named here one file at a time so that no request can
				// turn a path into a file this daemon does not mean to serve.
				"/explorer/seti.woff": ["explorer/seti.woff", "font/woff"],
				"/explorer/codicon.ttf": ["explorer/codicon.ttf", "font/ttf"],
				"/explorer/vs-seti-icon-theme.json": ["explorer/vs-seti-icon-theme.json", "application/json"],
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
			if (/^\/client\/[a-z0-9/_-]+\.css$/.test(url.pathname)) {
				serveStatic(res, url.pathname.slice(1), "text/css; charset=utf-8");
				return;
			}
			// A workspace's board is the same page for every folder; the id in the path tells it which.
			if (/^\/w\/[0-9a-f]{6,64}\/?$/.test(url.pathname)) {
				serveStatic(res, "index.html", "text/html; charset=utf-8");
				return;
			}
			// The Git Graph page and its own client modules are here rather than behind the caller check for one
			// reason: neither carries data. The page is the same document for every workspace, and the modules are
			// served by the `/client` rule above; what a tab does with them is asked for at `/git/init` and
			// `/git/msg`, and both of those are behind the token.
			if (/^\/git\/[0-9a-f]{6,64}\/?$/.test(url.pathname)) {
				onGitPage(res);
				return;
			}
			// A panel is a page the daemon serves to a frame that has no origin of its own, and a document with
			// an opaque origin has no cookie of this daemon to send: `SameSite=Strict` keeps the session out of
			// the style and the script the page asks for, so a panel behind the caller check arrives as a page
			// with no style and no script. Its bytes are here for the same reason the Git Graph page's are — the
			// files a plugin declared carry no workspace data — and what is served is a lookup in that list of
			// files, never a path joined to a folder. The roster that names the doors and the one call a panel
			// makes stay below, behind the caller check: what a panel may ask for is still the human's alone.
			if (url.pathname.startsWith(VISUAL_PREFIX)) {
				onVisualFile(res, url.pathname);
				return;
			}
		}
		// The master's doorbell, before the caller gate: a signed-out browser has no cookie yet, and a
		// cross-site form has no business trying passwords or slamming the lockout, so the origin check
		// comes first. A correct password trades for the same session cookie the printed link mints.
		if (req.method === "POST" && url.pathname === "/unlock") {
			if (!sameOriginRequest(req.headers)) {
				req.resume();
				fail(res, 403, "cross-site request");
				return;
			}
			const raw = await readBody(req, UNLOCK_BODY_BYTES);
			if (raw === undefined) {
				fail(res, 413, "body too large");
				return;
			}
			let parsed;
			try {
				parsed = JSON.parse(raw);
			} catch {
				fail(res, 400, "bad json");
				return;
			}
			const candidate = parsed?.password;
			if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > MAX_PASSWORD_CHARS) {
				fail(res, 400, "bad password field");
				return;
			}
			const verdict = await verifyMasterPassword(candidate);
			if (verdict === "unset") {
				fail(res, 404, "no master password is set");
				return;
			}
			if (verdict === "locked") {
				res.setHeader("Retry-After", String(unlockLockSecondsLeft()));
				fail(res, 429, "locked — try again later");
				return;
			}
			if (verdict !== "ok") {
				fail(res, 401, "wrong password");
				return;
			}
			res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store", "Set-Cookie": sessionCookie(createSession(), req.headers["x-forwarded-proto"], servedTlsOf(req)) });
			res.end("{}");
			return;
		}
		const caller = callerFor(url.searchParams.get("token"), req.headers.cookie);
		if (!caller) {
			// A refused POST has to have its body taken off the wire, otherwise the client's next
			// request rides the same socket into the leftovers and reads as a reset.
			req.resume();
			if (passwordIsSet()) res.setHeader("X-Pi-Studio-Unlock", "1");
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
			res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store", "Set-Cookie": sessionCookie("", req.headers["x-forwarded-proto"], servedTlsOf(req)) });
			res.end("{}");
			return;
		}

		// ----- streams -----
		// Live board data is upgraded in startLiveStream. A plain HTTP request to /events is the
		// fallback for a proxy that does not carry the upgrade. Browsers use it only when the
		// WebSocket cannot open, and through HTTPS it still multiplexes over the one connection.
		if (req.method === "GET" && url.pathname === "/events") {
			res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
			const scope = url.searchParams.get("scope");
			if (scope === "welcome") {
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
			});
			board.clients.add(res);
			const keepAlive = setInterval(() => res.write(": ping\n\n"), 20_000);
			const forget = () => {
				clearInterval(keepAlive);
				board.clients.delete(res);
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
		if (req.method === "POST" && url.pathname === "/settings/general") {
			await onSettingsGeneral(req, res);
			return;
		}
		if (req.method === "POST" && url.pathname === "/workspace") {
			await onOpenWorkspace(req, res);
			return;
		}
		// Forget one row from the crossroads list: the entry only, never the folder. Not in
		// `THREAD_ROUTES`, so a child cannot reach it and only the human at the keyboard can remove it.
		if (req.method === "POST" && url.pathname === "/workspace/forget") {
			await onForgetWorkspace(req, res);
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
		// The Explorer's listing: the board's own folder, always, and never the tree a thread works in. It is
		// a GET like `/browse`, so `threadRefusal` keeps it to the human, and its six changes below are not
		// in `THREAD_ROUTES` either: a child reports in its last message instead of moving the human's files.
		if (req.method === "GET" && url.pathname === "/files") {
			const board = boardFrom(url, res);
			if (!board) return;
			await onFilesList(url, res, board);
			return;
		}
		// The editor's read: one file of that same folder, with the line endings and the byte order mark it
		// carries, so a save can put them back. A GET like `/files`, so `threadRefusal` keeps it to the human.
		if (req.method === "GET" && url.pathname === "/files/read") {
			const board = boardFrom(url, res);
			if (!board) return;
			await onFileRead(url, res, board);
			return;
		}
		// The viewer's read: the same file as itself, for the browser to draw. A GET and its HEAD, like
		// `/files/read`, so `threadRefusal` keeps it to the human; the bytes are streamed, with ranges.
		if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/files/raw") {
			const board = boardFrom(url, res);
			if (!board) return;
			await onFileRaw(req, url, res, board);
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
			const file = thread.sessionId ? sessionFile({ id: board.id, folder: board.folder }, thread.sessionId) : "";
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
			const file = thread.sessionId ? sessionFile({ id: board.id, folder: board.folder }, thread.sessionId) : "";
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
			const { models, levels, trouble } = await modelCatalog();
			const scope = readScope();
			const { scoped, problems } = resolveScope(scope, models);
			for (const pattern of problems) {
				if (saidScopeProblems.has(pattern)) continue;
				saidScopeProblems.add(pattern);
				console.error(`pi-studio: pi's scope pattern ${JSON.stringify(pattern)} matched no model here`);
			}
			// `trouble` is read by the picker: a list that pi would not give is a list to explain, never to
			// pass off as everything this machine has.
			answer(res, 200, { models, levels, scope, scoped, problems, trouble });
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
		if (req.method === "GET" && url.pathname === "/commands") {
			// The composer's `/` menu: every slash command pi offers the thread it is typed in. The folder
			// decides the list — prompt templates and skills come from it — so a card names the thread and a
			// request without one is asking about the board's own folder. No child is ensured here: making
			// one cuts a worktree, and an open of the menu is not work.
			const board = boardFrom(url, res);
			if (!board) return;
			const cardId = url.searchParams.get("cardId") ?? "";
			const thread = cardId ? board.threads.get(cardId) : undefined;
			if (cardId && !thread) return void fail(res, 409, "no thread answers this card");
			const { commands, trouble } = await commandList(board, thread ? workdirOf(board, thread) : board.folder, url.searchParams.get("fresh") === "1");
			// A probe that failed is a 200 with no commands and the reason in `trouble`: the menu says what went
			// wrong, where an error status would read as a daemon that has no such route.
			answer(res, 200, { commands: forMenu(commands), trouble });
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
		if (req.method === "GET" && url.pathname === "/flows") {
			// The drawings of the three flows, read from the document that draws each one once. The flow chip
			// hovers them, so the page shows the board's own picture rather than a second copy kept in code.
			answer(res, 200, { flows: await flowDiagrams() });
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
			});
			return;
		}
		// The three globals the Git Graph page reads before it draws, and whether it may draw at all. It is
		// behind the caller check and the workspace check like `/state`, because what it hands out is a path
		// on this machine and the repositories the page is then allowed to read.
		if (req.method === "GET" && url.pathname === "/git/init") {
			const board = boardFrom(url, res);
			if (!board) return;
			await onGitInit(res, board);
			return;
		}
		// The source control drawer's two lists and branch, read per call: git's answer, not the board's.
		if (req.method === "GET" && url.pathname === "/source-control/status") {
			const board = boardFrom(url, res);
			if (!board) return;
			await onSourceControlStatus(req, res, board);
			return;
		}
		if (req.method === "GET" && url.pathname === "/source-control/file") {
			const board = boardFrom(url, res);
			if (!board) return;
			await onSourceControlFileAtHead(req, res, board);
			return;
		}
		if (req.method === "GET" && url.pathname === "/source-control/diff") {
			const board = boardFrom(url, res);
			if (!board) return;
			await onSourceControlDiff(req, res, board);
			return;
		}
		if (req.method === "GET" && url.pathname === "/source-control/conflict") {
			const board = boardFrom(url, res);
			if (!board) return;
			await onSourceControlConflict(req, res, board);
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
					title: "Board specific settings",
					// No subtitle on a board's document: the panel floats over its own board and names no folder.
					subtitle: "",
					foot: "new threads only · a run in flight is untouched",
				}),
			);
			return;
		}
		// The panels a plugin may put on this board, and the one call a panel makes. They name no board of
		// their own, because a panel belongs to the daemon rather than to a folder, and they sit behind the
		// caller check like every other data route because a panel is the human's to see. The files a panel is
		// made of are not here: they are served above, before this check, for the reason kept beside them.
		if (req.method === "GET" && url.pathname === "/plugins/visual") {
			onVisualPanels(res);
			return;
		}
		// Restart every registered plugin from the file as it stands on disk, without writing it.
		// Decided behind the caller check like the registry beside it: it starts whatever the rows
		// name, so only the human may ask, and a thread has no route to it.
		if (url.pathname === "/plugins/reload" && req.method === "POST") {
			await onPluginReload(res);
			return;
		}
		// Decide, behind the caller check like the panel listing: a row here starts whatever it names,
		// so only the human may write one, and a thread has no route to it.
		if (url.pathname === "/plugins/registry") {
			await onPluginRegistry(req, res);
			return;
		}
		if (req.method === "POST") {
			// One call a panel's frame makes. The plugin is the one whose panel is on screen, and the
			// workspace is resolved here from this daemon's own list, so a page never names a folder.
			if (url.pathname === "/plugins/visual/request") {
				await onVisualRequest(req, res, url, caller);
				return;
			}
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
				// A slash command pi offers this thread, run inside it. Not in THREAD_ROUTES either: a command
				// reaches pi's own extensions, and that is the human's call on their own board.
				"/command": onCommand,
				// Removing a thread and its work is the human's, so none of these is in THREAD_ROUTES.
				"/remove/preview": onRemovePreview,
				"/remove": onRemove,
				"/fragments/remove": onFragmentRemove,
				// The Closed panel's one button: every card put away, retired with the proof `clean` uses.
				"/thread/clean-closed": onCleanClosed,
				// The two instruction files a workspace keeps beside its code. The human's page writes them,
				// so neither is in THREAD_ROUTES: a thread reads its instructions, it does not set them.
				"/workspace-prompt": onWorkspacePromptWrite,
				// One message from the Git Graph page, answered with the replies it earned. Not in THREAD_ROUTES:
				// this route runs git in the human's checkouts, and a child reports in its last message instead.
				"/git/msg": onGitMsg,
				// The source control drawer's four changes. None is in THREAD_ROUTES: a child reports in
				// its last message instead of staging or committing in the human's checkout.
				"/source-control/stage": onSourceControlStage,
				"/source-control/unstage": onSourceControlUnstage,
				"/source-control/commit": onSourceControlCommit,
				"/source-control/message": onSourceControlMessage,
				"/source-control/resolve": onSourceControlResolve,
				"/source-control/continue": onSourceControlContinue,
				"/source-control/discard": onSourceControlDiscard,
				"/source-control/ignore": onSourceControlIgnore,
				// The Explorer's six changes. None is in THREAD_ROUTES: a child may draw a card, and may not
				// rename, delete or save over the files of the folder a human opened.
				"/files/new": onFileNew,
				"/files/rename": onFileRename,
				"/files/move": onFileMove,
				"/files/copy": onFileCopy,
				"/files/delete": onFileDelete,
				"/files/write": onFileWrite,
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
}

export const server = createServer(requestHandler);

function onUpgrade(req, socket, head) {
	// Upgrades never reach the request handler, so the plain-http refusal is answered here: a
	// non-loopback plain socket is dropped rather than handed the board or the shell.
	if (!plainHttpAllowed && tlsPort > 0 && !servedTlsOf(req) && !isLoopbackAddress(req.socket?.remoteAddress)) {
		socket.destroy();
		return;
	}
	let pathname = "";
	try {
		pathname = requestUrl(req.url).pathname;
	} catch {
		// The live stream answers a bad target itself.
	}
	if (pathname === "/terminal") startTerminalStream(req, socket, head);
	else startLiveStream(req, socket, head);
}

server.on("upgrade", onUpgrade);

/** Set once the daemon is on its way out, so a second signal does not flush and close everything twice. */
let stopping = false;

/** The plugin start in flight. `start()` sets it, and a signal waits on it before it leaves. */
let pluginsUp: Promise<unknown> = Promise.resolve();

/**
 * Stop every plugin, including one still on its way up, and answer once they are gone.
 *
 * A start in flight is in no manager yet — the roster is held only once every handshake is answered —
 * so closing what `pluginManager()` holds would close nothing and leave that plugin behind a daemon
 * that had already gone. Both waits carry their own clock, the handshake's and the close's, so this
 * settles on its own; nothing here is raced against a timer, because a timer that fired first is
 * exactly what would strand the process it was waiting for.
 */
async function stopPluginsOnExit() {
	await pluginsUp;
	await stopPlugins();
}

export function shutdown() {
	if (stopping) return;
	stopping = true;
	// What the debounce still holds is the last thing the human did, so it goes to disk first.
	for (const board of boards.values()) flushBoard(board);
	stopAllTerminals();
	for (const board of boards.values()) for (const child of board.children.values()) child.kill("SIGKILL");
	// A plugin is a process this daemon started, so it is asked to stop before the daemon goes and the
	// exit waits for it. The clock below is the end of that wait: a plugin that ignores `shutdown` is
	// left to the operating system rather than keeping a stopped daemon alive.
	const plugins = stopPluginsOnExit();
	const done = () => {
		void plugins.finally(() => process.exit(0));
	};
	server.close(done);
	httpsServer?.close(done);
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
	if (tlsOptions) {
		httpsServer = createHttpsServer(tlsOptions, requestHandler);
		httpsServer.on("tlsClientError", (error) => {
			console.error(`pi-studio: a plain http request reached the https port: ${error.message || error}`);
		});
		httpsServer.on("upgrade", onUpgrade);
		httpsServer.once("error", onListenError);
		httpsServer.listen(wanted, host, onListening);
		return;
	}
	server.once("error", onListenError);
	server.listen(wanted, host, onListening);
}



/**
 * A port somebody else took, or an address this machine does not have. The first is answered with any
 * free port, which is what the note on port reuse already promised; the second is a typo, and a typo
 * deserves one sentence rather than a stack from inside the socket.
 */
function onListenError(error) {
	if (error.code === "EADDRINUSE") {
		const askedPort = String(process.env.PI_STUDIO_PORT ?? "").trim();
		if (askedPort) {
			console.error(`pi-studio: port ${askedPort} is already taken; the daemon is not moving elsewhere. Free it or pick another port.`);
			process.exit(1);
		}
		return startListening(0, bindAddress);
	}
	if (error.code === "EADDRNOTAVAIL" || error.code === "ENOTFOUND") {
		console.error(`pi-studio: this machine has no address ${bindAddress}. 0.0.0.0 answers on all of them; leaving --host off answers on this machine only.`);
		return void process.exit(1);
	}
	console.error(`pi-studio: could not listen on ${bindAddress}: ${error.message || error}`);
	process.exit(1);
}



export function onListening() {
	const mainServer = httpsServer ?? server;
	port = mainServer.address().port;
	if (tlsOptions) tlsPort = port;
	const saved = readJsonFile(STATE_FILE, null) ?? {};
	writeJsonFile(STATE_FILE, { ...saved, token, port, at: new Date().toISOString() });
	const links = boardUrls(bindAddress, port, token, undefined, tlsOptions ? "https" : "http");
	const url = links[0];
	console.log(`pi-studio${INSTANCE ? ` [${INSTANCE}]` : ""} listening on ${url}`);
	for (const link of links.slice(1)) console.log(`  also on ${link}`);
	if (tlsOptions && port > 1) {
		// The plain-http listener rides on the main port's neighbour: the whole board when plain http
		// is allowed, and a redirect to HTTPS when it is not. Loopback links printed above stay on the
		// HTTPS port, which answers there too.
		const plainPort = port - 1;
		server.once("error", (error) => {
			console.error(`pi-studio: plain http on ${plainPort} could not open: ${error.message || error}`);
		});
		server.listen(plainPort, bindAddress, () => {
			console.log(`plain http on http://127.0.0.1:${plainPort}${plainHttpAllowed || isLoopback(bindAddress) ? "" : " (redirects to https)"}`);
		});
	}
	// The link is a credential, and what it costs is worth knowing before it is shared.
	console.log(`that link signs a browser in for 30 days and then leaves the address bar; the token is also in ${STATE_FILE}`);
	if (!isLoopback(bindAddress)) {
		if (tlsOptions) console.log(`open beyond this machine on ${bindAddress} over https: share the link only on a network you trust`);
		else console.log(`open beyond this machine on ${bindAddress}: share the link only on a network you trust, and the session cookie travels as plain http unless a TLS proxy carries it`);
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
	// The one-time legacy import runs here, at startup, rather than at import,
	// so importing daemon code writes nothing. What the import copied is re-read into memory below.
	try {
		if (migrateLegacyGlobalState()) {
			reloadWorkspaces();
			reloadLoginState();
		}
	} catch (error) {
		console.error(`pi-studio: ${error.message}`);
		process.exit(1);
	}
	let host;
	let tls;
	let publish;
	try {
		publish = publishConfig();
		host = bindHost(process.argv.slice(2), process.env, publish.host);
		console.log(`pi-studio: publishing on ${host} (from ${bindSource(process.argv.slice(2), process.env, publish.host)})`);
		tls = tlsConfig();
		plainHttpAllowed = publish.allowPlainHttp !== false;
		if (!isLoopback(host) && !plainHttpAllowed && !tls.enabled) {
			console.error("pi-studio: plain http is refused beyond this machine, so this daemon needs a TLS certificate or loopback; leaving allow plain http on serves plain http");
			process.exit(1);
		}
		if (tls.enabled) tlsOptions = { key: tls.keyData, cert: tls.certData };
	} catch (error) {
		console.error(`pi-studio: ${error.message}`);
		process.exit(1);
	}
	// A stopped daemon must not leave its shells behind: they are spawned detached, so a plain exit
	// would orphan them. A plugin is a process this daemon started too, so it is asked to stop and the
	// exit waits for it, however slowly it was coming up. The boards are left as they are: a signal does
	// not flush, so a caller that stops a daemon and then deletes the folder it served is not racing a
	// write. `shutdown` is the explicit way out that flushes first.
	const stop = () => {
		if (stopping) return;
		stopping = true;
		stopAllTerminals();
		void stopPluginsOnExit().finally(() => process.exit(0));
	};
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
	// An explicitly asked port is a promise: a proxy may already point at it, so a taken one is
	// a failure with one sentence, never a quiet move to a port nobody else knows about.
	const askedPort = String(process.env.PI_STUDIO_PORT ?? "").trim();
	let wantedPort = 0;
	if (askedPort) {
		wantedPort = Number(askedPort);
		if (!Number.isInteger(wantedPort) || wantedPort < 1 || wantedPort > 65535) {
			console.error(`pi-studio: PI_STUDIO_PORT "${askedPort}" is not a port between 1 and 65535`);
			process.exit(1);
		}
	} else {
		wantedPort = lastPort();
	}
	startListening(wantedPort, host);
	// The plugins the human registered start after the socket is open, so a plugin that never answers its
	// handshake delays nothing the human is waiting for. Each start is its own: one that fails is a line
	// on stderr and the rest of the roster runs. Nothing is started before this call, and nothing here
	// writes into a workspace. The caller catches, so `pluginsUp` is a promise that always settles.
	const service = createPluginService();
	pluginsUp = startPlugins({ onRequest: (call) => service.handle(call), closeTimeoutMs: 400 }).catch((error) =>
		console.error(`pi-studio: the plugins could not be started: ${error.message}`),
	);
}
