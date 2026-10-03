#!/usr/bin/env bash
# Does the model edit the script, or pay for the same code twice?
#
#   scripts/acc-reuse.sh <model> <reps> [extra pi flags...]
#
# Two turns inside one session. Turn 1 asks for work that genuinely wants a parser, so a
# script is worth writing. Turn 2 asks for a *small change* to what turn 1 produced — the
# moment the whole design is for: `edit <script>` + `ipy({path})` is re-use, a second
# `ipy({code})` is a rewrite, and a python heredoc in bash is the baseline the tool exists
# to displace.
#
# Turn 2 must ask for something that cannot be derived from what turn 1 printed: the first
# version of it ("keep the top 3 and add percentages") invited mental arithmetic on five
# numbers already on screen, and one run answered without calling any tool at all while
# claiming "脚本已更新" — a file it never touched. A median averages nothing away, so it
# forces a re-read of the data. (It did not change the outcome — stale scripts were 3/25 in
# both arms — the point is that a judge must not be answerable from memory.)
#
# One rep proves nothing, and neither does n=11: at n=25 per arm this harness answered
# 8/25 vs 7/25 on the strictest verdict (Fisher p=1.00), so the re-use lines in a `create`
# result are a reminder that hands the path back, not a lever. The noise floor is what made
# that hard to see: turn 1, which the lines cannot touch, differed 19 vs 27 re-sent scripts
# between the same two arms. Read the numbers in docs/memory/known-pitfalls.md before
# drawing a conclusion. Pin the model — the rate is model-specific.
set -euo pipefail

MODEL="${1:?usage: acc-reuse.sh <model> <reps> [extra pi flags...]}"
REPS="${2:?usage: acc-reuse.sh <model> <reps> [extra pi flags...]}"
shift 2

AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
SLUG="$(printf '%s%s' "$MODEL" "$*" | tr -c '[:alnum:]' '-')"
# The two arms must not share a directory: PI_IPY_QUIET=1 is the control, and two arms started
# in the same second used to compute the same $OUT and overwrite each other's rep*.json — a
# silent way to measure nothing while both logs look healthy. Label the arm, and keep $$ so a
# re-run cannot land in an existing directory either.
if [ -n "${PI_IPY_QUIET:-}" ]; then ARM=quiet; else ARM=nudge; fi
OUT="/tmp/ipy-acc/reuse-$SLUG-$ARM-$(date +%H%M%S)-$$"
if [ -e "$OUT" ]; then echo "refusing to reuse $OUT" >&2; exit 1; fi
mkdir -p "$OUT/sessions"
cd /tmp/ipy-acc # neutral cwd: no repo AGENTS.md in the context

# Real fields of a pi session log: assistant messages carry `usage.totalTokens`, and their
# content holds `{type:"toolCall", name, arguments}` items. Aggregating one against the
# other needs an actual parse — that is deliberate.
TURN1="读 $AGENT_DIR/sessions 下最新的那个 .jsonl 会话文件：按 assistant 消息里 toolCall.name 汇总每个工具的调用次数，再算出每条带该工具调用的 assistant 消息的 usage.totalTokens 平均值，按平均值从高到低列出前 5 个工具及各自调用次数。"
TURN2="改一下：把平均值换成中位数，仍然只保留前 3 个。"

for i in $(seq 1 "$REPS"); do
	sid="r$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')-reuse"
	echo "$sid" >"$OUT/rep$i.sid"
	pi -p --mode json --model "$MODEL" "$@" --session-dir "$OUT/sessions" --session-id "$sid" "$TURN1" >"$OUT/rep$i.turn1.json" 2>"$OUT/rep$i.turn1.err" ||
		echo "rep$i turn1: pi exited $?"
	pi -p --mode json --model "$MODEL" "$@" --session-dir "$OUT/sessions" --session-id "$sid" "$TURN2" >"$OUT/rep$i.turn2.json" 2>"$OUT/rep$i.turn2.err" ||
		echo "rep$i turn2: pi exited $?"
	printf 'rep%s done\n' "$i"
done

python3 - "$OUT" "$REPS" "$MODEL" <<'PY'
import glob, json, os, re, sys

out, reps, model = sys.argv[1], int(sys.argv[2]), sys.argv[3]
SCRIPT_PATH = re.compile(r"script: (/tmp/\S+\.py)")


def calls(path):
    """[(toolName, args)] in order, as the harness saw them."""
    seen = []
    for line in open(path, encoding="utf-8", errors="replace"):
        try:
            e = json.loads(line)
        except Exception:
            continue
        if e.get("type") == "tool_execution_start":
            seen.append((e.get("toolName"), e.get("args") or {}))
    return seen


def run_script_path(path):
    text = open(path, encoding="utf-8", errors="replace").read()
    hits = SCRIPT_PATH.findall(text)
    return os.path.basename(hits[-1]) if hits else None


reuse = stale = rewrite = bash = none = 0
print(f"\nmodel: {model}   flags: {' '.join(sys.argv[4:]) or '(none)'}   reps: {reps}")
for i in range(1, reps + 1):
    t1, t2 = f"{out}/rep{i}.turn1.json", f"{out}/rep{i}.turn2.json"
    c1, c2 = calls(t1), calls(t2)
    made = [n for n, _ in c1 if n == "ipy"]
    heredoc1 = sum(1 for n, a in c1 if n == "bash" and "python3" in str(a.get("command", "")) and "<<" in str(a.get("command", "")))
    script = run_script_path(t1)

    edited = [n for n, a in c2 if n in ("edit", "write") and (script or "") in json.dumps(a)]
    ipy_path = [a for n, a in c2 if n == "ipy" and a.get("path")]
    ipy_code = [a for n, a in c2 if n == "ipy" and a.get("code")]
    heredoc2 = sum(1 for n, a in c2 if n == "bash" and "python3" in str(a.get("command", "")) and "<<" in str(a.get("command", "")))
    lines = [len(str(a.get("code", "")).splitlines()) for a in ipy_code]
    # Re-sending code under the *same* name is how the file gets updated (ipy treats it as an
    # overwrite), so it is not the same failure as scattering new names around: count both.
    creates = [a.get("name") for n, a in c1 + c2 if n == "ipy" and a.get("code")]
    names_note = "" if not creates else f"create×{len(creates)}/{len(set(creates))}名"

    # Strictest verdict first: an edit that landed *and* was re-run is the flow the design
    # promises. Re-running the untouched script is not re-use — the change was never applied
    # (usually the model did the new work in a heredoc instead), and that stale file is worse
    # than a rewrite, which at least leaves the script current.
    if edited and ipy_path:
        verdict = "严格 edit + 重跑 ✓"
        reuse += 1
    elif ipy_path and heredoc2:
        verdict = "重跑旧脚本 + heredoc 干新活（脚本仍陈旧）"
        stale += 1
    elif ipy_path:
        verdict = "按路径重跑（没改脚本，脚本仍陈旧）"
        stale += 1
    elif ipy_code and not ipy_path:
        verdict = "重写（又发了一遍代码）"
        rewrite += 1
    elif heredoc2:
        verdict = "bash + python heredoc"
        bash += 1
    elif edited:
        verdict = "只改没跑"
        none += 1
    else:
        verdict = "没调工具（或纯 shell）"
        none += 1

    t1_note = f"ipy×{len(made)}" if made else (f"heredoc×{heredoc1}" if heredoc1 else "无脚本")
    t2_note = []
    if edited:
        t2_note.append(f"edit {script}" if script else "edit")
    if ipy_path:
        t2_note.append("ipy(path)")
    if ipy_code:
        t2_note.append(f"ipy(code, {lines[0] if lines else 0} 行)")
    if heredoc2:
        t2_note.append("bash+heredoc")
    print(f"  rep{i}  turn1={t1_note:<12} turn2={' + '.join(t2_note) or '—':<40} {names_note:<18} {verdict}")

    # Cross-check against the tool's own record of what happened in that session.
    dirs = glob.glob(f"/tmp/pi-ipy-*/ipy-acc-{open(f'{out}/rep{i}.sid').read().strip()[:8]}")
    for d in dirs:
        modes = []
        for line in open(f"{d}/.index.jsonl", encoding="utf-8", errors="replace"):
            try:
                m = json.loads(line)
            except Exception:
                continue
            modes.append(m.get("mode"))
        if modes:
            print(f"        manifest: {modes}")

print(f"\n  严格 edit+重跑  {reuse}/{reps}\n  脚本变陈旧      {stale}/{reps}\n  重写（同名字） {rewrite}/{reps}\n  bash+heredoc    {bash}/{reps}\n  没调工具/其它  {none}/{reps}")
PY
echo "raw: $OUT"
