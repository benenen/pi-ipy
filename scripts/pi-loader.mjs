import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PI_PACKAGE = "@earendil-works/pi-coding-agent";

/** Locate the pi package inside the installation that owns the `pi` binary. */
export async function resolvePiEntry() {
	if (process.env.PI_PACKAGE_ENTRY) return process.env.PI_PACKAGE_ENTRY;
	const which = await execFileAsync("which", ["pi"])
		.then(({ stdout }) => stdout.trim())
		.catch(() => {
			throw new Error("cannot find the `pi` executable on PATH; set PI_PACKAGE_ENTRY to its dist/index.js");
		});
	// `pi` may be a shim in <prefix>/bin or a symlink straight into the package; walk up
	// from both and identify the package by its manifest rather than by guessing a layout.
	for (const start of [which, await realpath(which).catch(() => which)]) {
		let dir = dirname(start);
		for (;;) {
			const manifest = join(dir, "package.json");
			if (existsSync(manifest)) {
				try {
					if (JSON.parse(readFileSync(manifest, "utf8")).name === PI_PACKAGE) {
						const entry = join(dir, "dist/index.js");
						if (existsSync(entry)) return entry;
					}
				} catch {
					// unreadable or malformed manifest: keep walking up
				}
			}
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}
	throw new Error(`cannot locate ${PI_PACKAGE} from \`pi\` at ${which}; set PI_PACKAGE_ENTRY to its dist/index.js`);
}
