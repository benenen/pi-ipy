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
import { chmod, lstat, mkdir, open, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

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
	mode: "create" | "run";
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

/**
 * Write a script. Same name + same content counts as reuse (file untouched);
 * same name + different content overwrites it — that is how a script gets "edited".
 * Writes are atomic (temp file + rename) and refuse to replace a symlink.
 */
export async function saveScript(dir: string, name: string, code: string): Promise<SaveResult> {
	const target = resolve(dir, sanitizeName(name));
	assertInside(dir, target);
	const hash = sha256(code);
	return withFileMutationQueue(target, async () => {
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
	});
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

/** Read the whole manifest; a corrupt line is skipped instead of failing the call. */
export async function readManifest(dir: string): Promise<ManifestEntry[]> {
	const raw = await readIfExists(join(dir, ".index.jsonl"));
	if (!raw) return [];
	const entries: ManifestEntry[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			entries.push(JSON.parse(line) as ManifestEntry);
		} catch {
			// Half-written line (process killed mid-write); ignore it.
		}
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
		const runs = manifest.filter((item) => item.name === entry.name);
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

/**
 * Persist the full output next to the scripts, for the case where the model-facing
 * view had to be truncated. Returns the path handed back to the model.
 */
export async function saveFullOutput(dir: string, scriptPath: string, text: string): Promise<string> {
	const outDir = join(dir, ".out");
	await mkdir(outDir, { recursive: true, mode: DIR_MODE });
	const base =
		basename(scriptPath)
			.replace(/\.py$/i, "")
			.replace(ILLEGAL_IN_NAME, "_")
			.replace(/^[.-]+/, "")
			.slice(0, NAME_MAX) || "script";
	const target = join(outDir, `${base}.out`);
	return withFileMutationQueue(target, async () => {
		await writeFile(target, text, { mode: FILE_MODE });
		return target;
	});
}

/** Content hash for a path-mode run, so the manifest shows when a file was edited. */
export async function hashFile(path: string): Promise<string> {
	const content = await readIfExists(path);
	return content === undefined ? "" : sha256(content);
}
