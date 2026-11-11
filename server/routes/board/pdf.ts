/**
 * A note as a PDF, on disk, with the file browser opened on it.
 *
 * The daemon writes the file itself, so the feature needs nothing installed: the page is laid out by
 * `server/pdf/`, the file lands in the machine's temp folder under a name made from the card's title, and
 * the press ends with the file picked out in the human's own folder browser. Nothing is sent to a server
 * and no browser is asked to print: a card leaves the studio the way any other file does.
 */
import { execFile, spawn } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Readable } from "node:stream";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { answer, fail, readJson } from "../../http.ts";
import { notePdf } from "../../pdf/card-pdf.ts";
import { drawFigures } from "../../pdf/figures.ts";
import { programOnPath } from "../../paths.ts";

/** The folder the exports land in, so a press does not scatter files through the temp area. */
const FOLDER = "pi-studio";

/**
 * The folder browsers worth asking, and the order they are asked in when the desktop names none of them.
 * Not every one of them takes the same flag, and a version can lose it, so each is asked once whether it
 * offers `--select` and only the ones that do are handed the file.
 */
const BROWSERS = ["nautilus", "nemo", "caja", "dolphin", "thunar"];

/** A program that came back to us saying an option, kept so the question is asked once per daemon. */
const OFFERS = new Map<string, boolean>();

/** The name a card's file is given: its title, in the shape a file system takes. */
export function pdfName(title: string, id: string): string {
	const slug = String(title ?? "")
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48)
		.replace(/-+$/, "");
	return `${slug || "note"}-${String(id ?? "").slice(0, 6)}.pdf`;
}

/**
 * Start a program and say whether it went. A file browser stays open long after it has taken the file, so
 * it is detached and let go of at once: the daemon has nothing to say to it, and a closed tab must not
 * leave a zombie behind. A program that is not there answers `false` rather than throwing, which is what
 * lets the next candidate be tried.
 */
function launch(program: string, args: string[]): Promise<boolean> {
	if (!program) return Promise.resolve(false);
	return new Promise((done) => {
		const child = spawn(program, args, { detached: true, stdio: "ignore" });
		child.once("error", () => done(false));
		child.once("spawn", () => {
			child.removeAllListeners("error");
			child.unref();
			done(true);
		});
	});
}

/** What a program says about itself, which is the only promise there is that it takes a flag. */
function helpOf(program: string): Promise<string> {
	return new Promise((done) => {
		execFile(program, ["--help"], { timeout: 2000 }, (error, stdout, stderr) => done(error && !stdout && !stderr ? "" : `${stdout ?? ""}${stderr ?? ""}`));
	});
}

/** Whether a browser can be handed a file to pick out. Asked once, then remembered for the daemon's life. */
async function selects(program: string): Promise<boolean> {
	const held = OFFERS.get(program);
	if (held !== undefined) return held;
	const can = /--select\b/.test(await helpOf(program));
	OFFERS.set(program, can);
	return can;
}

/** The folder browser this desktop opens folders with, as `xdg-mime` reports it: `nemo.desktop` → `nemo`. */
function defaultBrowser(): Promise<string> {
	return new Promise((done) => {
		execFile("xdg-mime", ["query", "default", "inode/directory"], { timeout: 1500 }, (error, stdout) => {
			const named = String(stdout ?? "").trim().replace(/\.desktop$/, "");
			done(error ? "" : named);
		});
	});
}

/** What became of the press: the program that answered, and whether it was handed the file or its folder. */
export type Opened = { program: string; selected: boolean };

/**
 * Open the human's file browser on a file they can see picked out. Which browser is theirs is the desktop's
 * business, so it is asked first; a browser that offers `--select` is handed the file, and one that does not
 * opens the folder the file is in. Nothing at all is opened on a machine with no browser, and the board
 * says the file's name instead.
 */
export async function revealFile(file: string, find: (name: string) => string = programOnPath): Promise<Opened> {
	const wanted = await defaultBrowser();
	const order = [...new Set([wanted, ...BROWSERS].filter(Boolean))];
	for (const name of order) {
		const program = find(name);
		if (!program || !(await selects(program))) continue;
		if (await launch(program, ["--select", file])) return { program: name, selected: true };
	}
	const program = find(wanted) || find("xdg-open");
	if (await launch(program, [dirname(file)])) return { program: wanted || "xdg-open", selected: false };
	return { program: "", selected: false };
}

/**
 * The press on a note's pdf button: read the card, draw whatever pictures its browser can, write the page into
 * the temp folder, and open the file browser on it. Only a note answers: a source card holds a file, and a
 * thread is not a document.
 */
/** A card as this route reads it: the words, the name, and when it was written. */
type Held = { id: string; type: string; title?: string; markdown?: string; at?: number };

/** The handler only reads a body and gives one answer, which is what a test can stand in for. */
type Asked = IncomingMessage | Readable;
type Answered = ServerResponse | { writeHead(code: number): void; end(chunk?: unknown): void };

export async function onCardPdf(req: Asked, res: Answered, board: { name?: string; cards: Map<string, Held> }) {
	return cardPdf(req, res, board, revealFile);
}

/**
 * The same press with the browser it opens named from outside, which is what lets a test prove the file is
 * written without a window appearing on somebody's desktop. It is separate from the route because the
 * dispatch hands every handler the caller as its fourth argument.
 */
export async function cardPdf(
	req: Asked,
	res: Answered,
	board: { name?: string; cards: Map<string, Held> },
	reveal: (file: string) => Promise<Opened>,
) {
	const body = await readJson(req, res);
	if (!body) return;
	const held = board.cards.get(String(body.cardId ?? "")) as Held | undefined;
	if (!held) return void fail(res, 409, "no such card");
	if (held.type !== "note") return void fail(res, 409, "only a note becomes a pdf");
	const file = join(tmpdir(), FOLDER, pdfName(held.title || "note", held.id));
	const markdown = String(held.markdown ?? "");
	// The one decision a page makes about its pictures: a browser on this machine draws the charts and
	// diagrams, and a machine without one keeps the description each of them already carries.
	const pictures = await drawFigures(markdown);
	try {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(
			file,
			notePdf({
				title: held.title || "note",
				markdown,
				board: String(board.name ?? ""),
				at: Number(held.at) || Date.now(),
				id: held.id,
				pictures,
			}),
		);
	} catch (error) {
		return void fail(res, 500, `could not write the pdf: ${error instanceof Error ? error.message : String(error)}`);
	}
	const opened = await reveal(file);
	answer(res, 200, { file, opener: opened.program, selected: opened.selected });
}
