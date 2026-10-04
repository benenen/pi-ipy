/**
 * Running a Python script as a child process.
 *
 * - `detached: true` gives the child its own process group, so abort/timeout can
 *   kill the whole tree with `process.kill(-pid)` instead of orphaning grandchildren.
 * - stdout and stderr are captured separately. Interleaving between the two streams
 *   is not preserved by the OS, so they are reported as separate sections rather
 *   than pretending to be one merged stream.
 * - Each stream is capped at `STREAM_CAP_BYTES` by dropping the middle, so a runaway
 *   script cannot exhaust memory and take the machine down with it.
 * - Decoding goes through `StringDecoder`, so a chunk boundary never splits a
 *   multi-byte character (matters for non-ASCII output).
 * - The reported exit code follows shell convention: a script killed by a signal is
 *   reported as 128 + signal number (SIGKILL -> 137, anything else -> 143), so a
 *   caller can tell "the script failed" from "the script was killed".
 */

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

/** Hard ceiling on what is retained per stream. */
export const STREAM_CAP_BYTES = 4 * 1024 * 1024;
const HALF_CAP = STREAM_CAP_BYTES / 2;
/** How long a terminated script gets to die on its own before SIGKILL. */
const KILL_GRACE_MS = 2000;

/** Split `text` at a byte budget without cutting a code point in half. */
function splitByBytes(text: string, maxBytes: number): { kept: string; rest: string } {
	let kept = "";
	let used = 0;
	let index = 0;
	for (const point of text) {
		const size = Buffer.byteLength(point, "utf8");
		if (used + size > maxBytes) return { kept, rest: text.slice(index) };
		kept += point;
		used += size;
		index += point.length;
	}
	return { kept, rest: "" };
}

/**
 * Collects a stream while capping memory: fills `head` to half the cap, then keeps a
 * rolling `tail`, and reports how many bytes were dropped from the middle.
 */
class CappedText {
	private readonly decoder = new StringDecoder("utf8");
	private readonly head: string[] = [];
	private readonly tail: string[] = [];
	private headBytes = 0;
	private tailBytes = 0;
	/** Total bytes received, retained or not. */
	private receivedBytes = 0;

	push(chunk: Buffer): void {
		this.receivedBytes += chunk.length;
		this.emitText(this.decoder.write(chunk));
	}

	finish(): { text: string; truncated: boolean } {
		this.emitText(this.decoder.end());
		const omitted = this.receivedBytes - this.headBytes - this.tailBytes;
		const head = this.head.join("");
		const tail = this.tail.join("");
		if (omitted <= 0) return { text: head + tail, truncated: false };
		return { text: `${head}\n…[ipy: ${omitted} bytes omitted]…\n${tail}`, truncated: true };
	}

	private emitText(text: string): void {
		if (!text) return;
		if (this.headBytes >= HALF_CAP) {
			this.pushTail(text);
			return;
		}
		const room = HALF_CAP - this.headBytes;
		const size = Buffer.byteLength(text, "utf8");
		if (size <= room) {
			this.head.push(text);
			this.headBytes += size;
			return;
		}
		const { kept, rest } = splitByBytes(text, room);
		this.head.push(kept);
		this.headBytes += Buffer.byteLength(kept, "utf8");
		if (rest) this.pushTail(rest);
	}

	private pushTail(text: string): void {
		this.tail.push(text);
		this.tailBytes += Buffer.byteLength(text, "utf8");
		while (this.tailBytes > HALF_CAP && this.tail.length > 1) {
			this.tailBytes -= Buffer.byteLength(this.tail.shift() ?? "", "utf8");
		}
	}
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		// Negative pid targets the process group led by the detached child.
		process.kill(-pid, signal);
	} catch {
		// No group (spawn never completed), fall back to the process itself.
		try {
			process.kill(pid, signal);
		} catch {
			// Already dead.
		}
	}
}

export interface RunOptions {
	pythonPath: string;
	scriptPath: string;
	args: string[];
	cwd: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface RunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	wallTimeSeconds: number;
	timedOut: boolean;
	aborted: boolean;
}

/** Run `pythonPath -u scriptPath args...` and resolve once the process is gone. */
export function runPython(options: RunOptions): Promise<RunResult> {
	return new Promise<RunResult>((resolveRun) => {
		const startedAt = Date.now();
		const stdout = new CappedText();
		const stderr = new CappedText();
		let timedOut = false;
		let aborted = false;
		let settled = false;
		let timeoutTimer: NodeJS.Timeout | undefined;
		let killTimer: NodeJS.Timeout | undefined;

		const child = spawn(options.pythonPath, ["-u", options.scriptPath, ...options.args], {
			cwd: options.cwd,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});

		const terminate = (why: "timeout" | "abort"): void => {
			if (settled) return;
			if (why === "timeout") timedOut = true;
			else aborted = true;
			if (killTimer !== undefined) return;
			if (child.pid !== undefined) killGroup(child.pid, "SIGTERM");
			// Escalate if the script (or a child of it) ignores SIGTERM.
			killTimer = setTimeout(() => {
				if (child.pid !== undefined) killGroup(child.pid, "SIGKILL");
			}, KILL_GRACE_MS);
			killTimer.unref?.();
		};

		const onAbort = (): void => terminate("abort");
		if (options.signal) {
			if (options.signal.aborted) onAbort();
			else options.signal.addEventListener("abort", onAbort, { once: true });
		}
		if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
			timeoutTimer = setTimeout(() => terminate("timeout"), options.timeoutMs);
			timeoutTimer.unref?.();
		}

		const settle = (exitCode: number): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutTimer);
			// The parent may close its pipes while TERM-ignoring descendants are still alive.
			if ((timedOut || aborted) && child.pid !== undefined) killGroup(child.pid, "SIGKILL");
			clearTimeout(killTimer);
			options.signal?.removeEventListener("abort", onAbort);
			const out = stdout.finish();
			const err = stderr.finish();
			resolveRun({
				exitCode,
				stdout: out.text,
				stderr: err.text,
				stdoutTruncated: out.truncated,
				stderrTruncated: err.truncated,
				wallTimeSeconds: (Date.now() - startedAt) / 1000,
				timedOut,
				aborted,
			});
		};

		child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.on("error", (error: Error) => {
			// Most commonly ENOENT: the interpreter is not on PATH.
			stderr.push(Buffer.from(`failed to start ${options.pythonPath}: ${error.message}\n`, "utf8"));
			settle(-1);
		});
		child.on("close", (code, signal) => {
			// 128 + signal number, matching shell convention.
			settle(code ?? (signal === "SIGKILL" ? 137 : signal ? 143 : -1));
		});
	});
}
