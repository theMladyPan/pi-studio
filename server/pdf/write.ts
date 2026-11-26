/**
 * A PDF written by hand: the handful of objects the format asks for, and a stream of drawing operators,
 * with the fonts every reader already carries, plus one subset font carried inside the file. Nothing is
 * installed, nothing is called out to, and the text stays text — selectable, searchable and sharp at any
 * zoom — because it is never turned into a picture of itself.
 *
 * The standard fonts hold Latin text only. Polish and Czech letters beyond the Latin set (ą, ł, č, ř …)
 * come from the one embedded subset face in `extended-font.ts` (DejaVu Sans, U+0100-U+024F): runs of
 * those letters are drawn with it as a composite font, with a ToUnicode map so the words stay copyable.
 * A card also writes arrows, ticks and a tree now and then; the characters neither font has a glyph for
 * are translated on the way out (`encode`), and a card reads as the nearest thing the page can say
 * rather than as a row of empty boxes.
 */

import { deflateSync } from "node:zlib";

import { EXTENDED_FONT_B64 } from "./extended-font.ts";

/** A4 portrait, the page a note is read on. */
export const PAGE_WIDTH = 595.28;
export const PAGE_HEIGHT = 841.89;

export type Face = "regular" | "bold" | "italic" | "boldItalic" | "mono";

/** The five faces this writer can draw with. Every PDF reader has them without being asked. */
const FACE_NAME: Record<Face, string> = {
	regular: "Helvetica",
	bold: "Helvetica-Bold",
	italic: "Helvetica-Oblique",
	boldItalic: "Helvetica-BoldOblique",
	mono: "Courier",
};

const FACES = Object.keys(FACE_NAME) as Face[];

/**
 * Helvetica's widths, in thousandths of the size, from the space (32) to the tilde (126). Taken from the
 * font's own metrics: a guessed number here would put the last word of a line past the margin.
 */
const HELVETICA = [
	278, 278, 355, 556, 556, 889, 667, 191, 333, 333, // space ! " # $ % & ' ( )
	389, 584, 278, 333, 278, 278, 556, 556, 556, 556, // * + , - . / 0 1 2 3
	556, 556, 556, 556, 556, 556, 278, 278, 584, 584, // 4 5 6 7 8 9 : ; < =
	584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, // > ? @ A B C D E F G
	722, 278, 500, 667, 556, 833, 722, 778, 667, 778, // H I J K L M N O P Q
	722, 667, 611, 722, 667, 944, 667, 667, 611, 278, // R S T U V W X Y Z [
	278, 278, 469, 556, 333, 556, 556, 500, 556, 556, // \ ] ^ _ ` a b c d e
	278, 556, 556, 222, 222, 500, 222, 833, 556, 556, // f g h i j k l m n o
	556, 556, 333, 500, 278, 556, 500, 722, 500, 500, // p q r s t u v w x y
	500, 334, 260, 334, 584, // z { | } ~
];

/** Helvetica-Bold's widths, on the same run of characters. */
const HELVETICA_BOLD = [
	278, 333, 474, 556, 556, 889, 722, 238, 333, 333, // space ! " # $ % & ' ( )
	389, 584, 278, 333, 278, 278, 556, 556, 556, 556, // * + , - . / 0 1 2 3
	556, 556, 556, 556, 556, 556, 333, 333, 584, 584, // 4 5 6 7 8 9 : ; < =
	584, 611, 975, 722, 722, 722, 722, 667, 611, 778, // > ? @ A B C D E F G
	722, 278, 556, 722, 611, 833, 722, 778, 667, 778, // H I J K L M N O P Q
	722, 667, 611, 722, 667, 944, 667, 667, 611, 333, // R S T U V W X Y Z [
	278, 333, 584, 556, 333, 556, 611, 556, 611, 556, // \ ] ^ _ ` a b c d e
	333, 611, 611, 278, 278, 556, 278, 889, 611, 611, // f g h i j k l m n o
	611, 611, 389, 556, 333, 611, 556, 778, 556, 556, // p q r s t u v w x y
	500, 389, 280, 389, 584, // z { | } ~
];

/** The widths of the few accented and typographic letters this writer can reach beyond ASCII. */
const HIGH_WIDTH: Record<number, number> = {
	0x85: 1000, // ellipsis
	0x91: 222, // ' 
	0x92: 222, // '
	0x93: 333, // "
	0x94: 333, // "
	0x95: 350, // bullet
	0x96: 556, // en dash
	0x97: 1000, // em dash
	0xa0: 278, // nbsp
	0xa9: 737, // ©
	0xae: 737, // ®
	0xb0: 400, // °
	0xb1: 584, // ±
	0xb7: 278, // middle dot
	0xd7: 584, // ×
	0xf7: 584, // ÷
};

/**
 * What Windows' Latin set holds, by character: the byte a reader shows it as. The 0x80 block is the part
 * that no Latin-1 table has, and it is where the curly quotes and the dashes live.
 */
const WIN_ANSI: Record<string, number> = {
	"\u20ac": 0x80,
	"\u201a": 0x82,
	"\u0192": 0x83,
	"\u201e": 0x84,
	"\u2026": 0x85,
	"\u2020": 0x86,
	"\u2021": 0x87,
	"\u02c6": 0x88,
	"\u2030": 0x89,
	"\u0160": 0x8a,
	"\u2039": 0x8b,
	"\u0152": 0x8c,
	"\u017d": 0x8e,
	"\u2018": 0x91,
	"\u2019": 0x92,
	"\u201c": 0x93,
	"\u201d": 0x94,
	"\u2022": 0x95,
	"\u2013": 0x96,
	"\u2014": 0x97,
	"\u02dc": 0x98,
	"\u2122": 0x99,
	"\u0161": 0x9a,
	"\u203a": 0x9b,
	"\u0153": 0x9c,
	"\u017e": 0x9e,
	"\u0178": 0x9f,
};

/**
 * What the font says for the symbols it has no glyph for. A card draws arrows, ticks, and a tree with
 * box characters; the page says the same thing in the characters it does hold, so nothing is lost and
 * nothing shows as a box. A character in neither table is dropped: a symbol nobody can render is noise.
 */
const STAND_IN: Record<string, string> = {
	"\u2192": "->",
	"\u2190": "<-",
	"\u2194": "<->",
	"\u21d2": "=>",
	"\u21d0": "<=",
	"\u2264": "<=",
	"\u2265": ">=",
	"\u2260": "!=",
	"\u2248": "~",
	"\u2261": "=",
	"\u221a": "sqrt",
	"\u221e": "inf",
	"\u2212": "-",
	"\u00a0": " ",
	"\u2713": "[x]",
	"\u2714": "[x]",
	"\u2611": "[x]",
	"\u2610": "[ ]",
	"\u2612": "[x]",
	"\u2717": "x",
	"\u2718": "x",
	"\u25b8": ">",
	"\u25b6": ">",
	"\u25c0": "<",
	"\u25cf": "\u2022",
	"\u25cb": "o",
	"\u2023": ">",
	"\u00b6": "\u00a7",
	"\u2500": "-",
	"\u2501": "-",
	"\u2502": "|",
	"\u2503": "|",
	"\u2550": "=",
	"\u2551": "|",
	"\u251c": "|",
	"\u2524": "|",
	"\u252c": "+",
	"\u2534": "+",
	"\u253c": "+",
	"\u250c": "+",
	"\u2510": "+",
	"\u2514": "+",
	"\u2518": "+",
	"\u2026": "...",
};

/**
 * Letters the standard fonts have no byte for, said as the letter they are built on when the embedded
 * face has no glyph either. A title in Polish or Czech is made of these, and dropping them turns
 * `Przegląd` into `Przegld`: a word with a letter missing reads as a typo, where the same word with the
 * accent folded away reads as itself.
 */
const BASE_LETTER: Record<string, string> = {
	"\u0111": "d", // đ
	"\u0110": "D", // Đ
	"\u0142": "l", // ł
	"\u0141": "L", // Ł
	"\u0127": "h", // ħ
	"\u0167": "t", // ŧ
	"\u0131": "i", // ı
	"\u0138": "k", // ĸ
	"\u014b": "n", // ŋ
	"\u0153": "oe", // œ
	"\u0152": "OE", // Œ
	"\u0133": "ij", // ĳ
	"\u0132": "IJ", // Ĳ
};

/**
 * A character the font cannot draw, said as the nearest thing it can. A letter that sits inside the Latin
 * set keeps its own byte; a letter built on another — but outside the embedded face's range, so `pack`
 * never handed it there — is folded to the letter its accent is drawn on; anything else with no letter
 * of its own is dropped rather than guessed.
 */
function fallback(char: string): string {
	const code = char.codePointAt(0) ?? 0;
	if (code >= 0xa1 && code <= 0xff) return char;
	if (code === 0x09 || code === 0x0a) return " ";
	const built = BASE_LETTER[char];
	if (built) return built;
	// A combining mark on its own says nothing the page can draw, so it goes before the letter is read.
	const base = char.normalize("NFD").replace(/\p{M}+/gu, "");
	if (base && base !== char && /^[\x20-\x7e]*$/.test(base)) return base;
	return "";
}

/**
 * Text as the bytes a standard font draws. Every character either has a place in the Latin set or is
 * said in characters that do, so the result is a string whose code units are all under 256 and can be
 * written into the page as it stands.
 */
export function encode(value: string): string {
	let out = "";
	for (const char of String(value ?? "")) {
		if (char === "\n" || char === "\t" || char === "\r") {
			out += " ";
			continue;
		}
		const code = char.codePointAt(0) ?? 0;
		if (code < 0x20) continue;
		if (code < 0x7f) {
			out += char;
			continue;
		}
		const mapped = WIN_ANSI[char];
		if (mapped) {
			out += String.fromCharCode(mapped);
			continue;
		}
		const stand = STAND_IN[char];
		if (stand) {
			out += encode(stand);
			continue;
		}
		out += fallback(char);
	}
	return out;
}

/** How far a string reaches on the page, in points, at a size. */
export function measure(face: Face, size: number, value: string): number {
	let width = 0;
	for (const atom of atomsOf(value)) {
		width += atom.kind === "ext" ? extWidth(atom.gid, size) : stdWidth(face, atom.text, size);
	}
	return width;
}

/** How far a run of standard bytes reaches, in points, at a size. */
function stdWidth(face: Face, text: string, size: number): number {
	if (face === "mono") return text.length * size * 0.6;
	const table = face === "regular" || face === "italic" ? HELVETICA : HELVETICA_BOLD;
	let width = 0;
	for (let index = 0; index < text.length; index += 1) {
		const code = text.charCodeAt(index);
		if (code >= 32 && code <= 126) width += table[code - 32];
		else width += HIGH_WIDTH[code] ?? 556;
	}
	return (width / 1000) * size;
}

/** How far one extended glyph reaches, in points, at a size. */
function extWidth(gid: number, size: number): number {
	return (extFont().widths1000[gid] ?? 1000) * (size / 1000);
}

/** One character as the page draws it: standard bytes, or a glyph of the embedded face. */
type Atom = { kind: "std"; text: string } | { kind: "ext"; gid: number };

/**
 * One string as runs the compositor can draw in order: standard bytes as the writer has always drawn them,
 * and letters the standard fonts have no byte for (Polish and Czech Latin Extended) as glyphs of the
 * embedded face. Characters neither face holds are said the old way, by `encode`'s own fallback.
 */
function atomsOf(value: string): Atom[] {
	const atoms: Atom[] = [];
	for (const char of String(value ?? "")) {
		if (char === "\n" || char === "\t" || char === "\r") {
			atoms.push({ kind: "std", text: " " });
			continue;
		}
		const code = char.codePointAt(0) ?? 0;
		if (code < 0x20) continue;
		if (code < 0x7f) {
			atoms.push({ kind: "std", text: char });
			continue;
		}
		const mapped = WIN_ANSI[char];
		if (mapped !== undefined) {
			atoms.push({ kind: "std", text: String.fromCharCode(mapped) });
			continue;
		}
		const stand = STAND_IN[char];
		if (stand !== undefined) {
			const said = encode(stand);
			if (said) atoms.push({ kind: "std", text: said });
			continue;
		}
		const gid = extFont().glyphOf(code);
		if (gid !== undefined) {
			atoms.push({ kind: "ext", gid });
			continue;
		}
		const said = fallback(char);
		if (said) atoms.push({ kind: "std", text: said });
	}
	return atoms;
}

/** One string as runs of one font each, ready to draw: the compositor never mixes faces inside a run. */
function textRuns(value: string): Array<{ ext: boolean; std: string; gids: number[] }> {
	const runs: Array<{ ext: boolean; std: string; gids: number[] }> = [];
	for (const atom of atomsOf(value)) {
		const last = runs[runs.length - 1];
		if (last && last.ext === (atom.kind === "ext")) {
			if (atom.kind === "ext") last.gids.push(atom.gid);
			else last.std += atom.text;
			continue;
		}
		runs.push(atom.kind === "ext" ? { ext: true, std: "", gids: [atom.gid] } : { ext: false, std: atom.text, gids: [] });
	}
	return runs;
}

// ---------------------------------------------------------------- embedded face

/** The subset face decoded, read and measured once: what the compositor needs, then what the page needs. */
type ExtFace = {
	buffer: Buffer;
	unitsPerEm: number;
	ascent: number;
	descent: number;
	bbox: [number, number, number, number];
	capHeight: number;
	widths1000: number[];
	cmap: Map<number, number>;
	glyphOf(code: number): number | undefined;
};

let extOnce: ExtFace | null = null;

/** The embedded face, read once. A broken file throws here, and the route answers 500 with its reason. */
function extFont(): ExtFace {
	if (extOnce) return extOnce;
	const buffer = Buffer.from(EXTENDED_FONT_B64, "base64");
	const u16 = (off: number) => buffer.readUInt16BE(off);
	const i16 = (off: number) => buffer.readInt16BE(off);
	const u32 = (off: number) => buffer.readUInt32BE(off);
	const numTables = u16(4);
	const tables = new Map<string, { offset: number; length: number }>();
	for (let index = 0; index < numTables; index += 1) {
		const at = 12 + index * 16;
		tables.set(buffer.toString("latin1", at, at + 4), { offset: u32(at + 8), length: u32(at + 12) });
	}
	const table = (tag: string) => {
		const found = tables.get(tag);
		if (!found) throw new Error(`extended font: no ${tag} table`);
		return found;
	};
	const head = table("head");
	const maxp = table("maxp");
	const hhea = table("hhea");
	const hmtx = table("hmtx");
	const unitsPerEm = u16(head.offset + 18);
	const numGlyphs = u16(maxp.offset + 4);
	const numHorMetrics = u16(hhea.offset + 34);
	const widths1000: number[] = [];
	for (let gid = 0; gid < numGlyphs; gid += 1) {
		const index = Math.min(gid, numHorMetrics - 1);
		widths1000.push(Math.round((u16(hmtx.offset + index * 4) * 1000) / unitsPerEm));
	}
	// The cmap, read as the fonttools wrote it: many subtables, one answer to "which glyph is U+X".
	// Format 12 is one group per range; format 4 is segments with deltas and range offsets.
	const cmap = table("cmap");
	const cmapMap = new Map<number, number>();
	const numSubtables = u16(cmap.offset + 2);
	const subtables: { format: number; at: number }[] = [];
	for (let index = 0; index < numSubtables; index += 1) {
		const at = cmap.offset + 4 + index * 8;
		const sub = cmap.offset + u32(at + 4);
		subtangles(subtables, sub);
	}
	function subtangles(into: { format: number; at: number }[], at: number) {
		into.push({ format: u16(at), at });
	}
	const twelve = subtables.find((sub) => sub.format === 12);
	if (twelve) {
		const { at } = twelve;
		const groups = u32(at + 12);
		for (let index = 0; index < groups; index += 1) {
			const group = at + 16 + index * 12;
			const start = u32(group);
			const end = u32(group + 4);
			const first = u32(group + 8);
			for (let code = start; code <= end; code += 1) cmapMap.set(code, first + (code - start));
		}
	} else {
		const four = subtables.find((sub) => sub.format === 4);
		if (!four) throw new Error("extended font: cmap has no format 12 or 4 subtable");
		const { at } = four;
		const segCount = u16(at + 6) / 2;
		const endOff = at + 14;
		const startOff = endOff + segCount * 2 + 2;
		const deltaOff = startOff + segCount * 2;
		const rangeOff = deltaOff + segCount * 2;
		for (let segment = 0; segment < segCount; segment += 1) {
			const start = u16(startOff + segment * 2);
			const end = u16(endOff + segment * 2);
			const delta = i16(deltaOff + segment * 2);
			const range = u16(rangeOff + segment * 2);
			for (let code = start; code <= end; code += 1) {
				let gid: number;
				if (range === 0) gid = (code + delta) & 0xffff;
				else {
					const where = rangeOff + segment * 2 + range + 2 * (code - start);
					gid = u16(where);
					if (gid) gid = (gid + delta) & 0xffff;
				}
				if (gid) cmapMap.set(code, gid);
			}
		}
	}
	const scale = (value: number) => Math.round((value * 1000) / unitsPerEm);
	let capHeight = 700;
	const os2 = tables.get("OS/2");
	if (os2 && os2.length >= 102) {
		const value = Math.abs(i16(os2.offset + 100));
		if (value) capHeight = scale(value);
	}
	extOnce = {
		buffer,
		unitsPerEm,
		ascent: scale(i16(hhea.offset + 4)),
		descent: scale(i16(hhea.offset + 6)),
		bbox: [scale(i16(head.offset + 36)), scale(i16(head.offset + 38)), scale(i16(head.offset + 40)), scale(i16(head.offset + 42))],
		capHeight,
		widths1000,
		cmap: cmapMap,
		glyphOf(code: number) {
			return this.cmap.get(code);
		},
	};
	return extOnce;
}

/**
 * The embedded face as five objects a page can point at: the composite font, the descendant font, the
 * descriptor, the font program and the map from its glyphs back to the words. The glyph ids are the
 * font's own, so the map is a single identity line; the widths are what the compositor measured with.
 */
function extendedObjects(type0: number, cid: number, desc: number, file: number, toUnicode: number): Buffer[] {
	const ext = extFont();
	const fileData = deflateSync(ext.buffer);
	const fileStream = Buffer.concat([
		Buffer.from(
			`<< /Length ${fileData.length} /Length1 ${ext.buffer.length} /Length2 0 /Length3 0 /Filter /FlateDecode >>\nstream\n`,
			"latin1",
		),
		fileData,
		Buffer.from("\nendstream", "latin1"),
	]);
	const cmapStream = toUnicodeCmap(ext);
	const wEntries: string[] = [];
	for (const gid of [...new Set(ext.cmap.values())].sort((a, b) => a - b)) wEntries.push(`${gid} [${ext.widths1000[gid] ?? 1000}]`);
	return [
		Buffer.from(`<< /Type /Font /Subtype /Type0 /BaseFont /DejaVuSans /Encoding /Identity-H /DescendantFonts [${cid} 0 R] /ToUnicode ${toUnicode} 0 R >>`, "latin1"),
		Buffer.from(
			`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /DejaVuSans /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> ` +
				`/FontDescriptor ${desc} 0 R /CIDToGIDMap /Identity /DW 1000 /W [${wEntries.join(" ")}] >>`,
			"latin1",
		),
		Buffer.from(
			`<< /Type /FontDescriptor /FontName /DejaVuSans /Flags 4 /FontBBox [${ext.bbox.map((one) => num(one)).join(" ")}] ` +
				`/ItalicAngle 0 /Ascent ${num(ext.ascent)} /Descent ${num(ext.descent)} /CapHeight ${num(ext.capHeight)} /StemV 80 /FontFile2 ${file} 0 R >>`,
			"latin1",
		),
		fileStream,
		Buffer.from(`<< /Length ${Buffer.byteLength(cmapStream, "latin1")} >>\nstream\n${cmapStream}endstream`, "latin1"),
	];
}

/** The map from the embedded glyphs back to the words: how a reader copies, searches and selects. */
function toUnicodeCmap(ext: ExtFace): string {
	const pairs = [...ext.cmap.entries()].map(([code, gid]) => ({ gid, code })).sort((a, b) => a.gid - b.gid);
	const blocks: string[] = [];
	for (let start = 0; start < pairs.length; start += 100) {
		const chunk = pairs.slice(start, start + 100);
		blocks.push(`${chunk.length} beginbfchar
${chunk.map((one) => `<${one.gid.toString(16).toUpperCase().padStart(4, "0")}> <${one.code.toString(16).toUpperCase().padStart(4, "0")}>`).join("\n")}
endbfchar`);
	}
	return `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo
<< /Registry (Adobe)
/Ordering (UCS)
/Supplement 0
>> def
/CMapName /Adobe-Identity-UCS def
/CMapVersion 1.0 def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
${blocks.join("\n")}
endcmap
CMapName currentdict /CMap defineresource pop
end
end
`;
}

/** The three characters a PDF string has to escape, so a note's own brackets survive. */
function literal(text: string): string {
	return text.replace(/[\\()]/g, (char) => `\\${char}`);
}

/** A number as the page writes it: two decimals, and never `-0`. */
function num(value: number): string {
	const rounded = Math.round(value * 100) / 100;
	return String(Object.is(rounded, -0) ? 0 : rounded);
}

/** A picture as a page can take it: pixels the reader draws, without a file behind them. */
export type Picture = { width: number; height: number; rgb: Buffer };

/**
 * One page's worth of drawing. The calls are collected as operators and handed over when the document is
 * assembled, so a page can be drawn in the order the reader's eye takes it.
 */
export type Sheet = {
	/** The ink everything drawn after this call is made of, as a grey from 0 (black) to 1 (white). */
	paint(grey: number): void;
	text(face: Face, size: number, x: number, y: number, value: string): void;
	box(x: number, y: number, width: number, height: number): void;
	line(x1: number, y1: number, x2: number, y2: number, thickness: number): void;
	/** A link to the address, over the rectangle [x1 y1 x2 y2] in points from the bottom-left. */
	link(url: string, x1: number, y1: number, x2: number, y2: number): void;
	/** The links this page drew, in the order it drew them: what the page has to declare. */
	links(): { url: string; rect: [number, number, number, number] }[];
	/** Pixels on the page, from the bottom left corner, the way every other drawing call places itself. */
	image(x: number, y: number, width: number, height: number, picture: Picture): void;
	/** The pictures this page drew, in the order it drew them: what the page has to declare. */
	pictures(): Picture[];
	/** The operators themselves, which the assembler writes into the page's one stream. */
	operators(): string;
};

/** A blank page, drawn on from the bottom left the way the format counts. */
export function sheet(): Sheet {
	const ops: string[] = [];
	const drawn: Picture[] = [];
	const linked: { url: string; rect: [number, number, number, number] }[] = [];
	return {
		paint(grey) {
			ops.push(`${num(grey)} g`, `${num(grey)} G`);
		},
		text(face, size, x, y, value) {
			let at = x;
			for (const run of textRuns(value)) {
				if (run.ext) {
					const hex = run.gids.map((gid) => gid.toString(16).toUpperCase().padStart(4, "0")).join("");
					ops.push(`BT`, `/${EXT_ID} ${num(size)} Tf`, `1 0 0 1 ${num(at)} ${num(y)} Tm`, `<${hex}> Tj`, `ET`);
					at += run.gids.reduce((total, gid) => total + extWidth(gid, size), 0);
			} else {
				if (!run.std) continue;
				ops.push(`BT`, `/${FACE_ID[face]} ${num(size)} Tf`, `1 0 0 1 ${num(at)} ${num(y)} Tm`, `(${literal(run.std)}) Tj`, `ET`);
				at += stdWidth(face, run.std, size);
			}
			}
		},
		box(x, y, width, height) {
			if (width <= 0 || height <= 0) return;
			ops.push(`${num(x)} ${num(y)} ${num(width)} ${num(height)} re f`);
		},
		line(x1, y1, x2, y2, thickness) {
			ops.push(`${num(thickness)} w`, `${num(x1)} ${num(y1)} m ${num(x2)} ${num(y2)} l S`);
		},
		image(x, y, width, height, picture) {
			// The unit square a picture is drawn in is mapped onto the place it goes, which is the one
			// transformation the format needs for this.
			drawn.push(picture);
			ops.push(`q ${num(width)} 0 0 ${num(height)} ${num(x)} ${num(y)} cm /Im${drawn.length} Do Q`);
		},
		link(url, x1, y1, x2, y2) {
			linked.push({ url, rect: [x1, y1, x2, y2] });
		},
		links() {
			return linked;
		},
		pictures() {
			return drawn;
		},
		operators() {
			return `${ops.join("\n")}\n`;
		},
	};
}

/** What each face is called inside a page, where the font is a resource and not a name. */
const FACE_ID: Record<Face, string> = {
	regular: "F1",
	bold: "F2",
	italic: "F3",
	boldItalic: "F4",
	mono: "F5",
};

/** What the embedded face is called inside a page, beside the standard ones. */
const EXT_ID = "F6";

/**
 * The pages as one file: a catalog, a tree of pages, the five standard fonts and the one embedded
 * face, then each page and its stream, then every picture and link the pages drew, and the table a
 * reader looks everything up in.
 *
 * The text streams are written as they are rather than compressed, because a card is a few pages of text
 * and a file a person can open in an editor is worth more than the few kilobytes a deflate would save. A
 * picture and the embedded font are the exceptions: pixels and glyphs are already the largest things in
 * the file, so they are deflated.
 */
export function documentOf(sheets: Sheet[]): Buffer {
	// 1 is the catalog, 2 the page tree, one object per standard face (3-7), five objects for the
	// embedded face (8-12), two per page, then one per picture and one per link. A picture used on two
	// pages is one object, so its bytes are paid for once.
	const firstFace = 3;
	const firstExt = firstFace + FACES.length;
	const extType0 = firstExt;
	const extCid = firstExt + 1;
	const extDesc = firstExt + 2;
	const extFile = firstExt + 3;
	const extToUnicode = firstExt + 4;
	const firstPage = firstExt + 5;
	const firstPicture = firstPage + sheets.length * 2;
	const pageId = (index: number) => firstPage + index * 2;
	const kids = sheets.map((_sheet, index) => `${pageId(index)} 0 R`).join(" ");

	const pictures = new Map<Picture, number>();
	for (const one of sheets) {
		for (const picture of one.pictures()) if (!pictures.has(picture)) pictures.set(picture, firstPicture + pictures.size);
	}
	// Where the first link object lands, and how many links each page drew before it.
	const firstLink = firstPicture + pictures.size;
	const linkCounts = sheets.map((one) => one.links().length);
	const linkAt = (index: number) => firstLink + linkCounts.slice(0, index).reduce((sum, count) => sum + count, 0);

	const objects: Buffer[] = [];
	objects.push(Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "latin1"));
	objects.push(Buffer.from(`<< /Type /Pages /Kids [${kids}] /Count ${sheets.length} >>`, "latin1"));
	for (const face of FACES) {
		objects.push(Buffer.from(`<< /Type /Font /Subtype /Type1 /BaseFont /${FACE_NAME[face]} /Encoding /WinAnsiEncoding >>`, "latin1"));
	}
	objects.push(...extendedObjects(extType0, extCid, extDesc, extFile, extToUnicode));
	for (const [index, one] of sheets.entries()) {
		const stream = one.operators();
		const fonts = FACES.map((face) => `/${FACE_ID[face]} ${firstFace + FACES.indexOf(face)} 0 R`).join(" ");
		const xobjects = one.pictures().map((picture, at) => `/Im${at + 1} ${pictures.get(picture)} 0 R`).join(" ");
		const annots = one.links().map((_link, at) => `${linkAt(index) + at} 0 R`).join(" ");
		objects.push(
			Buffer.from(
				`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(PAGE_WIDTH)} ${num(PAGE_HEIGHT)}] ` +
					`/Resources << /Font << ${fonts} /${EXT_ID} ${extType0} 0 R >>${xobjects ? ` /XObject << ${xobjects} >>` : ""} >> ` +
					`/Contents ${pageId(index) + 1} 0 R${annots ? ` /Annots [${annots}]` : ""} >>`,
				"latin1",
			),
		);
		objects.push(Buffer.from(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}endstream`, "latin1"));
	}
	for (const [picture] of pictures) objects.push(pictureObject(picture));
	for (const one of sheets) {
		for (const { url, rect } of one.links()) {
			objects.push(
				Buffer.from(
					`<< /Type /Annot /Subtype /Link /Rect [${num(rect[0])} ${num(rect[1])} ${num(rect[2])} ${num(rect[3])}] ` +
						`/Border [0 0 0] /A << /S /URI /URI (${literal(encode(url))}) >> >>`,
					"latin1",
				),
			);
		}
	}

	const parts: Buffer[] = [Buffer.from("%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n", "latin1")];
	const offsets: number[] = [];
	let at = parts[0].length;
	for (const [index, body] of objects.entries()) {
		offsets.push(at);
		const bytes = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`, "latin1"), body, Buffer.from("\nendobj\n", "latin1")]);
		parts.push(bytes);
		at += bytes.length;
	}
	const xref = [`xref`, `0 ${objects.length + 1}`, `0000000000 65535 f `];
	for (const offset of offsets) xref.push(`${String(offset).padStart(10, "0")} 00000 n `);
	const trailer = [`trailer`, `<< /Size ${objects.length + 1} /Root 1 0 R >>`, `startxref`, String(at), `%%EOF`, ""];
	parts.push(Buffer.from(`${xref.join("\n")}\n${trailer.join("\n")}`, "latin1"));
	return Buffer.concat(parts);
}

/**
 * One picture as an object a page can point at. The pixels go in as a deflated run of RGB rows, which is
 * the shape a reader wants and the shape a browser's own encoding has to be taken apart into.
 */
function pictureObject(picture: Picture): Buffer {
	const data = deflateSync(picture.rgb);
	const head =
		`<< /Type /XObject /Subtype /Image /Width ${picture.width} /Height ${picture.height} ` +
		`/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${data.length} >>\nstream\n`;
	return Buffer.concat([Buffer.from(head, "latin1"), data, Buffer.from("\nendstream", "latin1")]);
}
