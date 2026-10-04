/**
 * Smoke test: loads the extension through pi's real extension loader and drives the
 * registered tool directly. No model call, no API key.
 *
 *   node scripts/smoke.mjs
 *
 * The pi package is located from whatever installation owns the `pi` binary on PATH;
 * override with PI_PACKAGE_ENTRY when that guess is wrong. Extensions get their
 * host imports from pi's own jiti alias map at runtime.
 *
 * Covers: registration, all three modes, name sanitising, content-based reuse,
 * re-run by path, argv, a non-zero exit, output truncation, timeout, abort,
 * whether abort actually kills the whole process group (grandchildren included),
 * and the neighbour reminder a `create` adds for re-use.
 */

import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolvePiEntry } from "./pi-loader.mjs";

const execFileAsync = promisify(execFile);

const EXTENSION = new URL("../index.ts", import.meta.url).pathname;


let failures = 0;
let checks = 0;

function check(label, condition, detail) {
	checks += 1;
	if (condition) {
		console.log(`  ok   ${label}`);
		return;
	}
	failures += 1;
	console.log(`  FAIL ${label}${detail === undefined ? "" : ` — ${detail}`}`);
}

const { discoverAndLoadExtensions } = await import(await resolvePiEntry());

const workdir = await mkdtemp(join(tmpdir(), "pi-ipy-smoke-"));
const sessionId = `smoke${Date.now() % 100000}`;
const ctx = {
	cwd: workdir,
	mode: "print",
	hasUI: false,
	sessionManager: { getSessionId: () => sessionId },
};

console.log("load");
const loaded = await discoverAndLoadExtensions([EXTENSION], workdir, join(workdir, "agent"));
check("no load errors", loaded.errors.length === 0, JSON.stringify(loaded.errors));
const tool = loaded.extensions
	.flatMap((extension) => [...extension.tools.values()])
	.find((entry) => entry.definition.name === "ipy");
check("ipy registered", tool !== undefined);
if (!tool) process.exit(1);

const { definition } = tool;
check("has promptSnippet", typeof definition.promptSnippet === "string" && definition.promptSnippet.length > 0);
check("has exactly 2 guidelines", definition.promptGuidelines?.length === 2);
check("declares outputSchema", definition.outputSchema !== undefined);
check("no constrained sampling", definition.constrainedSampling === undefined);

let callId = 0;
const call = (params, signal) => definition.execute(`smoke-${(callId += 1)}`, params, signal, undefined, ctx);

const sessionDir = (await call({ list: true })).details?.dir;
check("list returns the session directory", typeof sessionDir === "string", sessionDir);

console.log("create / reuse / overwrite");
const first = await call({ code: "print('hi from ipy')", name: "hello", purpose: "smoke greeting" });
check("exit 0", first.structuredContent.exit_code === 0);
check("stdout captured", first.structuredContent.stdout.includes("hi from ipy"));
check("not reused on first write", first.structuredContent.reused === false);
check("name gets .py", first.structuredContent.script_path.endsWith("hello.py"), first.structuredContent.script_path);
check("path is inside the session dir", first.structuredContent.script_path.startsWith(sessionDir));
check("text result shows the script path", first.content[0].text.includes(first.structuredContent.script_path));

const second = await call({ code: "print('hi from ipy')", name: "hello" });
check("identical content is reused", second.structuredContent.reused === true);
check("same path on reuse", second.structuredContent.script_path === first.structuredContent.script_path);

const third = await call({ code: "print('changed')", name: "hello" });
check("changed content overwrites", third.structuredContent.reused === false);
check("file holds the new code", (await readFile(third.structuredContent.script_path, "utf8")).includes("changed"));

console.log("run by path / argv");
const rerun = await call({ path: third.structuredContent.script_path });
check("re-run by path", rerun.structuredContent.stdout.includes("changed"));
check("re-run marks state as existing", rerun.content[0].text.includes("existing script"));

const withArgs = await call({
	code: "import sys\nprint(sys.argv[1:])",
	name: "argv",
	args: ["--day", "09-30"],
});
check("args reach argv", withArgs.structuredContent.stdout.includes("'--day', '09-30'"), withArgs.structuredContent.stdout);

console.log("edit and run in one call");
const patched = await call({ path: third.structuredContent.script_path, edits: [{ oldText: "changed", newText: "patched" }] });
check("edit is executed in the same call", patched.structuredContent.stdout.trim() === "patched");
check("edited file persists", (await readFile(third.structuredContent.script_path, "utf8")).includes("patched"));
const unchanged = await readFile(third.structuredContent.script_path, "utf8");
for (const [label, edits] of [
	["missing match", [{ oldText: "patched", newText: "partial" }, { oldText: "absent", newText: "x" }]],
	["empty edits", []],
	["empty oldText", [{ oldText: "", newText: "x" }]],
	["overlapping edits", [{ oldText: "patched", newText: "x" }, { oldText: "patch", newText: "y" }]],
]) {
	let error;
	try { await call({ path: third.structuredContent.script_path, edits }); } catch (caught) { error = caught; }
	check(`${label} rejected`, error?.message.startsWith("ipy:"));
	check(`${label} leaves the whole file untouched`, (await readFile(third.structuredContent.script_path, "utf8")) === unchanged);
}
const duplicate = await call({ name: "duplicate", code: "print('xx')" });
let ambiguous;
try { await call({ path: duplicate.structuredContent.script_path, edits: [{ oldText: "x", newText: "y" }] }); } catch (error) { ambiguous = error; }
check("ambiguous match rejected", ambiguous?.message.includes("exactly once"));
const outside = join(workdir, "outside.py");
await writeFile(outside, "print('outside')");
let outsideError;
try { await call({ path: outside, edits: [{ oldText: "outside", newText: "changed" }] }); } catch (error) { outsideError = error; }
check("patch outside the session rejected", outsideError?.message.startsWith("ipy:"));
await symlink(outside, join(sessionDir, "linked.py"));
let linkError;
try { await call({ path: join(sessionDir, "linked.py"), edits: [{ oldText: "outside", newText: "changed" }] }); } catch (error) { linkError = error; }
check("patch through a symlink rejected", linkError?.message.startsWith("ipy:"));
check("external file untouched", (await readFile(outside, "utf8")) === "print('outside')");
const pair = await call({ name: "pair", code: "print('first', 'second')" });
const pairRun = await call({ path: pair.structuredContent.script_path, edits: [
	{ oldText: "second", newText: "tail" }, { oldText: "first", newText: "head" },
] });
check("multiple disjoint edits run together", pairRun.structuredContent.stdout.trim() === "head tail");
for (const params of [
	{ code: "print(1)", edits: [{ oldText: "1", newText: "2" }] },
	{ list: true, edits: [{ oldText: "1", newText: "2" }] },
]) {
	let error;
	try { await call(params); } catch (caught) { error = caught; }
	check("edits require path mode", error?.message.startsWith("ipy:"));
}

console.log("name sanitising");
const escaped = await call({ code: "print('safe')", name: "../../evil" });
check("traversal collapses to a bare name", escaped.structuredContent.script_path === join(sessionDir, "evil.py"), escaped.structuredContent.script_path);

console.log("fallback naming");
const autoNamed = await call({ code: "print('auto')", purpose: "Parse NVR logs quickly" });
check("name derives from purpose", autoNamed.structuredContent.script_path.endsWith("parse_nvr_logs_quickly.py"), autoNamed.structuredContent.script_path);
const bare = await call({ code: "print('bare')" });
check("timestamped name as last resort", /script_\d{6}(?:_[a-f0-9]+)?\.py$/.test(bare.structuredContent.script_path), bare.structuredContent.script_path);
const RealDate = Date;
globalThis.Date = class extends RealDate {
	constructor(...args) { super(...(args.length ? args : ["2026-10-04T12:00:00Z"])); }
};
try {
	const chinese = await call({ code: "print('first')", purpose: "统计课程数量" });
	const different = await call({ code: "print('second')", purpose: "分析日志错误" });
	check("different Chinese purposes get different paths", chinese.structuredContent.script_path !== different.structuredContent.script_path);
	check("Chinese fallback preserves the first script", (await readFile(chinese.structuredContent.script_path, "utf8")) === "print('first')");
	const repeated = await call({ code: "print('first')", purpose: "统计课程数量" });
	check("same Chinese purpose reuses its path", repeated.structuredContent.script_path === chinese.structuredContent.script_path && repeated.structuredContent.reused);
	const unnamed1 = await call({ code: "print('unnamed first')" });
	const unnamed2 = await call({ code: "print('unnamed second')" });
	check("unnamed scripts in the same second have distinct paths", unnamed1.structuredContent.script_path !== unnamed2.structuredContent.script_path);
} finally {
	globalThis.Date = RealDate;
}

console.log("re-use prompting (the two result lines the model decides on)");
const neighbour = await call({ code: "print('third')", name: "third_script", purpose: "count tool calls per session" });
const neighbourLine = neighbour.content[0].text.split("\n").find((line) => line.startsWith("also in this session:")) ?? "";
check("create names the session's other scripts", neighbourLine.length > 0, neighbour.content[0].text);
check("the new script is not its own neighbour", !neighbourLine.includes("third_script.py"), neighbourLine);
check(
	"create repeats the edit-and-re-run instruction",
	neighbour.content[0].text.includes(`ipy({path: "${neighbour.structuredContent.script_path}", args:`) && neighbour.content[0].text.includes("add edits:"),
	neighbour.content[0].text,
);
check("run-by-path does not repeat it", !(await call({ path: neighbour.structuredContent.script_path })).content[0].text.includes("don't send the code again"));
const later = await call({ code: "print('fourth')", name: "fourth_script", purpose: "unrelated purpose" });
check(
	"reminder carries the newest neighbour's purpose",
	later.content[0].text.includes("third_script.py — count tool calls per session"),
	later.content[0].text,
);
check("reminder is capped", (later.content[0].text.match(/ \| /g) ?? []).length <= 2, later.content[0].text);
process.env.PI_IPY_QUIET = "1";
const silenced = await call({ code: "print('quiet')", name: "quiet_script" });
delete process.env.PI_IPY_QUIET;
check("PI_IPY_QUIET silences the reminder", !silenced.content[0].text.includes("also in this session:"));
check("PI_IPY_QUIET silences the edit instruction", !silenced.content[0].text.includes("don't send the code again"));

console.log("failure paths");
const failed = await call({ code: "import sys\nsys.stderr.write('boom\\n')\nsys.exit(3)", name: "failing" });
check("non-zero exit reported", failed.structuredContent.exit_code === 3);
check("isError set", failed.isError === true);
check("stderr captured", failed.structuredContent.stderr.includes("boom"));

for (const [label, params] of [
	["code + path rejected", { code: "print(1)", path: "/tmp/x.py" }],
	["neither code nor path rejected", {}],
	["list + code rejected", { list: true, code: "print(1)" }],
	["bad timeout rejected", { code: "print(1)", timeout: -5 }],
]) {
	let message = "";
	try {
		await call(params);
	} catch (error) {
		message = error.message;
	}
	check(label, message.startsWith("ipy:"), message || "(no error thrown)");
}

let missing = "";
try {
	await call({ path: join(sessionDir, "never_written.py") });
} catch (error) {
	missing = error.message;
}
check("missing script names the recovery paths", missing.includes("reboot") && missing.includes("ipy({list:true})"), missing);

console.log("truncation");
const big = await call({ code: "print('line' * 1)\nfor i in range(5000): print(i, 'x' * 40)", name: "big" });
check("output_path set when truncated", typeof big.structuredContent.output_path === "string");
if (big.structuredContent.output_path) {
	const full = await stat(big.structuredContent.output_path);
	check("full output is bigger than the model view", full.size > Buffer.byteLength(big.content[0].text));
}
check("model view mentions the full output path", big.content[0].text.includes("full output:"));
check("model view actually enforces the byte cap", Buffer.byteLength(big.content[0].text) < 50 * 1024 + 1024);
check("model view retains the end of stdout", big.content[0].text.includes("4999 "));
const previousOutput = await readFile(big.structuredContent.output_path, "utf8");
const bigAgain = await call({ name: "big", code: "for i in range(5000): print('SECOND_RUN', i)" });
check("rerun has its own output path", bigAgain.structuredContent.output_path !== big.structuredContent.output_path);
check("rerun preserves the earlier output", (await readFile(big.structuredContent.output_path, "utf8")) === previousOutput);
const wide = await call({ name: "wide", code: "import sys\nprint('字' * 30000)\nsys.stderr.write('尾' * 30000 + 'ERROR_SENTINEL')" });
check("combined stdout/stderr has one byte budget", Buffer.byteLength(wide.content[0].text) < 50 * 1024 + 1024);
check("truncated Unicode stays valid and keeps stderr tail", !wide.content[0].text.includes("\ufffd") && wide.content[0].text.includes("ERROR_SENTINEL"));

console.log("timeout / abort / process group");
const slow = await call({ code: "import time\ntime.sleep(30)", name: "slow", timeout: 1 });
check("timeout flagged", slow.structuredContent.timed_out === true);
check("timeout killed quickly", slow.structuredContent.wall_time_seconds < 10, `${slow.structuredContent.wall_time_seconds}s`);

const controller = new AbortController();
const abortTimer = setTimeout(() => controller.abort(), 500);
const marker = `IPY_SMOKE_${Date.now()}`;
const grandchild = [
	"import subprocess, sys, time",
	`subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)", "${marker}"])`,
	"time.sleep(60)",
].join("\n");
const aborted = await call({ code: grandchild, name: "aborting" }, controller.signal);
clearTimeout(abortTimer);
check("abort flagged", aborted.structuredContent.aborted === true);
check("abort returns quickly", aborted.structuredContent.wall_time_seconds < 10, `${aborted.structuredContent.wall_time_seconds}s`);

await new Promise((resolve) => setTimeout(resolve, 2500));
const { stdout: psOut } = await execFileAsync("ps", ["-eo", "args"]).catch(() => ({ stdout: "" }));
check("grandchild killed with the group", !psOut.includes(marker));

for (const reason of ["timeout", "abort"]) {
	const survivorPath = join(workdir, `survivor-${reason}`);
	const pidPath = join(workdir, `survivor-${reason}.pid`);
	const readyPath = join(workdir, `ready-${reason}`);
	const childCode = `import signal,time,pathlib; signal.signal(signal.SIGTERM,signal.SIG_IGN); pathlib.Path(${JSON.stringify(readyPath)}).touch(); time.sleep(3); pathlib.Path(${JSON.stringify(survivorPath)}).touch()`;
	const parentCode = [
		"import subprocess,sys,time,pathlib",
		`p = subprocess.Popen([sys.executable, '-c', ${JSON.stringify(childCode)}], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)`,
		`pathlib.Path(${JSON.stringify(pidPath)}).write_text(str(p.pid))`,
		"time.sleep(30)",
	].join("\n");
	const cancellation = new AbortController();
	const timer = reason === "abort" ? setTimeout(() => cancellation.abort(), 1000) : undefined;
	try {
		const result = await call({ name: `detached_${reason}`, code: parentCode, ...(reason === "timeout" ? { timeout: 1 } : {}) }, cancellation.signal);
		check(`${reason} reached a TERM-ignoring descendant`, await stat(readyPath).then(() => true, () => false));
		check(`${reason} reported termination`, result.structuredContent[reason === "timeout" ? "timed_out" : "aborted"]);
		await new Promise((resolve) => setTimeout(resolve, 3100));
		check(`${reason} kills descendants after the parent closes its pipes`, !(await stat(survivorPath).then(() => true, () => false)));
	} finally {
		clearTimeout(timer);
		const pid = Number(await readFile(pidPath, "utf8"));
		try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
	}
}

console.log("manifest / list");
const listing = await call({ list: true });
check("list shows written scripts", listing.content[0].text.includes("hello.py") && listing.content[0].text.includes("argv.py"));
check("list shows the purpose", listing.content[0].text.includes("smoke greeting"));
check("list shows run counts", /1 run\(s\)|2 run\(s\)|3 run\(s\)/.test(listing.content[0].text));

await rm(sessionDir, { recursive: true, force: true });
await rm(workdir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
