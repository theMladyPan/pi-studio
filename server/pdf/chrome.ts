/**
 * The pictures of a page, drawn by whatever browser this machine already has.
 *
 * The daemon draws text itself and needs nothing to do it, but a chart and a diagram are drawn by the board
 * with two bundles of its own, and writing a second renderer for them would be a second lie about how they
 * look. So the one question the pdf asks the machine is whether a browser is installed: when one is, the
 * fences are handed to it and its pixels come back; when none is, the page keeps the description it would
 * have had anyway. Nothing is downloaded and nothing is installed either way.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { inflateSync } from "node:zlib";

import { programOnPath } from "../paths.ts";
import type { Picture } from "./write.ts";

/** The browsers that can draw a page headless, in the order a desktop is likely to have them. */
const BROWSERS = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"];

/** Twice the screen's pixels, so a picture stays sharp on paper without the file growing to a photograph. */
export const SCALE = 2;

/** How long a fence may take before the description is kept instead: a card cannot wait on a browser for long. */
const DEADLINE = 12_000;

let found: string | undefined;

/**
 * The browser this machine has, or "" when it has none. Asked once and remembered, because it is the one
 * decision a page makes about pictures and it does not change while the daemon runs.
 */
export function chromeOnPath(find: (name: string) => string = programOnPath): string {
	if (found === undefined) found = BROWSERS.map((name) => find(name)).find(Boolean) ?? "";
	return found;
}

/** The eight bytes every png opens with, so a file that is not one is refused by name and not by accident. */
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The predictor a png row is written with, worked out against the row above it. */
function paeth(left: number, above: number, corner: number): number {
	const guess = left + above - corner;
	const a = Math.abs(guess - left);
	const b = Math.abs(guess - above);
	const c = Math.abs(guess - corner);
	return a <= b && a <= c ? left : b <= c ? above : corner;
}

/**
 * A png as the pixels a page can hold. A browser writes eight-bit RGBA rows behind a filter byte, which is
 * not the shape a PDF wants, so the rows are unfiltered, the transparent ones are laid over white, and the
 * result is a run of RGB the writer deflates itself.
 */
export function decodePng(bytes: Buffer): Picture {
	if (bytes.length < 8 || !bytes.subarray(0, 8).equals(SIGNATURE)) throw new Error("that is not a png");
	let width = 0;
	let height = 0;
	let depth = 0;
	let kind = 0;
	let interlace = 0;
	const runs: Buffer[] = [];
	let at = 8;
	while (at + 8 <= bytes.length) {
		const length = bytes.readUInt32BE(at);
		const type = bytes.toString("latin1", at + 4, at + 8);
		const body = bytes.subarray(at + 8, at + 8 + length);
		if (type === "IHDR") {
			width = body.readUInt32BE(0);
			height = body.readUInt32BE(4);
			depth = body[8];
			kind = body[9];
			interlace = body[12];
		} else if (type === "IDAT") runs.push(body);
		else if (type === "IEND") break;
		at += 12 + length;
	}
	if (depth !== 8 || interlace !== 0 || (kind !== 2 && kind !== 6)) {
		throw new Error(`a png this reader cannot take: ${depth} bits, colour type ${kind}`);
	}
	if (!width || !height) throw new Error("a png with no size");
	const channels = kind === 6 ? 4 : 3;
	const stride = width * channels;
	const raw = inflateSync(Buffer.concat(runs));
	const rgb = Buffer.alloc(width * height * 3);
	let above = Buffer.alloc(stride);
	let cursor = 0;
	for (let row = 0; row < height; row += 1) {
		const filter = raw[cursor];
		const line = Buffer.from(raw.subarray(cursor + 1, cursor + 1 + stride));
		cursor += stride + 1;
		for (let index = 0; index < stride; index += 1) {
			const left = index >= channels ? line[index - channels] : 0;
			const corner = index >= channels ? above[index - channels] : 0;
			const up = above[index];
			if (filter === 1) line[index] = (line[index] + left) & 0xff;
			else if (filter === 2) line[index] = (line[index] + up) & 0xff;
			else if (filter === 3) line[index] = (line[index] + ((left + up) >> 1)) & 0xff;
			else if (filter === 4) line[index] = (line[index] + paeth(left, up, corner)) & 0xff;
			else if (filter !== 0) throw new Error(`a png row this reader cannot take: filter ${filter}`);
		}
		for (let column = 0; column < width; column += 1) {
			const from = column * channels;
			const to = (row * width + column) * 3;
			const alpha = channels === 4 ? line[from + 3] : 255;
			// A browser writes its empty space as transparent rather than white, so the page is white here.
			for (let channel = 0; channel < 3; channel += 1) {
				rgb[to + channel] = alpha === 255 ? line[from + channel] : Math.round((line[from + channel] * alpha + 255 * (255 - alpha)) / 255);
			}
		}
		above = line;
	}
	return { width, height, rgb };
}

/**
 * The picture trimmed to what was drawn on it, with a small white edge. A page is asked for at a size that
 * holds the widest diagram or chart, so most of it comes back as empty white; a page in a pdf is the drawing
 * and nothing else. A page with nothing on it throws: a browser that drew nothing — a chart whose config the
 * bundle refused, a diagram with a typo in it — has not made a picture, and the page keeps the description.
 */
export function cropToInk(picture: Picture, margin = 6, shade = 3): Picture {
	const { width, height, rgb } = picture;
	let left = width;
	let right = -1;
	let top = height;
	let bottom = -1;
	for (let row = 0; row < height; row += 1) {
		for (let column = 0; column < width; column += 1) {
			const at = (row * width + column) * 3;
			if (rgb[at] > 255 - shade && rgb[at + 1] > 255 - shade && rgb[at + 2] > 255 - shade) continue;
			if (column < left) left = column;
			if (column > right) right = column;
			if (row < top) top = row;
			if (row > bottom) bottom = row;
		}
	}
	if (right < left || bottom < top) throw new Error("the browser drew nothing");
	left = Math.max(0, left - margin);
	top = Math.max(0, top - margin);
	right = Math.min(width - 1, right + margin);
	bottom = Math.min(height - 1, bottom + margin);
	const wide = right - left + 1;
	const tall = bottom - top + 1;
	const cut = Buffer.alloc(wide * tall * 3);
	for (let row = 0; row < tall; row += 1) {
		rgb.copy(cut, row * wide * 3, ((top + row) * width + left) * 3, ((top + row) * width + left + wide) * 3);
	}
	return { width: wide, height: tall, rgb: cut };
}

/** Run a program to its end, or kill it at the deadline: a browser that hangs must not hang a card. */
function run(program: string, args: string[], deadline: number): Promise<number> {
	return new Promise((done) => {
		const child = spawn(program, args, { stdio: "ignore" });
		const timer = setTimeout(() => child.kill("SIGKILL"), deadline);
		child.once("error", () => {
			clearTimeout(timer);
			done(-1);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			done(code ?? -1);
		});
	});
}

/**
 * A page of html as pixels. The page is written into a folder of its own and both are thrown away after:
 * what comes back is the drawing alone, at twice the size it was laid out in.
 */
export async function drawPage(html: string, viewport: { width: number; height: number }, chrome = chromeOnPath()): Promise<Picture> {
	if (!chrome) throw new Error("this machine has no browser to draw with");
	const folder = mkdtempSync(join(tmpdir(), "pi-studio-draw-"));
	try {
		const page = join(folder, "draw.html");
		const shot = join(folder, "draw.png");
		writeFileSync(page, html);
		const args = [
			"--headless=new",
			"--disable-gpu",
			"--hide-scrollbars",
			"--mute-audio",
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-extensions",
			"--disable-background-networking",
			"--disable-sync",
			// A profile of its own, so a browser the human is using is neither found nor disturbed.
			`--user-data-dir=${join(folder, "profile")}`,
			`--force-device-scale-factor=${SCALE}`,
			`--window-size=${viewport.width},${viewport.height}`,
			// The page draws itself once the bundle it loads has run, which is what the budget waits for. It
			// has nothing open on the network, so the clock runs to the end of the budget and the shot is taken.
			"--virtual-time-budget=4000",
			`--screenshot=${shot}`,
			`file://${page}`,
		];
		// A browser started by root refuses to sandbox itself, which is the one case worth saying so.
		if (typeof process.getuid === "function" && process.getuid() === 0) args.unshift("--no-sandbox");
		const code = await run(chrome, args, DEADLINE);
		if (code !== 0) throw new Error(`the browser exited with ${code}`);
		return cropToInk(decodePng(readFileSync(shot)));
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
}
