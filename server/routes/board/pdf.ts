/**
 * A note as a PDF, handed to the browser that asked for it.
 *
 * The daemon builds the whole page in memory — its markdown laid out by `server/pdf/`, and the charts and
 * diagrams drawn first by whatever browser this machine has — and answers with the file itself. The tab that
 * pressed the button saves it the way it saves any other file, into the folder that browser is set to use, so
 * there is no folder to open, no program to start, and no path on this machine the daemon has to keep. What
 * is left is one decision, made per fence: a browser is installed, so its picture goes on the page, or it is
 * not, and the description the card already carried stands in.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Readable } from "node:stream";

import { fail, readJson } from "../../http.ts";
import { notePdf } from "../../pdf/card-pdf.ts";
import { drawFigures } from "../../pdf/figures.ts";

/** A card as this route reads it: the words, the name, and when it was written. */
type Held = { id: string; type: string; title?: string; markdown?: string; at?: number };

/** The handler only reads a body and gives one answer, which is what a test can stand in for. */
type Asked = IncomingMessage | Readable;
type Answered = ServerResponse | { writeHead(status: number, headers: Record<string, string>): void; end(chunk?: unknown): void };

/** A board as far as this route cares: its name on the page, and the cards it holds by id. */
type Board = { name?: string; cards: Map<string, Held> };

/**
 * The name the file is saved under: the card's title, in the shape a file system takes. It is ASCII by the
 * time it leaves here — lowercase letters, digits and single dashes — so it can go into the one header a
 * browser reads a download's name from without quoting anything. A letter with an accent is folded to the
 * letter itself first, so a title in a language that has them keeps its words instead of losing a letter:
 * `Przegląd` is `przeglad` and not `przegla-d`.
 */
export function pdfName(title: string, id: string): string {
	const slug = String(title ?? "")
		.toLowerCase()
		.normalize("NFKD")
		.replace(/\p{M}+/gu, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48)
		.replace(/-+$/, "");
	return `${slug || "note"}-${String(id ?? "").slice(0, 6)}.pdf`;
}

/**
 * The press on a note's pdf button: read the card, draw whatever pictures its browser can, and answer with the
 * page. Only a note answers: a source card holds a file, and a thread is not a document.
 */
export async function onCardPdf(req: Asked, res: Answered, board: Board) {
	const body = await readJson(req, res);
	if (!body) return;
	const held = board.cards.get(String(body.cardId ?? ""));
	if (!held) return void fail(res, 409, "no such card");
	if (held.type !== "note") return void fail(res, 409, "only a note becomes a pdf");
	const markdown = String(held.markdown ?? "");
	const pictures = await drawFigures(markdown);
	let pdf: Buffer;
	try {
		pdf = notePdf({
			title: held.title || "note",
			markdown,
			board: String(board.name ?? ""),
			at: Number(held.at) || Date.now(),
			id: held.id,
			pictures,
		});
	} catch (error) {
		return void fail(res, 500, `could not make the pdf: ${error instanceof Error ? error.message : String(error)}`);
	}
	// `attachment` is what makes the tab save the answer instead of drawing it: the browser's own download,
	// with its own folder, its own progress and its own list of what it has taken.
	res.writeHead(200, {
		"Content-Type": "application/pdf",
		"Content-Disposition": `attachment; filename="${pdfName(held.title || "note", held.id)}"`,
		"Content-Length": String(pdf.length),
		"Cache-Control": "no-store",
	});
	res.end(pdf);
}
