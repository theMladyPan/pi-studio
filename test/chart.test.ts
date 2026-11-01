import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { test } from "node:test";
import { auditMarkdown } from "../server/chart-audit.ts";

/**
 * The audit is the whole of the chart contract this side of the browser: a chart block is a Chart.js
 * config written as JSON, and the client snapshots it to a PNG. So there is no renderer to unit-test
 * here, only what the model is told about the config it wrote.
 */

/** A fence body in the markdown the model writes, which is the only shape the audit reads. */
const fence = (body: string) => ["```chart", body, "```"].join("\n");

/** Twelve labels and one series: the smallest config that has a shape worth summarising. */
const twelveBars = JSON.stringify({
	type: "bar",
	data: {
		labels: Array.from({ length: 12 }, (_, index) => `0${Math.min(index + 1, 9)}:00`),
		datasets: [{ label: "errors", data: Array.from({ length: 12 }, (_, index) => index) }],
	},
});

/** Anything the fixture above says nothing about: a warning here is a warning the model cannot use. */
test("a valid bar config is clean, and the summary names its shape", () => {
	const audited = auditMarkdown(fence(twelveBars), 800);
	assert.deepEqual(audited.warnings, []);
	assert.equal(audited.summary, "chart: bar, 12 labels, 1 dataset");
});

test("a config carrying a function says so, because JSON cannot carry one", () => {
	// The model reaches for the Chart.js docs and writes a tick callback; quoted, it is data that does
	// nothing, and unquoted it is not JSON at all. Both are reported, and this is the quoted one.
	const withCallback = JSON.stringify({
		type: "line",
		data: { labels: ["a", "b"], datasets: [{ label: "p95 (ms)", data: [180, 240] }] },
		options: { scales: { y: { ticks: { callback: "function (value) { return value + 'ms'; }" } } } },
	});
	const { warnings } = auditMarkdown(fence(withCallback));
	assert.ok(
		warnings.some((warning) => warning.includes("function")),
		`a callback in the config has to be named, got ${JSON.stringify(warnings)}`,
	);
});

test("a label that says `new users` is a label, and not code", () => {
	// `new` reads like the operator, and a warning here would send a model off to rewrite a label
	// that was already right. Only `function` and `=>` are the failures that actually occur.
	const fresh = JSON.stringify({
		type: "line",
		data: {
			labels: ["new users", "returning users"],
			datasets: [{ label: "signups", data: [12, 8] }],
		},
	});
	const { warnings } = auditMarkdown(fence(fresh));
	assert.deepEqual(warnings, []);
});

test("a card with more than four warnings keeps four and counts the rest", () => {
	// A report the model skims is a report it ignores, so the tail is counted rather than listed.
	const mess = JSON.stringify({
		data: {
			labels: Array.from({ length: 12 }, (_, index) => `0${Math.min(index + 1, 9)}:00`),
			datasets: Array.from({ length: 7 }, (_, index) => ({ label: `series ${index + 1}`, data: [] })),
		},
		options: { a: { b: { c: { d: { e: 1 } } } } },
	});
	const { warnings } = auditMarkdown(fence(mess), 400);
	assert.deepEqual(warnings.slice(0, 4).length, 4);
	assert.equal(warnings.length, 5, `the report has to stop somewhere, got ${JSON.stringify(warnings)}`);
	assert.match(warnings[4], /^and \d+ more$/);
});

test("a body that is not JSON names the parser's complaint and says nothing else", () => {
	const { warnings, summary } = auditMarkdown(
		fence(`{
  type: "bar",
  data: { labels: ["a"], datasets: [{ label: "x", data: [1] }] },
  options: { scales: { y: { ticks: { callback: (value) => value + "ms" } } } }
}`),
	);
	assert.equal(warnings.length, 1, `a body that does not parse has no other shape to report, got ${JSON.stringify(warnings)}`);
	assert.ok(warnings[0].includes("not JSON"), warnings[0]);
	assert.equal(summary, "");
});

test("twelve labels in a 400px card say so, and name the width the reader would need", () => {
	const { warnings } = auditMarkdown(fence(twelveBars), 400);
	assert.ok(
		warnings.some((warning) => warning.includes("wide")),
		`a crowded chart has to tell the model to go wide or drop labels, got ${JSON.stringify(warnings)}`,
	);
});

test("seven datasets in one chart say so", () => {
	const seven = JSON.stringify({
		type: "line",
		data: {
			labels: ["a", "b", "c"],
			datasets: Array.from({ length: 7 }, (_, index) => ({ label: `series ${index + 1}`, data: [1, 2, 3] })),
		},
	});
	const { warnings } = auditMarkdown(fence(seven));
	assert.ok(
		warnings.some((warning) => warning.includes("7 datasets")),
		`seven lines in one card is the failure this guards, got ${JSON.stringify(warnings)}`,
	);
});

test("the audit says nothing about markdown that holds no chart", () => {
	assert.deepEqual(auditMarkdown("A note with a ```js fence\nconsole.log(1)\n``` and no chart."), { warnings: [], summary: "" });
});

test("the Chart.js bundle is vendored, and is the library rather than a stub", () => {
	const bundle = new URL("../public/client/chart-umd-min.js", import.meta.url);
	assert.ok(existsSync(bundle), "public/client/chart-umd-min.js is missing, so no chart block can draw");
	const bytes = statSync(bundle).size;
	assert.ok(bytes > 100_000, `the bundle is ${bytes} bytes, which is too small to be Chart.js`);
});
