// @ts-nocheck -- lifted byte for byte; annotating it is its own commit.
/**
 * Reading a child's output back into something a row can show: the tool it called, what came of it,
 * and how much of it fits.
 */
import { join } from "node:path";
import { MAX_ROW_CHARS } from "../limits.ts";



/** The short text a rail row shows. Arguments stay out of it: the row is a signpost, not a log. */
export function describeTool(name, args) {
	if (name === "read" || name === "write" || name === "edit") return `${name} ${String(args.path ?? args.file_path ?? "")}`.trim();
	if (name === "bash") {
		const command = String(args.command ?? "").replace(/\s+/g, " ");
		return `$ ${command.length > 120 ? `${command.slice(0, 117)}...` : command}`;
	}
	if (name === "grep") return `grep ${String(args.pattern ?? "")}`;
	if (name === "find") return `find ${String(args.pattern ?? "*")}`;
	return name;
}



/** The one line of an error a card can show, or what to say when pi gave no reason. */
export function headline(text) {
	return (
		String(text ?? "")
			.split("\n")
			.map((line) => line.trim())
			.find((line) => line.length > 0)
			?.slice(0, 160) ?? "the run failed"
	);
}



/** The text a tool result carries, in the order the tool said it. */
export function resultText(result) {
	const content = Array.isArray(result?.content) ? result.content : [];
	return content
		.filter((part) => part?.type === "text")
		.map((part) => String(part.text ?? ""))
		.join("\n");
}



/** What a rail row says once the call is over: its first line of output, cut short. */
export function firstLine(result) {
	return resultText(result).split("\n").map((line) => line.trim()).find((line) => line.length > 0)?.slice(0, 140) ?? "";
}



/** A field of a row, cut to the ceiling and saying whether it was. */
export function ceiling(value) {
	const text = String(value ?? "");
	return { text: text.slice(0, MAX_ROW_CHARS), cut: text.length > MAX_ROW_CHARS };
}



/**
 * What a finished call leaves behind: the words it said, the diff it made, its exit code, and the
 * picture it took. The panel draws these fields; nothing here is a JSON dump of the result, which is
 * why most of what a row used to weigh is gone.
 */
export function rowResult(result) {
	// A tool may hand its result over as bare text rather than as parts.
	if (typeof result === "string") return { output: ceiling(result).text };
	const content = Array.isArray(result?.content) ? result.content : [];
	const cut = new Set();
	const said = ceiling(resultText(result));
	if (said.cut) cut.add("output");
	// A tool that said nothing in words still has to be readable, so its JSON is the last resort.
	const dump = !said.text && result !== undefined ? ceiling(JSON.stringify(result, null, 2)) : null;
	if (dump?.cut) cut.add("output");
	const output = said.text || dump?.text || "";
	const details = result?.details && typeof result.details === "object" ? result.details : {};
	const structured = result?.structuredContent && typeof result.structuredContent === "object" ? result.structuredContent : {};
	const diff = typeof details.diff === "string" && details.diff ? ceiling(details.diff) : null;
	if (diff?.cut) cut.add("diff");
	// Only the newest picture is kept: a screenshot is read while the row is open, and a row holds one.
	const image = [...content].reverse().find((part) => part?.type === "image" && part.data);
	return {
		output,
		...(diff ? { diff: diff.text } : {}),
		...(Number.isFinite(structured.exit_code) ? { exitCode: structured.exit_code } : {}),
		...(resultsTruncated(structured) ? { truncated: true } : {}),
		...(image ? { images: [{ mime: String(image.mimeType || "image/png"), data: String(image.data) }] } : {}),
		...(cut.size ? { cut: [...cut] } : {}),
	};
}



/** Whether the tool itself says it cut what it returned, which is worth saying in the panel. */
export function resultsTruncated(structured) {
	return structured.truncated === true || structured.truncated === "true";
}



/** The last line a child wrote on stderr, which is often the only explanation there is. */
export function lastLine(tail) {
	const lines = String(tail ?? "")
		.replace(/\u001b\[[0-9;]*m/g, "")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	return lines[lines.length - 1]?.slice(0, 160) ?? "";
}
