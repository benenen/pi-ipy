/**
 * ipy — run Python scripts from a temp file you can re-run and edit.
 *
 * Why a second tool next to bash: bash is framed as a file/shell tool (`Use bash for
 * file operations like ls, rg, find`), so "write a program" has no owner. ipy fills
 * that slot and makes the script a durable artefact — it lands on disk, the model
 * gets its path back, and the next turn can edit two lines instead of re-emitting
 * forty.
 *
 * The preference comes from `promptSnippet` + `promptGuidelines` (always-on system
 * prompt text), not from the tool itself. Two bullets only: every guideline is
 * permanent context, and piling them up dilutes all of them.
 *
 * Layout for one call: parse the arguments into a discriminated mode, then either
 * list, write-then-run, or re-run. See lib/store.ts for where scripts live and
 * lib/run.ts for how the child process is capped and killed.
 */

import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
	formatSize,
	truncateHead,
	truncateTail,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type RunResult, runPython } from "./lib/run.ts";
import {
	appendManifest,
	hashFile,
	listScripts,
	saveFullOutput,
	saveScript,
	type ScriptInfo,
	sessionDir,
} from "./lib/store.ts";

/** How much of each stream script callers (codemode) receive. */
const CODEMODE_MAX_BYTES = 1024 * 1024;

const pythonPath = (): string => process.env.PI_IPY_PYTHON?.trim() || "python3";

const ipySchema = Type.Object({
	code: Type.Optional(
		Type.String({
			description: "Python source to write to a file and run. Provide this or `path`, not both.",
		}),
	),
	name: Type.Optional(
		Type.String({
			description:
				"File name for the script, e.g. parse_logs. `.py` is appended if missing. Reusing a name replaces that " +
				"script; omit to derive the name from `purpose`.",
		}),
	),
	purpose: Type.Optional(
		Type.String({
			description:
				"One-line note on what the script is for. Used as the file name when `name` is omitted, and shown by " +
				"ipy({list:true}).",
		}),
	),
	path: Type.Optional(
		Type.String({ description: "Path of an existing script to run, as returned by an earlier ipy call." }),
	),
	args: Type.Optional(Type.Array(Type.String(), { description: "Arguments passed to the script via argv." })),
	timeout: Type.Optional(
		Type.Number({ description: "Kill the script after this many seconds. Omit for no limit." }),
	),
	list: Type.Optional(
		Type.Boolean({ description: "List the scripts written in this session instead of running one." }),
	),
});

type IpyInput = typeof ipySchema.static;

const ipyOutputSchema = Type.Object({
	exit_code: Type.Number(),
	stdout: Type.String({ description: "Captured stdout, mid-truncated to 1 MiB" }),
	stderr: Type.String({ description: "Captured stderr, mid-truncated to 1 MiB" }),
	script_path: Type.Optional(Type.String()),
	reused: Type.Boolean({ description: "True when the script was already on disk with identical content" }),
	wall_time_seconds: Type.Number(),
	output_path: Type.Optional(Type.String({ description: "Full output on disk when the text view was truncated" })),
	timed_out: Type.Boolean(),
	aborted: Type.Boolean(),
});

interface IpyDetails {
	mode: "list" | "create" | "run";
	scriptPath?: string;
	/** Session script directory; set for `list` so callers can build paths. */
	dir?: string;
	reused?: boolean;
	exitCode: number;
	wallTimeSeconds: number;
	timedOut?: boolean;
}

/** Discriminated union of the three calls ipy accepts; invalid combinations throw. */
type Mode =
	| { kind: "list" }
	| { kind: "create"; code: string; name?: string; purpose?: string; args: string[]; timeoutMs?: number }
	| { kind: "run"; path: string; args: string[]; timeoutMs?: number };

function parseInput(params: IpyInput): Mode {
	const code = params.code?.trim();
	const path = params.path?.trim();

	if (params.list === true) {
		if (code || path) throw new Error("ipy: `list` cannot be combined with `code` or `path`.");
		return { kind: "list" };
	}
	if (code && path) throw new Error("ipy: `code` and `path` are mutually exclusive — pass exactly one.");
	if (!code && !path) {
		throw new Error(
			"ipy: nothing to do — pass `code` to write a script, `path` to re-run one, or `list: true`.",
		);
	}

	const args = params.args ?? [];
	if (!args.every((item) => typeof item === "string")) {
		throw new Error("ipy: `args` must be an array of strings.");
	}
	if (params.timeout !== undefined && !(Number.isFinite(params.timeout) && params.timeout > 0)) {
		throw new Error("ipy: `timeout` must be a positive number of seconds.");
	}
	const timeoutMs = params.timeout === undefined ? undefined : Math.round(params.timeout * 1000);

	if (code) {
		return { kind: "create", code, name: params.name, purpose: params.purpose, args, timeoutMs };
	}
	return { kind: "run", path: path as string, args, timeoutMs };
}

/**
 * Fallback name for `code` calls that omit `name`.
 *
 * Prefers a slug of `purpose`: real sessions show the model omitting `name`, and a
 * semantic file name is what makes the script findable again 40 turns later. A
 * timestamped name is the last resort, when there is no usable purpose either.
 */
function fallbackName(purpose?: string): string {
	const slug = (purpose ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 48)
		.replace(/_+$/, "");
	if (slug.replace(/_/g, "").length >= 4) return slug;

	const pad = (value: number): string => String(value).padStart(2, "0");
	const now = new Date();
	return `script_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function renderList(dir: string, scripts: ScriptInfo[]): string {
	if (scripts.length === 0) {
		return `No scripts written in this session yet. They are stored in ${dir} and cleared on reboot.`;
	}
	const rows = scripts.map((script) => {
		const exit = script.lastExitCode === undefined ? "never run" : `exit ${script.lastExitCode}`;
		const purpose = script.purpose ? `  — ${script.purpose}` : "";
		return `${script.name}  ${script.bytes} B  ${script.runs} run(s)  ${exit}${purpose}`;
	});
	return [`Scripts in this session (${dir}):`, ...rows].join("\n");
}

/**
 * The scripts a `create` is about to become a sibling of, most recently run first.
 *
 * Deliberately no similarity scoring: purposes arrive in whatever language the user
 * speaks, and a fuzzy match would sometimes assert that two unrelated scripts are
 * related. Naming the neighbours and letting the model judge relevance costs one line
 * and stays honest — but it is the only thing that makes re-use possible once the
 * earlier script has fallen out of the model's context, which is where re-use pays.
 * Set `PI_IPY_QUIET=1` to switch off everything this result says about re-use — the two
 * lines below are the whole re-use nudge, and scripts/acc-reuse.sh measures them as a unit —
 * at n=25 per arm the two arms came out 8/25 vs 7/25 (p=1.00), so these lines hand the path
 * back to the model rather than change what it does (docs/memory/known-pitfalls.md).
 */
async function otherScripts(dir: string, scriptPath: string, limit = 3): Promise<string[]> {
	if (process.env.PI_IPY_QUIET) return [];
	const scripts = await listScripts(dir).catch(() => []);
	return scripts
		.filter((script) => script.path !== scriptPath)
		.sort((a, b) => (b.lastRunAt ?? "").localeCompare(a.lastRunAt ?? ""))
		.slice(0, limit)
		.map((script) => `${script.name}${script.purpose ? ` — ${script.purpose}` : ""}`);
}

function renderRun(options: {
	scriptPath: string;
	state: string;
	result: RunResult;
	timeoutSeconds?: number;
	fullOutputPath?: string;
	alsoInSession?: string[];
	/** Set for `create`: repeat the one instruction the next turn will need. */
	suggestEdit?: boolean;
}): string {
	const { result } = options;
	const lines = [`script: ${options.scriptPath} (${options.state})`];

	const meta = [`exit: ${result.exitCode}`, `${result.wallTimeSeconds.toFixed(2)}s`];
	if (result.timedOut) meta.push(`killed: timed out after ${options.timeoutSeconds}s`);
	else if (result.aborted) meta.push("killed: aborted");
	lines.push(meta.join(" · "));
	if (options.alsoInSession?.length) {
		lines.push(`also in this session: ${options.alsoInSession.join(" | ")}`);
	}
	if (options.suggestEdit) {
		// The guideline says this too, but it is read once at the top of the session, while
		// this line is read on the turn *before* the one where re-sending the code is the
		// tempting move. Measured: without it the model re-sent the code in 2 of 3 sessions
		// that had the script one turn back in context.
		lines.push(`to change it: edit that file, then ipy({path: "${options.scriptPath}"}) — don't send the code again`);
	}

	const stdout = result.stdout.replace(/\n+$/, "");
	const stderr = result.stderr.replace(/\n+$/, "");
	if (stdout) lines.push("--- stdout ---", stdout);
	if (stderr) lines.push("--- stderr ---", stderr);
	if (!stdout && !stderr) lines.push("(no output)");
	if (options.fullOutputPath) lines.push(`full output: ${options.fullOutputPath}`);
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "ipy",
		label: "ipy",
		description:
			`Write a Python script to a temp file and run it with ${pythonPath()}. ` +
			"Pass `code` to create or replace a script, `path` to re-run one created earlier, or `list: true` to see this session's scripts. " +
			"The script path comes back, so you can edit that file and re-run it instead of re-sending the code. " +
			"Arguments go through argv (`args`), so there is no shell quoting. " +
			`Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} (whichever is hit first); when truncated, the full output is saved to a file.`,
		promptSnippet: "Run Python scripts; writes them to a temp file you can re-run and edit",
		promptGuidelines: [
			"Use ipy for anything beyond a trivial one-liner: parsing, data munging, loops, HTTP, CSV/JSON work. Use bash only for short file/shell operations (ls, rg, git, cat).",
			"ipy returns the script path: re-run it with ipy({path}) and edit that file instead of re-writing the code.",
		],
		parameters: ipySchema,
		outputSchema: ipyOutputSchema,
		annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const mode = parseInput(params);
			const dir = await sessionDir(ctx.cwd, ctx.sessionManager.getSessionId());

			if (mode.kind === "list") {
				const scripts = await listScripts(dir);
				const text = renderList(dir, scripts);
				return {
					content: [{ type: "text", text }],
					details: { mode: "list", dir, exitCode: 0, wallTimeSeconds: 0 } satisfies IpyDetails,
					structuredContent: {
						exit_code: 0,
						stdout: text,
						stderr: "",
						reused: false,
						wall_time_seconds: 0,
						timed_out: false,
						aborted: false,
					},
				};
			}

			let scriptPath: string;
			let hash: string;
			let state: string;
			let reused = false;
			let alsoInSession: string[] = [];

			if (mode.kind === "create") {
				const saved = await saveScript(dir, mode.name ?? fallbackName(mode.purpose), mode.code);
				scriptPath = saved.path;
				hash = saved.hash;
				reused = saved.reused;
				state = reused ? "already on disk, unchanged" : "written";
				alsoInSession = await otherScripts(dir, scriptPath);
			} else {
				scriptPath = resolve(ctx.cwd, mode.path);
				const info = await lstat(scriptPath).catch(() => undefined);
				if (!info?.isFile()) {
					throw new Error(
						`ipy: no script at ${scriptPath}. Temp scripts are cleared on reboot — ` +
							"call ipy({list:true}) to see what exists in this session, or write it again with ipy({code}).",
					);
				}
				hash = await hashFile(scriptPath);
				state = "existing script";
			}

			const result = await runPython({
				pythonPath: pythonPath(),
				scriptPath,
				args: mode.args,
				cwd: ctx.cwd,
				timeoutMs: mode.timeoutMs,
				signal,
			});

			await appendManifest(dir, {
				ts: new Date().toISOString(),
				name: scriptPath.split("/").pop() ?? scriptPath,
				path: scriptPath,
				hash,
				purpose: mode.kind === "create" ? mode.purpose : undefined,
				mode: mode.kind,
				reused,
				exitCode: result.exitCode,
				wallTimeSeconds: result.wallTimeSeconds,
			});

			const stdout = result.stdout.replace(/\n+$/, "");
			const stderr = result.stderr.replace(/\n+$/, "");
			const combined = [stdout, stderr].filter(Boolean).join("\n");
			const view = truncateTail(combined, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });

			let fullOutputPath: string | undefined;
			if (view.truncated) {
				fullOutputPath = await saveFullOutput(dir, scriptPath, combined);
			}

			const text = renderRun({
				scriptPath,
				state,
				result,
				timeoutSeconds: mode.timeoutMs === undefined ? undefined : mode.timeoutMs / 1000,
				fullOutputPath,
				alsoInSession,
				suggestEdit: mode.kind === "create" && !process.env.PI_IPY_QUIET,
			});

			return {
				content: [{ type: "text", text }],
				details: {
					mode: mode.kind,
					scriptPath,
					reused,
					exitCode: result.exitCode,
					wallTimeSeconds: result.wallTimeSeconds,
					timedOut: result.timedOut,
				} satisfies IpyDetails,
				isError: result.exitCode !== 0,
				structuredContent: {
					exit_code: result.exitCode,
					stdout: truncateHead(result.stdout, { maxLines: DEFAULT_MAX_LINES, maxBytes: CODEMODE_MAX_BYTES }).content,
					stderr: truncateHead(result.stderr, { maxLines: DEFAULT_MAX_LINES, maxBytes: CODEMODE_MAX_BYTES }).content,
					script_path: scriptPath,
					reused,
					wall_time_seconds: result.wallTimeSeconds,
					...(fullOutputPath ? { output_path: fullOutputPath } : {}),
					timed_out: result.timedOut,
					aborted: result.aborted,
				},
			};
		},
	});
}
