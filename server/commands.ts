/**
 * What pi offers a thread as slash commands: the extension commands, the prompt templates and the skills
 * a folder carries, asked of a short-lived `pi --mode rpc` rather than of the thread's own child.
 *
 * The child is the wrong process to ask. A thread that is idle has usually had its stdin closed, so
 * nothing can be written to it, and a child is started in the thread's folder with the board's
 * extensions — which is exactly what decides this list, and why the list is asked per folder rather
 * than once for the machine. A probe is one pi, one frame and one answer, and it leaves no session
 * behind: `--no-session` is what keeps an open of the composer out of pi's own history.
 */
import { spawn } from "node:child_process";
import { extensionsFor, piCli } from "./child/argv.ts";
import { lastLine } from "./child/describe.ts";

/** One command pi will run when its name is sent as `/name args`. */
export type SlashCommand = { name: string; description: string; source: string; scope: string };

/**
 * The list and the reason it is empty. `trouble` sits beside the commands for the reason the model
 * catalogue carries one: a probe that failed says nothing about what this folder has, and the menu has
 * to be able to say so instead of drawing a shorter list as if it were the truth.
 */
export type CommandList = { commands: SlashCommand[]; trouble: string };

/** A board as this module needs it: the id its answers are cached under, and what the panel turned off. */
type BoardLike = { id: string; config?: { extensionsOff?: string[] } };

/** A folder that has not changed its commands in ten minutes will not change them in the next ten. */
export const COMMANDS_TTL_MS = 10 * 60_000;

/** A failed probe is trusted for a much shorter while, so the next open of the menu asks pi again. */
export const COMMANDS_RETRY_MS = 30_000;

/** How long a probe may take. A pi that has not answered `get_commands` by then is not going to. */
export const COMMANDS_PROBE_MS = 15_000;

/** The frame id the probe waits for, and the only one it is sent. */
const PROBE_ID = "commands";

/** A board run for months opens a folder per thread; the answers kept are capped so the map cannot grow. */
const MAX_KEYS = 32;

const cache = new Map<string, { list: CommandList; at: number }>();
const probing = new Map<string, Promise<CommandList>>();

/**
 * Every command this folder offers a thread, sorted by source then name, and what pi said instead when
 * the probe failed. `fresh` throws away what is known, which is the menu's own refresh.
 */
export async function commandList(board: BoardLike, workdir: string, fresh = false): Promise<CommandList> {
	const key = `${board.id}\u0000${workdir}`;
	if (fresh) cache.delete(key);
	const held = cache.get(key);
	if (held && Date.now() - held.at < (held.list.trouble ? COMMANDS_RETRY_MS : COMMANDS_TTL_MS)) return held.list;
	// One probe per folder at a time: a composer opened twice, or a refresh pressed while the first
	// answer is on its way, joins the probe that is already running rather than starting a second pi.
	const going = probing.get(key);
	if (going) return going;
	const started = probe(board, workdir).then((list) => {
		probing.delete(key);
		cache.set(key, { list, at: Date.now() });
		// A Map keeps insertion order, so the first key is the oldest answer and the one to drop.
		for (const oldest of cache.keys()) {
			if (cache.size <= MAX_KEYS) break;
			cache.delete(oldest);
		}
		return list;
	});
	probing.set(key, started);
	return started;
}



/**
 * One pi, asked for the commands of a folder, and closed. It is started the way a thread's child is —
 * the board's extensions, `-ne` so discovery adds nothing else, the folder as its cwd — with the one
 * difference that matters: no `PI_STUDIO_TOKEN`, so it reaches none of the board's routes and the
 * bridge it would otherwise be given has nothing to answer for.
 */
function probe(board: BoardLike, workdir: string): Promise<CommandList> {
	return new Promise((done) => {
		const cli = piCli();
		const extensions: string[] = extensionsFor(board);
		const argv = [...cli.args, "--mode", "rpc", "--no-session", "-ne", ...extensions.flatMap((path) => ["-e", path])];
		const env = { ...process.env };
		delete env.PI_STUDIO_TOKEN;
		const child = spawn(cli.command, argv, { cwd: workdir, stdio: ["pipe", "pipe", "pipe"], env });
		let held = "";
		let stderr = "";
		let settled = false;
		const settle = (list: CommandList) => {
			if (settled) return;
			settled = true;
			clearTimeout(clock);
			// The probe is spent, so the process goes. `--no-session` keeps nothing of it either way.
			try {
				child.stdin.end();
			} catch {
				// Already gone, which is what this wanted.
			}
			const leave = setTimeout(() => child.kill(), 2000);
			leave.unref?.();
			done(list);
		};
		const clock = setTimeout(() => {
			settle({ commands: [], trouble: `pi did not answer get_commands in ${Math.round(COMMANDS_PROBE_MS / 1000)}s` });
			child.kill();
		}, COMMANDS_PROBE_MS);
		clock.unref?.();
		child.stdout.on("data", (chunk) => {
			held += String(chunk);
			const lines = held.split("\n");
			held = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim()) continue;
				let frame: { id?: string; success?: boolean; error?: unknown; data?: { commands?: unknown } };
				try {
					frame = JSON.parse(line);
				} catch {
					continue;
				}
				if (frame.id !== PROBE_ID) continue;
				if (frame.success === false) {
					settle({ commands: [], trouble: lastLine(frame.error) || "pi refused get_commands" });
					return;
				}
				settle({ commands: readCommands(frame.data?.commands), trouble: "" });
				return;
			}
		});
		child.stderr.on("data", (chunk) => {
			stderr = `${stderr}${String(chunk)}`.slice(-1000);
		});
		child.on("error", (error) => settle({ commands: [], trouble: `pi could not be started: ${error.message}` }));
		child.on("close", (code, signal) => {
			// An exit before the answer is the whole explanation, and the last line of stderr is usually it.
			settle({ commands: [], trouble: lastLine(stderr) || `pi exited before it answered (${signal ?? code})` });
		});
		child.stdin.on("error", () => {
			// The exit above says what happened; a broken pipe here is the same event from this side.
		});
		child.stdin.write(`${JSON.stringify({ id: PROBE_ID, type: "get_commands" })}\n`);
	});
}



/** pi's own answer, kept to the four fields the menu draws, in the order the menu reads them. */
function readCommands(held: unknown): SlashCommand[] {
	if (!Array.isArray(held)) return [];
	const commands = held
		.filter((one: { name?: unknown } | null) => one && typeof one.name === "string" && one.name)
		.map((one: any) => ({
			name: String(one.name),
			description: typeof one.description === "string" ? one.description : "",
			source: typeof one.source === "string" ? one.source : "extension",
			// Where pi found it: `user`, `project` or `temporary`. Empty when pi did not say.
			scope: typeof one.sourceInfo?.scope === "string" ? one.sourceInfo.scope : "",
		}));
	return commands.sort((left, right) => left.source.localeCompare(right.source) || left.name.localeCompare(right.name));
}
