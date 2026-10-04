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

import { createHash, randomBytes } from "node:crypto";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
	formatSize,
	truncateHead,
	truncateTail,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { type RunResult, runPython } from "./lib/run.ts";
import {
	appendManifest,
	editScript,
	hashFile,
	listScripts,
	saveFullOutput,
	saveScript,
	sanitizeName,
	type ScriptInfo,
	type ScriptEdit,
	sessionDir,
} from "./lib/store.ts";

/** How much of each stream script callers (codemode) receive. */
const CODEMODE_MAX_BYTES = 1024 * 1024;
/** Node timers accept at most a signed 32-bit millisecond delay. */
const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000;

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
	edits: Type.Optional(Type.Array(Type.Object({
		oldText: Type.String({ minLength: 1 }),
		newText: Type.String(),
	}), { minItems: 1, description: "With path: edit and run in one call. Each oldText must match once in the original file; edits must not overlap. Send only changed text." })),
	args: Type.Optional(Type.Array(Type.String(), { description: "Arguments passed to the script via argv." })),
	timeout: Type.Optional(
		Type.Number({ description: "Kill the script after this many seconds. Omit for no limit." }),
	),
	list: Type.Optional(
		Type.Boolean({ description: "List the scripts written in this session instead of running one." }),
	),
});

type IpyInput = Static<typeof ipySchema>;

const ipyOutputSchema = Type.Object({
	exit_code: Type.Number(),
	stdout: Type.String({ description: "Captured stdout, head-truncated to 1 MiB / 2000 lines" }),
	stderr: Type.String({ description: "Captured stderr, head-truncated to 1 MiB / 2000 lines" }),
	script_path: Type.Optional(Type.String()),
	reused: Type.Boolean({ description: "True when the script was already on disk with identical content" }),
	wall_time_seconds: Type.Number(),
	output_path: Type.Optional(Type.String({ description: "Full output on disk when the text view was truncated" })),
	timed_out: Type.Boolean(),
	aborted: Type.Boolean(),
});

interface IpyDetails {
	mode: "list" | "create" | "run" | "edit";
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
	| { kind: "run"; path: string; edits?: ScriptEdit[]; args: string[]; timeoutMs?: number };

function parseInput(params: IpyInput): Mode {
	const code = params.code?.trim();
	const path = params.path?.trim();
	if (params.edits !== undefined) {
		if (!path || code || params.list === true) {
			throw new Error("ipy: edits must be combined with path only; use ipy({path, edits}).");
		}
		if (!Array.isArray(params.edits) || params.edits.length === 0 || params.edits.some(
			(edit) => !edit || typeof edit.oldText !== "string" || !edit.oldText.length || typeof edit.newText !== "string",
		)) {
			throw new Error("ipy: edits must be a non-empty array of {oldText, newText}; oldText cannot be empty.");
		}
	}

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
	if (params.timeout !== undefined && params.timeout > MAX_TIMEOUT_SECONDS) {
		throw new Error(`ipy: timeout exceeds ${MAX_TIMEOUT_SECONDS} seconds; reduce it or omit timeout for no limit.`);
	}
	const timeoutMs = params.timeout === undefined ? undefined : Math.max(1, Math.ceil(params.timeout * 1000));

	if (code) {
		return { kind: "create", code, name: params.name, purpose: params.purpose, args, timeoutMs };
	}
	return { kind: "run", path: path as string, edits: params.edits, args, timeoutMs };
}

/**
 * Fallback name for `code` calls that omit `name`.
 *
 * Prefers a slug of `purpose`: real sessions show the model omitting `name`, and a
 * semantic file name is what makes the script findable again 40 turns later. A
 * purpose hash handles non-ASCII notes; a timestamp plus random suffix is the last
 * resort when no purpose was supplied.
 */
function fallbackName(purpose?: string): string {
	const slug = (purpose ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 48)
		.replace(/_+$/, "");
	if (slug.replace(/_/g, "").length >= 4) return slug;
	if (purpose?.trim()) {
		return `script_${createHash("sha256").update(purpose.trim(), "utf8").digest("hex").slice(0, 16)}`;
	}

	const pad = (value: number): string => String(value).padStart(2, "0");
	const now = new Date();
	return `script_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}_${randomBytes(6).toString("hex")}`;
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
	outputView: string;
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
		// Put the path and the single-call edit form next to the script output.
		// The earlier edit-then-run reminder had no demonstrated effect at n=25 per arm.
		lines.push(`to change it: ipy({path: "${options.scriptPath}", args: [...]}) for options, or add edits: [{oldText, newText}] for code changes — don't send the code again`);
	}

	lines.push(options.outputView || "(no output)");
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
			"To change a session script, pass path + edits [{oldText, newText}] to edit and run in one call. " +
			"Arguments go through argv (`args`), so there is no shell quoting. " +
			`Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} (whichever is hit first); when truncated, the full output is saved to a file.`,
		promptSnippet: "Run Python scripts; writes them to a temp file you can re-run and edit",
		promptGuidelines: [
			"Use ipy for anything beyond a trivial one-liner: parsing, data munging, loops, HTTP, CSV/JSON work. Use bash only for short file/shell operations (ls, rg, git, cat).",
			"Put changing inputs/options in argv. Re-run with ipy({path,args}); for code changes use ipy({path,edits:[{oldText,newText}]}) instead of re-sending code.",
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

			const scriptName = mode.kind === "create" ? mode.name ?? fallbackName(mode.purpose) : "";
			const scriptPath = mode.kind === "create" ? resolve(dir, sanitizeName(scriptName)) : resolve(ctx.cwd, mode.path);
			// Hold the same queue as host edits/writes until this version has finished running.
			return withFileMutationQueue(scriptPath, async () => {
				let hash: string;
				let state: string;
				let reused = false;
				let alsoInSession: string[] = [];

				if (mode.kind === "create") {
					const saved = await saveScript(dir, scriptName, mode.code);
					hash = saved.hash;
					reused = saved.reused;
					state = reused ? "already on disk, unchanged" : "written";
					alsoInSession = await otherScripts(dir, scriptPath);
				} else {
					const info = await lstat(scriptPath).catch(() => undefined);
					if (!info?.isFile()) {
						throw new Error(
							`ipy: no script at ${scriptPath}. Temp scripts are cleared on reboot — ` +
								"call ipy({list:true}) to see what exists in this session, or write it again with ipy({code}).",
						);
					}
					if (mode.edits) {
						const saved = await editScript(dir, scriptPath, mode.edits);
						hash = saved.hash;
						reused = saved.reused;
						state = "edited and run";
					} else {
						hash = await hashFile(scriptPath);
						state = "existing script";
					}
				}
				const runMode = mode.kind === "run" && mode.edits ? "edit" : mode.kind;

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
					mode: runMode,
					reused,
					exitCode: result.exitCode,
					wallTimeSeconds: result.wallTimeSeconds,
				});

				const stdout = result.stdout.replace(/\n+$/, "");
				const stderr = result.stderr.replace(/\n+$/, "");
				const combined = [stdout ? `--- stdout ---\n${stdout}` : "", stderr ? `--- stderr ---\n${stderr}` : ""].filter(Boolean).join("\n");
				const view = truncateTail(combined, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });

				let fullOutputPath: string | undefined;
				if (view.truncated) {
					fullOutputPath = await saveFullOutput(dir, scriptPath, combined);
				}

				const text = renderRun({
					scriptPath,
					state,
					result,
					outputView: view.content,
					timeoutSeconds: mode.timeoutMs === undefined ? undefined : mode.timeoutMs / 1000,
					fullOutputPath,
					alsoInSession,
					suggestEdit: mode.kind === "create" && !process.env.PI_IPY_QUIET,
				});

				return {
					content: [{ type: "text", text }],
					details: {
						mode: runMode,
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
			});
		},
	});
}
