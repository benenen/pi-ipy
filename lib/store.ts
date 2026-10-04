/**
 * Script storage, name sanitising and manifest for ipy.
 *
 * Layout (under `os.tmpdir()`, one root per uid to avoid a shared-directory
 * race where another user pre-creates the path):
 *
 *   <tmp>/pi-ipy-<uid>/<cwd-name>-<sessionId[0:8]>/
 *       parse_logs.py     model-chosen name; read/edit can open it directly
 *       .index.jsonl      append-only manifest: ts / name / content hash / purpose / exit code
 *
 * Three safety rules (review findings A / B / D):
 *   - `name` comes from the model, so it is basename'd and whitelisted first:
 *     no `../`, no absolute path, no symlink escape;
 *   - directories are 0o700 and must be owned by the current uid; a symlink,
 *     a non-directory or another user's directory is refused;
 *   - writes go through a temp file + rename so a kill never leaves half a script.
 */

import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { Readable, type Writable } from "node:stream";
import { finished, pipeline } from "node:stream/promises";

/** Shared length cap for script and directory names, to bound path length. */
const NAME_MAX = 64;
/** Directory mode: reachable only by the current user. */
const DIR_MODE = 0o700;
/** Mode for scripts and the manifest. */
const FILE_MODE = 0o600;

const ILLEGAL_IN_NAME = /[^A-Za-z0-9._-]+/g;
const ILLEGAL_IN_SEGMENT = /[^A-Za-z0-9_-]+/g;

export interface ScriptInfo {
	/** File name, including `.py`. */
	name: string;
	path: string;
	bytes: number;
	/** Exit code of the most recent run; undefined if never run. */
	lastExitCode?: number;
	/** Purpose most recently supplied by the model. */
	purpose?: string;
	/** Number of runs recorded in the manifest. */
	runs: number;
	/** ISO timestamp of this script's most recent manifest entry. */
	lastRunAt?: string;
}

export interface ManifestEntry {
	ts: string;
	name: string;
	path: string;
	/** Content sha256, truncated to 16 chars: "same name + same hash" means reuse. */
	hash: string;
	purpose?: string;
	mode: "create" | "run" | "edit";
	reused: boolean;
	exitCode: number;
	wallTimeSeconds: number;
}

/**
 * Reduce a model-supplied name to a safe file name.
 * `a/b/../../c.py` -> `c.py`; empty / dots-only / dashes-only is an error, not a guess.
 */
export function sanitizeName(raw: string): string {
	const last = raw.trim().replace(/\\/g, "/").split("/").pop() ?? "";
	let cleaned = last.replace(ILLEGAL_IN_NAME, "_").replace(/^[.-]+/, "");
	if (cleaned.length > NAME_MAX) cleaned = cleaned.slice(0, NAME_MAX);
	cleaned = cleaned.replace(/[.-]+$/, "");
	if (!cleaned || cleaned === ".py") {
		throw new Error(`ipy: unusable script name (empty after sanitising): ${JSON.stringify(raw)}`);
	}
	return cleaned.endsWith(".py") ? cleaned : `${cleaned}.py`;
}

/** Sanitise a single path segment (no separators survive). */
function sanitizeSegment(raw: string): string {
	return raw.replace(ILLEGAL_IN_SEGMENT, "_").replace(/^[.-]+/, "").slice(0, NAME_MAX);
}

/** Assert `target` stays inside `dir` (defence in depth; names are already sanitised). */
function assertInside(dir: string, target: string): void {
	const root = resolve(dir);
	if (target !== root && !target.startsWith(root + sep)) {
		throw new Error(`ipy: refusing to write outside the session directory: ${target}`);
	}
}

/** Create a 0o700, current-user-owned, non-symlink directory; validate it if it exists. */
async function ensurePrivateDir(path: string): Promise<void> {
	let info: Awaited<ReturnType<typeof lstat>>;
	try {
		info = await lstat(path);
	} catch {
		await mkdir(path, { recursive: true, mode: DIR_MODE });
		info = await lstat(path);
	}
	if (info.isSymbolicLink()) throw new Error(`ipy: refusing to use a symlinked directory: ${path}`);
	if (!info.isDirectory()) throw new Error(`ipy: ${path} exists but is not a directory`);
	const uid = process.getuid?.();
	if (uid !== undefined && info.uid !== uid) {
		throw new Error(`ipy: ${path} is owned by uid ${info.uid}, not the current user; refusing to use it`);
	}
	await chmod(path, DIR_MODE);
}

/** This session's script directory, created on demand. */
export async function sessionDir(cwd: string, sessionId: string): Promise<string> {
	const uid = process.getuid?.();
	const root = join(tmpdir(), `pi-ipy-${uid ?? "u"}`);
	await ensurePrivateDir(root);
	const cwdName = sanitizeSegment(basename(resolve(cwd)) || "root") || "root";
	const sid = sanitizeSegment(sessionId).slice(0, 8) || "nosession";
	const dir = join(root, `${cwdName}-${sid}`);
	await ensurePrivateDir(dir);
	return dir;
}

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

/** Read a file, returning undefined when it does not exist. */
async function readIfExists(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export interface SaveResult {
	path: string;
	/** True when name and content both matched the existing file (nothing was written). */
	reused: boolean;
	hash: string;
}

export interface ScriptEdit {
	oldText: string;
	newText: string;
}

/** Apply exact replacements to a session script; caller must hold its file mutation queue. */
export async function editScript(dir: string, path: string, edits: ScriptEdit[]): Promise<SaveResult> {
	const target = resolve(path);
	if (dirname(target) !== resolve(dir) || !target.endsWith(".py")) {
		throw new Error("ipy: edits require a .py file in this session; use ipy({list:true}) to find its path.");
	}
	const info = await lstat(target);
	if (!info.isFile() || info.isSymbolicLink()) {
		throw new Error("ipy: edits require a regular script file; use ipy({list:true}) to find one.");
	}
	const original = await readFile(target, "utf8");
	const changes = edits.map((edit) => {
		const at = original.indexOf(edit.oldText);
		if (at < 0 || original.indexOf(edit.oldText, at + 1) >= 0) {
			throw new Error("ipy: each oldText must occur exactly once; read the script and include more surrounding text.");
		}
		return { at, end: at + edit.oldText.length, text: edit.newText };
	}).sort((a, b) => a.at - b.at);
	for (let i = 1; i < changes.length; i++) {
		if (changes[i].at < changes[i - 1].end) {
			throw new Error("ipy: edits overlap; combine overlapping changes into one replacement.");
		}
	}
	let code = original;
	for (const change of changes.reverse()) {
		code = code.slice(0, change.at) + change.text + code.slice(change.end);
	}
	if (code === original) return { path: target, hash: sha256(code), reused: true };
	const tmp = join(dir, `.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
	try {
		await writeFile(tmp, code, { mode: FILE_MODE });
		await rename(tmp, target);
	} catch (error) {
		await unlink(tmp).catch(() => undefined);
		throw error;
	}
	return { path: target, hash: sha256(code), reused: false };
}

/**
 * Write a script. Same name + same content counts as reuse (file untouched);
 * same name + different content overwrites it — that is how a script gets "edited".
 * Writes are atomic (temp file + rename) and refuse to replace a symlink.
 * Caller must hold the target file mutation queue through execution.
 */
export async function saveScript(dir: string, name: string, code: string): Promise<SaveResult> {
	const target = resolve(dir, sanitizeName(name));
	assertInside(dir, target);
	const hash = sha256(code);
	const existingInfo = await lstat(target).catch(() => undefined);
	if (existingInfo?.isSymbolicLink()) {
		throw new Error(`ipy: ${target} is a symlink, refusing to overwrite it`);
	}
	const existing = existingInfo ? await readIfExists(target) : undefined;
	if (existing !== undefined && sha256(existing) === hash) {
		return { path: target, reused: true, hash };
	}
	const tmp = join(dir, `.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
	try {
		await writeFile(tmp, code, { mode: FILE_MODE });
		await rename(tmp, target);
	} catch (error) {
		await unlink(tmp).catch(() => undefined);
		throw error;
	}
	return { path: target, reused: false, hash };
}

/** Append one manifest entry. O_APPEND write, so parallel writers cannot interleave a short line. */
export async function appendManifest(dir: string, entry: ManifestEntry): Promise<void> {
	const file = join(dir, ".index.jsonl");
	const handle = await open(file, "a", FILE_MODE);
	try {
		await handle.write(`${JSON.stringify(entry)}\n`);
	} finally {
		await handle.close();
	}
}

function isManifestEntry(value: unknown): value is ManifestEntry {
	if (typeof value !== "object" || value === null) return false;
	return "ts" in value && typeof value.ts === "string"
		&& "name" in value && typeof value.name === "string"
		&& "path" in value && typeof value.path === "string"
		&& "hash" in value && typeof value.hash === "string"
		&& (!("purpose" in value) || typeof value.purpose === "string")
		&& "mode" in value && (value.mode === "create" || value.mode === "run" || value.mode === "edit")
		&& "reused" in value && typeof value.reused === "boolean"
		&& "exitCode" in value && typeof value.exitCode === "number" && Number.isFinite(value.exitCode)
		&& "wallTimeSeconds" in value && typeof value.wallTimeSeconds === "number" && Number.isFinite(value.wallTimeSeconds);
}

/** Read the whole manifest; a corrupt line is skipped instead of failing the call. */
export async function readManifest(dir: string): Promise<ManifestEntry[]> {
	const raw = await readIfExists(join(dir, ".index.jsonl"));
	if (!raw) return [];
	const entries: ManifestEntry[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			// Half-written line (process killed mid-write); ignore it.
			continue;
		}
		if (isManifestEntry(entry)) entries.push(entry);
	}
	return entries;
}

/** The `.py` files on disk are the source of truth; the manifest only adds run counts. */
export async function listScripts(dir: string): Promise<ScriptInfo[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const manifest = await readManifest(dir);
	const infos: ScriptInfo[] = [];
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".py")) continue;
		const path = join(dir, entry.name);
		const info = await lstat(path);
		const runs = manifest.filter((item) => item.path === path);
		const last = runs.at(-1);
		infos.push({
			name: entry.name,
			path,
			bytes: info.size,
			lastExitCode: last?.exitCode,
			purpose: [...runs].reverse().find((item) => item.purpose)?.purpose,
			runs: runs.length,
			lastRunAt: last?.ts,
		});
	}
	infos.sort((a, b) => a.name.localeCompare(b.name));
	return infos;
}

export interface OutputCapture {
	stdout: Writable;
	stderr: Writable;
	save(): Promise<string>;
	discard(): Promise<void>;
}

/** Spool both streams to disk; publish their full contents only when a view is truncated. */
export async function createOutputCapture(dir: string, scriptPath: string): Promise<OutputCapture> {
	const outDir = join(dir, ".out");
	await ensurePrivateDir(outDir);
	const base =
		basename(scriptPath)
			.replace(/\.py$/i, "")
			.replace(ILLEGAL_IN_NAME, "_")
			.replace(/^[.-]+/, "")
			.slice(0, NAME_MAX) || "script";
	const target = join(outDir, `${base}-${randomBytes(12).toString("hex")}.out`);
	const stdoutPath = `${target}.stdout`;
	const stderrPath = `${target}.stderr`;
	const stdoutHandle = await open(stdoutPath, "wx", FILE_MODE);
	let stderrHandle: Awaited<ReturnType<typeof open>>;
	try {
		stderrHandle = await open(stderrPath, "wx", FILE_MODE);
	} catch (error) {
		await stdoutHandle.close();
		await unlink(stdoutPath);
		throw error;
	}
	const stdout = stdoutHandle.createWriteStream();
	const stderr = stderrHandle.createWriteStream();
	return {
		stdout,
		stderr,
		async save() {
			async function* sections() {
				let separator = "";
				for (const [path, label] of [[stdoutPath, "stdout"], [stderrPath, "stderr"]]) {
					if ((await lstat(path)).size === 0) continue;
					yield `${separator}--- ${label} ---\n`;
					for await (const chunk of createReadStream(path)) yield chunk;
					separator = "\n";
				}
			}
			const outputHandle = await open(target, "wx", FILE_MODE);
			try {
				await pipeline(Readable.from(sections()), outputHandle.createWriteStream());
			} catch (error) {
				await unlink(target).catch(() => undefined);
				throw error;
			}
			return target;
		},
		async discard() {
			stdout.destroy();
			stderr.destroy();
			// Write failures are reported by runPython; disposal still closes both handles.
			await Promise.all([stdout, stderr].map((sink) => finished(sink, { cleanup: true }).catch(() => undefined)));
			await Promise.all([stdoutPath, stderrPath].map((path) => unlink(path)));
		},
	};
}

/** Content hash for a path-mode run, so the manifest shows when a file was edited. */
export async function hashFile(path: string): Promise<string> {
	const content = await readIfExists(path);
	return content === undefined ? "" : sha256(content);
}
