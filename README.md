# pi-ipy

A Python scratchpad for [pi](https://github.com/earendil-works/pi-mono). The model
writes a script, ipy stores it in a temp file, runs it, and hands the path back — so
the next run *can* be an `edit` and a re-run instead of another 40-line heredoc. Whether
it actually is one is measured, not assumed (about 1 time in 3 — and what it does instead
is mostly re-send the file under the same name — see
[Re-use](#re-use-works-as-a-rewrite-rather-than-an-edit)).

```
before   bash -c "python3 - <<'EOF'
         import json, collections
         … 40 lines …
         EOF"

after    ipy({ name: "tool_calls_by_session",
               purpose: "top-3 tools per pi session file",
               code: "… 40 lines …" })
         # → script: /tmp/pi-ipy-1000/ipy-acc-01a0fd2b/tool_calls_by_session.py (written)
         #           exit: 0 · 0.31s
         #           to change it: edit that file, then ipy({path: "…"}) — don't send the code again
         # next turn: edit that file, ipy({ path: "…/tool_calls_by_session.py", args: ["--day", "09-30"] })
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

## Re-use works, as a rewrite rather than an edit

Handing back a path is not enough to make the model *edit* the script — but it turns out
nothing is. Measured with `scripts/acc-reuse.sh` (write a script, then ask for a change the
model cannot work out in its head, model pinned, 25 sessions per arm): the intended `edit`
+ `ipy({path})` happened in **8 of 25** sessions with the two lines below and **7 of 25**
with `PI_IPY_QUIET=1` — `p = 1.00`, a dead heat. An earlier wording of the second turn gave
the same answer (4/11 vs 3/14), so this is not a sample-size artefact.

What the model does instead is re-send the whole script under the **same name** (13 of 25 in
both arms; 24 of 27 session-turns in an earlier sample), which `saveScript` treats as an
overwrite. The file ends up current either way — **21 of 25** vs **20 of 25** — and no
duplicate scripts pile up, so the price of a rewrite is re-sent tokens rather than a stale
or littered directory: a genuinely stale script is rare (**3 of 25** in both arms). The
bytes that hurt are the ones re-sent *inside one turn* — one session sent five full versions
— which costs more than the turn-2 decision everyone worries about. So a `create` result
still carries two extra lines:

```
also in this session: parse_logs.py — parse NVR logs | fetch_week.py — pull one week

to change it: edit that file, then ipy({path: "/tmp/…/tool_calls_by_session.py"}) — don't send the code again
```

The first line names the session's other scripts (most recently run first, at most three,
no similarity scoring — purposes come in whatever language the user speaks, and a fuzzy
match would assert relationships that are not there). The second repeats the instruction
that matters on the *next* turn, where the guideline at the top of the session is far away;
the A/B above says that repetition changes nothing measurable, so treat it as a reminder
that hands the path back rather than as a lever. `PI_IPY_QUIET=1` switches both off, which
is how the arms of `scripts/acc-reuse.sh` are defined.

## Execution

- `python3` from `PATH`, or `$PI_IPY_PYTHON` when set; the working directory is pi's.
  `$PI_IPY_QUIET` turns off the two re-use lines in the result (for A/B measurement).
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
node scripts/smoke.mjs    # 50 checks: naming, reuse, slug escaping, atomic writes, truncation, abort, timeout
```

The interesting check is process-group teardown: the script spawns a grandchild that
writes to a file on a delay, ipy is aborted, and the test fails if that file appears.

All 50 green only proves the tool *works*. Whether the model *uses* it is a different
question, and one run cannot answer it — the same prompt on the same model with a
byte-identical system prompt used ipy 3 times out of 4 one afternoon and 0 times out of 5
the next. Two harnesses report rates instead of anecdotes, and both pin the model:

```sh
bash scripts/acc-rate.sh  <model> 4              # does it reach for ipy, or for a heredoc?
bash scripts/acc-rate.sh  <model> 4 -xt ipy      # baseline: ipy not loaded
bash scripts/acc-reuse.sh <model> 3              # edit + re-run, or send the code again?
PI_IPY_QUIET=1 bash scripts/acc-reuse.sh <model> 3   # the same, without the re-use lines
```

Measured so far (`deepseek-v4.1-flash`, small n, read as direction not proof): 3/4 runs
reached for ipy with 0/4 python heredocs; the baseline solved 3/4 prompts in plain shell,
so that prompt cannot show displacement. Attribution is written up in
[docs/agents-dot-md/environment.md](docs/agents-dot-md/environment.md).

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

Measured on the same prompt with ipy on and off, over several runs each (`pi -xt ipy` for
the baseline): without it the model pipes Python through bash heredocs; with it, bash is
left for locating files and the code goes to ipy. The rate is high but not 100%, and the
same prompt is what determines whether the baseline *needs* Python at all — the procedure
and the numbers are in [docs/agents-dot-md/environment.md](docs/agents-dot-md/environment.md).

## Layout

```
index.ts             tool registration: schema, prompt text, mode dispatch
lib/store.ts         script directory, naming, atomic writes, manifest
lib/run.ts           child process, output capture/truncation, group teardown
scripts/smoke.mjs    the test suite (no model call, no API key)
scripts/acc-rate.sh  pilot study: how often does the model reach for ipy?
scripts/acc-reuse.sh A/B harness: does it edit the script, or re-send the code?
docs/                AGENTS.md-referenced module docs
```
