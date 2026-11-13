/**
 * The drawings the flow chips hover. They are drawn once, in the document that also holds the steps, so
 * these read that document the way the daemon does rather than any copy of its pictures.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { PATH_NAMES } from "../server/child/modes.ts";
import { FLOW_DOC, flowDiagrams } from "../server/flow-diagrams.ts";

test("each flow that is drawn comes back with its own drawing", async () => {
	const flows = await flowDiagrams();
	assert.deepEqual(
		flows.map((one) => one.path),
		["simple", "advanced", "complex"],
		"the three recipes, and no fourth for auto",
	);
	for (const one of flows) {
		assert.ok(PATH_NAMES.includes(one.path), `${one.path} is a path a boss can be on`);
		assert.ok(one.svg.startsWith("<svg"), `${one.path} comes back as an svg`);
		assert.ok(one.svg.endsWith("</svg>"), `${one.path} comes back whole`);
	}
	assert.equal(new Set(flows.map((one) => one.svg)).size, 3, "three drawings, one each");
});

test("a document that is not there answers nothing rather than throwing", async () => {
	assert.deepEqual(await flowDiagrams(join(tmpdir(), "pi-studio-no-such-docs")), []);
});

test("a document holding one of the three answers that one", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-studio-flows-"));
	try {
		mkdirSync(join(root, "docs"), { recursive: true });
		const drawing = '<svg viewBox="0 0 10 10"><text y="6">scout</text></svg>';
		writeFileSync(
			join(root, FLOW_DOC),
			["# Flows", "", "### simple — one step", "", "The steps.", "", "```svg", drawing, "```", ""].join("\n"),
		);
		assert.deepEqual(await flowDiagrams(root), [{ path: "simple", svg: drawing }], "a heading that is gone is a flow that is not drawn");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
