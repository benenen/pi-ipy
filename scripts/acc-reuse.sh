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

HARNESS_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
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

python3 "$HARNESS_DIR/audit-reuse.py" "$OUT"
echo "raw: $OUT"
