import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { test } from "node:test";

import { notePdf, figuresOf } from "../server/pdf/card-pdf.ts";
import { chromeOnPath, cropToInk, decodePng } from "../server/pdf/chrome.ts";
import { drawFigures } from "../server/pdf/figures.ts";

/**
 * A picture on a page is the browser's work, so what is checked here is everything around it: the bytes a
 * browser hands back are taken apart into the pixels a page draws, the page says which pictures it drew, and
 * a machine with no browser at all keeps the description the card already carries. The two tests that need a
 * real browser say so and are skipped on a machine without one.
 */

const textOf = (bytes: Buffer) => bytes.toString("latin1");

/** A crc table, which is the one thing a png chunk needs that zlib will not do. */
const CRC = Array.from({ length: 256 }, (_none, index) => {
	let value = index;
	for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
	return value >>> 0;
});

function crc32(bytes: Buffer): number {
	let value = 0xffffffff;
	for (const byte of bytes) value = CRC[(value ^ byte) & 0xff] ^ (value >>> 8);
	return (value ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
	const head = Buffer.alloc(8);
	head.writeUInt32BE(body.length, 0);
	head.write(type, 4, "latin1");
	const tail = Buffer.alloc(4);
	tail.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "latin1"), body])), 0);
	return Buffer.concat([head, body, tail]);
}

/**
 * A png as a browser writes one: eight bits to a channel, one filter byte to a row. `rows` are the filtered
 * bytes themselves, which the tests below work out by hand so that the reader is proved and not mirrored.
 */
function pngOf(width: number, height: number, channels: number, rows: Buffer[]): Buffer {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = channels === 4 ? 6 : 2;
	const raw = Buffer.concat(rows);
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

/** The pixels of one row, three to a pixel, which is the only shape a page draws. */
const row = (...values: number[]) => Array.from(values);

test("a png is taken apart into the pixels a page holds", () => {
	// Two pixels, no filter: the bytes are the pixels.
	const plain = pngOf(2, 1, 3, [Buffer.from([0, ...row(10, 20, 30, 40, 50, 60)])]);
	assert.deepEqual(decodePng(plain), { width: 2, height: 1, rgb: Buffer.from(row(10, 20, 30, 40, 50, 60)) });

	// The same two pixels behind the sub filter, which is each byte less the byte one pixel to its left.
	const sub = pngOf(2, 1, 3, [Buffer.from([1, 10, 20, 30, 30, 30, 30])]);
	assert.deepEqual(decodePng(sub).rgb, Buffer.from(row(10, 20, 30, 40, 50, 60)));

	// Two rows behind the up filter: the second row is the difference from the first, which is nothing here.
	const up = pngOf(2, 2, 3, [
		Buffer.from([0, ...row(10, 20, 30, 40, 50, 60)]),
		Buffer.from([2, ...row(0, 0, 0, 0, 0, 0)]),
	]);
	assert.deepEqual(decodePng(up).rgb, Buffer.from(row(10, 20, 30, 40, 50, 60, 10, 20, 30, 40, 50, 60)));

	// A transparent pixel is paper, so it comes out white rather than black.
	const clear = pngOf(1, 1, 4, [Buffer.from([0, 0, 0, 0, 0])]);
	assert.deepEqual(decodePng(clear).rgb, Buffer.from(row(255, 255, 255)));
});

test("a png this reader cannot take is refused by what it is, not by what it drew", () => {
	assert.throws(() => decodePng(Buffer.from("not a png at all")), /not a png/);
	// Sixteen bits a channel is laid out differently enough that guessing would put the picture out of shape.
	const deep = pngOf(1, 1, 3, [Buffer.from([0, 1, 2, 3, 4, 5, 6])]);
	deep[24] = 16;
	assert.throws(() => decodePng(deep), /cannot take/);
});

test("a picture is cut down to what was drawn on it, and a blank page is not a picture", () => {
	const width = 20;
	const height = 10;
	const rgb = Buffer.alloc(width * height * 3, 255);
	// One dark pixel in the middle of the paper, which is all the ink there is.
	const at = (4 * width + 7) * 3;
	rgb[at] = 0;
	rgb[at + 1] = 0;
	rgb[at + 2] = 0;
	const cut = cropToInk({ width, height, rgb }, 2);
	// Two pixels of paper on every side of the ink, and nothing beyond them.
	assert.equal(cut.width, 5);
	assert.equal(cut.height, 5);
	assert.deepEqual(cut.rgb.subarray(0, 3), Buffer.from([255, 255, 255]));

	assert.throws(() => cropToInk({ width: 4, height: 4, rgb: Buffer.alloc(4 * 4 * 3, 255) }), /drew nothing/);
});

test("the fences a page draws are found in the order the reader meets them", () => {
	const markdown = [
		"```ts",
		"const a = 1;",
		"```",
		"```chart",
		'{"type":"bar"}',
		"```",
		"```mermaid",
		"flowchart TD",
		"```",
		"```svg",
		"<svg></svg>",
		"```",
	].join("\n");
	assert.deepEqual(
		figuresOf(markdown).map((one) => one.lang),
		["chart", "mermaid", "svg"],
	);
	assert.equal(figuresOf("no fences here").length, 0);
});

test("a page with a picture says so, and a page without one carries no picture at all", () => {
	const picture = { width: 3, height: 2, rgb: Buffer.from(Array.from({ length: 3 * 2 * 3 }, (_none, at) => (at * 7) % 256)) };
	const drawn = textOf(notePdf({ title: "a note", markdown: "```chart\n{}\n```", board: "board", at: 0, id: "abcdef012345", pictures: new Map([[0, picture]]) }));
	assert.ok(drawn.includes("/Subtype /Image"), "the picture is an object of its own");
	assert.ok(drawn.includes("/Width 3") && drawn.includes("/Height 2"), "and it keeps its size");
	assert.ok(drawn.includes("/XObject << /Im1"), "the page declares it");
	assert.ok(drawn.includes("/Im1 Do"), "and draws it");

	const described = textOf(notePdf({ title: "a note", markdown: "```chart\n{}\n```", board: "board", at: 0, id: "abcdef012345" }));
	assert.ok(!described.includes("/Subtype /Image"), "a page nobody drew for holds no picture");
	assert.ok(described.includes("(chart:) Tj") || described.includes("(drawn) Tj"), "and keeps the description");
});

test("a machine with no browser asks for no pictures and draws none", async () => {
	const drawn = await drawFigures("```chart\n{\"type\":\"bar\"}\n```\n\n```mermaid\nflowchart TD\n```", "");
	assert.equal(drawn.size, 0);
});

/** The browser this machine has, if it has one: the two tests below are the ones that need it. */
const chrome = chromeOnPath();

test("a browser on this machine draws a chart and a diagram into pictures", { skip: chrome ? false : "no browser installed" }, async () => {
	const drawn = await drawFigures(
		['```chart\n{"type":"bar","data":{"labels":["a","b"],"datasets":[{"data":[1,2]}]}}\n```', "```mermaid\nflowchart TD\n  A --> B\n```"].join("\n\n"),
	);
	assert.equal(drawn.size, 2, "both fences became pictures");
	for (const picture of drawn.values()) {
		assert.ok(picture.width > 100 && picture.height > 80, `a picture worth placing, and this one is ${picture.width}x${picture.height}`);
	}
});

test("a basket case is left as a sentence, even when a browser is there to try", { skip: chrome ? false : "no browser installed" }, async () => {
	assert.equal((await drawFigures("```chart\n{not json}\n```")).size, 0, "a chart the bundle refuses is no picture");
	assert.equal((await drawFigures("```mermaid\nthis is not a diagram at all\n```")).size, 0, "and neither is a diagram");
});
