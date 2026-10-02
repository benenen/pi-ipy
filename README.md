# pi-ipy

A Python scratchpad for [pi](https://github.com/earendil-works/pi-mono). The model
writes a script, ipy stores it in a temp file, runs it, and hands the path back — so
the next run is an `edit` and a re-run instead of another 40-line heredoc.

```
before   bash -c "python3 - <<'EOF'
         import json, collections
         … 40 lines …
         EOF"

after    ipy({ name: "tool_calls_by_session",
               purpose: "top-3 tools per pi session file",
               code: "… 40 lines …" })
         # → script path: /tmp/pi-ipy-1000/pi-ipy-1a2b3c4d/tool_calls_by_session.py  exit code: 0
         # next turn: ipy({ path: "…/tool_calls_by_session.py", args: ["--day", "09-30"] })
```

## Tool surface

One tool, three shapes — `code`, `path` and `list` are mutually exclusive:

| call | effect |
| --- | --- |
| `ipy({ code, name?, purpose?, args?, timeout? })` | write the script to disk, then run it |
| `ipy({ path, args?, timeout? })` | run a script an earlier call created |
| `ipy({ list: true })` | list this session's scripts (name, size, run count, last exit code) |

`args` goes through argv, so there is no shell quoting to escape. Output is capped at
pi's own scale (2000 lines / 50 KB, whichever is hit first); when the middle is
elided, the whole thing is written to a file whose path comes back as `output_path`.

## Where scripts live

```
<tmpdir>/pi-ipy-<uid>/<cwd-name>-<sessionId[0:8]>/
    tool_calls_by_session.py
    .index.jsonl
```

- **One root per uid**, so a shared `/tmp` is not writable across users.
- **Named, not hashed.** Real sessions showed the model omitting `name`, and a hashed
  file it cannot remember is a file it cannot re-use — so a missing `name` is slugged
  from `purpose` instead (`top-3 tools per pi session file` → `tool_calls_by_session.py`),
  with a timestamped name as the last resort.
- Same name + same content hash → reused, and said so in the result. Same name + new
  content → replaced. That replacement, plus pi's own `edit`, is how a script changes.
- Writes go through a temp file + `rename`, so a killed process cannot leave half a
  script behind. `.index.jsonl` appends one line per run: timestamp, name, path,
  content hash, purpose, mode, exit code and wall time.

## Execution

- `python3` from `PATH`, or `$PI_IPY_PYTHON` when set; the working directory is pi's.
- The child runs detached in its own process group, and abort/timeout kills the **whole
  group** — a script that spawned something else does not outlive it.
- Results also come back as `structuredContent` (`exit_code`, `stdout`, `stderr`,
  `script_path`, `reused`, `wall_time_seconds`, `timed_out`, `aborted`, `output_path`),
  so [codemode](docs/agents-dot-md/architecture.md) scripts can drive ipy directly —
  QuickJS has no filesystem, Python does.

## Install

pi discovers each **directory** under its agent dir's `extensions/`, so installing is a
symlink and there is no build step and no `node_modules`:

```sh
ln -sfn "$PWD" "${PI_AGENT_DIR:-$HOME/.pi/agent}/extensions/pi-ipy"
```

## Verify

```sh
node scripts/smoke.mjs    # naming, reuse, slug escaping, atomic writes, truncation, abort, timeout
```

The interesting check is process-group teardown: the script spawns a grandchild that
writes to a file on a delay, ipy is aborted, and the test fails if that file appears.

## The part that actually changes behaviour

Shipping a tool does not make the model reach for it — the system prompt does. ipy
carries two of pi's hooks: `promptSnippet` (one line in *Available tools*) and
`promptGuidelines` (two permanent bullets, added only while the tool is loaded):

> Use ipy for anything beyond a trivial one-liner: parsing, data munging, loops, HTTP,
> CSV/JSON work. Use bash only for short file/shell operations (ls, rg, git, cat).

> ipy returns the script path: re-run it with `ipy({path})` and edit that file instead
> of re-writing the code.

Two bullets, not ten: every guideline is permanent context, and piling them up dilutes
all of them. The first one draws a boundary instead of making a request — pi's own rules
already frame bash as a *file* tool (`Use bash for file operations like ls, rg, find`),
so "write a program" was an unowned slot, and ipy takes that slot rather than fighting
bash for the rest.

Measured on the same prompt with ipy on and off (`pi -xt ipy`): without it, the model
pipes 40-line Python heredocs through bash; with it, bash is used only to locate files
and the code goes to ipy. The procedure is written up in
[docs/agents-dot-md/environment.md](docs/agents-dot-md/environment.md).

## Layout

```
index.ts             tool registration: schema, prompt text, mode dispatch
lib/store.ts         script directory, naming, atomic writes, manifest
lib/run.ts           child process, output capture/truncation, group teardown
scripts/smoke.mjs    the test suite
docs/                AGENTS.md-referenced module docs
```
