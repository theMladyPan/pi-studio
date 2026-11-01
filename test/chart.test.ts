import assert from "node:assert/strict";
import { test } from "node:test";
import { auditMarkdown } from "../server/chart-audit.ts";

/**
 * The drawing is a client module, and `tsconfig.node.json` includes `server/**` and `test/**` only, so
 * the specifier is computed: a literal path there would make `tsc` try to type a file outside its
 * include and fail on the missing declarations instead of checking anything.
 */
const client = await import(new URL("../public/client/chart.js", import.meta.url).href);
const renderChart = client.renderChart as (source: string, options?: { width?: number; height?: number }) => { svg: string; warnings: string[] };

/** A fence body in the markdown the model writes, which is the only shape the audit reads. */
const fence = (body: string) => ["```chart", body, "```"].join("\n");

/** Three bars, one series: the smallest chart that has a shape to check. */
const threeBars = `type: bar
title: errors per hour
x: time
y: errors (count)
---
09:00 | 12
10:00 | 9
11:00 | 3`;

test("three bars draw three rects, and nothing that can run or animate", () => {
	const { svg } = renderChart(threeBars);
	assert.equal((svg.match(/<rect/g) ?? []).length, 3, "one rect per bar");
	// A card inserts this markup directly, so anything executable or self-restyling in it is a defect.
	for (const forbidden of ["<script", "<style", "animate", "<foreignObject", "class=", "javascript:"]) {
		assert.ok(!svg.toLowerCase().includes(forbidden.toLowerCase()), `the drawing must not contain ${forbidden}`);
	}
	assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 420 220"/);
});

test("twelve categories in 400px say so, and name the width the reader would need", () => {
	const crowded = `type: bar
y: count
---
${Array.from({ length: 12 }, (_, index) => `category number ${index + 1} | ${index + 1}`).join("\n")}`;
	const { warnings } = renderChart(crowded, { width: 400 });
	assert.ok(
		warnings.some((warning: string) => warning.includes("wide")),
		`a crowded chart has to tell the model to go wide or drop points, got ${JSON.stringify(warnings)}`,
	);
});

test("a body with nothing to draw says no chart data instead of returning an empty box", () => {
	const { svg, warnings } = renderChart("bogus");
	assert.ok(svg.includes("no chart data"), svg);
	assert.ok(warnings.length > 0, "a silent empty drawing is the failure this guards");
});

test("the audit refuses a chart fence that is not a chart", () => {
	const { warnings, summary } = auditMarkdown("```chart\nbogus\n```");
	assert.deepEqual(warnings, ["chart block does not parse: no --- separator and no two-column rows"]);
	assert.equal(summary, "", "a fence that does not parse has no shape to describe");
});

test("the audit says nothing about markdown that holds no chart", () => {
	assert.deepEqual(auditMarkdown("A note with a ```js fence\nconsole.log(1)\n``` and no chart."), { warnings: [], summary: "" });
});

test("the audit describes the chart the card will draw, in one line", () => {
	const crowded = fence(`type: bar
y: count
---
${Array.from({ length: 12 }, (_, index) => `c${index} | ${index}`).join("\n")}`);
	const audited = auditMarkdown(crowded);
	assert.equal(audited.summary, "chart: bar, 12 points, 1 series, not sorted");
	assert.deepEqual(audited.warnings, ['12 categories in 406px: labels will be elided or rotated, use size="wide" or fewer points']);
	// The same chart on a wide card fits, so the warning is about the width and not about the count alone.
	assert.deepEqual(auditMarkdown(crowded, 800).warnings, []);
});
