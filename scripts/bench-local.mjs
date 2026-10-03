/** Deterministic tool costs, without a model. These are bytes/calls, never token claims. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolvePiEntry } from "./pi-loader.mjs";

const baseline = process.argv[2];
if (!baseline) throw new Error("usage: node scripts/bench-local.mjs <baseline/index.ts>");
const { discoverAndLoadExtensions, createEditTool } = await import(await resolvePiEntry());
const work = await mkdtemp(join(tmpdir(), "ipy-local-"));
const input = join(work, "input.jsonl");
const rows = Array.from({ length: 400 }, (_, i) => ({ tool: `tool_${i % 6}`, tokens: (i * 7919) % 99991 }));
await writeFile(input, rows.map((r) => JSON.stringify(r)).join("\n"));
const source = [
	"import json", "import statistics", "import sys", "from collections import defaultdict",
	"", "statistic = 'mean'", "limit = 5", "samples = defaultdict(list)",
	"with open(sys.argv[1]) as stream:", "    for line in stream:", "        row = json.loads(line)",
	"        samples[row['tool']].append(row['tokens'])", "", "aggregate = getattr(statistics, statistic)",
	"result = [{'tool': name, 'calls': len(values), 'tokens': round(aggregate(values), 1)}",
	"          for name, values in samples.items()]", "result.sort(key=lambda row: (-row['tokens'], row['tool']))",
	"print(json.dumps(result[:limit]))",
].join("\n");
const edits = [{ oldText: "statistic = 'mean'", newText: "statistic = 'median'" }, { oldText: "limit = 5", newText: "limit = 3" }];
const changed = edits.reduce((code, e) => code.replace(e.oldText, e.newText), source);
const report = [];
const outputCaps = [];
let callId = 0;
const grouped = new Map();
for (const row of rows) {
	const values = grouped.get(row.tool) ?? [];
	values.push(row.tokens);
	grouped.set(row.tool, values);
}
const expected = [...grouped].map(([tool, values]) => {
	values.sort((a, b) => a - b);
	const middle = Math.floor(values.length / 2);
	const median = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
	return { tool, calls: values.length, tokens: Number(median.toFixed(1)) };
}).sort((a, b) => b.tokens - a.tokens || a.tool.localeCompare(b.tool)).slice(0, 3);
for (const strategy of ["resend", "edit_then_run", "edit_and_run"]) {
	const extension = strategy === "edit_and_run" ? new URL("../index.ts", import.meta.url).pathname : resolve(baseline);
	const id = randomUUID();
	const ctx = { cwd: work, mode: "print", hasUI: false, sessionManager: { getSessionId: () => id } };
	const loaded = await discoverAndLoadExtensions([extension], work, join(work, "agent"));
	assert.deepEqual(loaded.errors, []);
	const definition = loaded.extensions.flatMap((e) => [...e.tools.values()]).find((t) => t.definition.name === "ipy").definition;
	const call = (args) => definition.execute(String(++callId), args, undefined, undefined, ctx);
	let calls = 0, argumentBytes = 0, resultBytes = 0;
	const durations = [];
	let directory;
	try {
		for (let rep = 0; rep < 10; rep++) {
			const created = await call({ code: source, name: "stats", args: [input] });
			assert.equal(created.structuredContent.exit_code, 0);
			const path = created.structuredContent.script_path;
			directory = (await call({ list: true })).details.dir;
			const args = strategy === "resend" ? { code: changed, name: "stats", args: [input] } : { path, args: [input], ...(strategy === "edit_and_run" ? { edits } : {}) };
			const started = performance.now();
			if (strategy === "edit_then_run") {
				const editArgs = { path, edits };
				const result = await createEditTool(work).execute(String(++callId), editArgs);
				calls++;
				argumentBytes += Buffer.byteLength(JSON.stringify(editArgs));
				resultBytes += Buffer.byteLength(JSON.stringify(result.content));
			}
			const result = await call(args);
			durations.push(performance.now() - started);
			calls++;
			argumentBytes += Buffer.byteLength(JSON.stringify(args));
			resultBytes += Buffer.byteLength(JSON.stringify(result.content));
			assert.equal(result.structuredContent.exit_code, 0);
			const answer = JSON.parse(result.structuredContent.stdout);
			assert.equal(answer.length, 3);
			assert.deepEqual(answer, expected);
		}
		durations.sort((a, b) => a - b);
		report.push({ strategy, reps: 10, calls_per_change: calls / 10, argument_bytes_per_change: argumentBytes / 10,
			result_bytes_per_change: resultBytes / 10, local_wall_ms_median: (durations[4] + durations[5]) / 2 });
		if (strategy !== "edit_then_run") {
			const large = await call({ name: "large", code: "for i in range(5000): print(i, 'x' * 40)" });
			outputCaps.push({ strategy, model_text_bytes: Buffer.byteLength(large.content[0].text) });
			if (strategy === "edit_and_run") assert.ok(Buffer.byteLength(large.content[0].text) < 50 * 1024 + 1024);
		}
	} finally {
		if (directory) await rm(directory, { recursive: true, force: true });
	}
}
await rm(work, { recursive: true, force: true });
console.log(JSON.stringify({ changes: report, output_caps: outputCaps }, null, 2));
