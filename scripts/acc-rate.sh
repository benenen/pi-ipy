#!/usr/bin/env bash
# Does the model actually reach for ipy? A rate, not an anecdote.
#
#   scripts/acc-rate.sh <model> <runs> [extra pi flags...]
#   scripts/acc-rate.sh opencode-go/deepseek-v4.1-flash 4
#   scripts/acc-rate.sh opencode-go/deepseek-v4.1-flash 4 --exclude-tools ipy   # baseline
#
# One fresh session per run, the same Python-shaped prompt, then classify the tool
# calls: `ipy` is the behaviour the guidelines ask for; `bash` containing a python
# heredoc (`python3 - <<'EOF'`) is the behaviour they exist to displace.
#
# Single runs are worthless for this question — the same prompt on the same model
# with the same system prompt has produced 2 ipy calls one minute and 0 the next, so
# only the rate over N runs says anything. Pin --model: the rate is model-specific.
set -euo pipefail

MODEL="${1:?usage: acc-rate.sh <model> <runs> [extra pi flags...]}"
RUNS="${2:?usage: acc-rate.sh <model> <runs> [extra pi flags...]}"
shift 2

AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
SLUG="$(printf '%s%s' "$MODEL" "$*" | tr -c '[:alnum:]' '-')"
OUT="/tmp/ipy-acc/rate-$SLUG-$(date +%H%M%S)"
mkdir -p "$OUT/sessions"
cd /tmp/ipy-acc # neutral cwd: no repo AGENTS.md in the context

PROMPT="统计 $AGENT_DIR/sessions 下最新的那个 .jsonl 会话文件里各种工具被调用了多少次，按次数从多到少列出前 10 个。"

for i in $(seq 1 "$RUNS"); do
	pi -p --mode json --model "$MODEL" "$@" \
		--session-dir "$OUT/sessions" "$PROMPT" >"$OUT/run$i.json" 2>"$OUT/run$i.err" ||
		echo "run$i: pi exited $?"
	printf 'run%s done\n' "$i"
done

python3 - "$OUT" "$RUNS" "$MODEL" <<'PY'
import json, os, sys, glob

out, runs, model = sys.argv[1], int(sys.argv[2]), sys.argv[3]
ipy_hits = heredoc_hits = 0
print(f"\nmodel: {model}   flags: {' '.join(sys.argv[4:]) or '(none)'}   runs: {runs}")
for p in sorted(glob.glob(os.path.join(out, "run*.json")), key=lambda s: int(''.join(c for c in os.path.basename(s) if c.isdigit()))):
    calls = []
    for line in open(p, encoding="utf-8", errors="replace"):
        try:
            e = json.loads(line)
        except Exception:
            continue
        if e.get("type") == "tool_execution_start":
            calls.append((e.get("toolName"), (e.get("args") or {}).get("command", "")))
    names = [n for n, _ in calls]
    ipy = names.count("ipy")
    heredoc = sum(1 for n, c in calls if n == "bash" and "python3" in c and "<<" in c)
    detail = []
    for n, c in calls:
        if n == "ipy":
            detail.append(f"ipy({len(c.splitlines())}行)" if c else "ipy")
        elif n == "bash" and "python3" in c and "<<" in c:
            detail.append("bash+heredoc")
    ipy_hits += ipy > 0
    heredoc_hits += heredoc > 0
    print(f"  run{p.split('run')[-1].split('.')[0]:>2}  ipy={ipy}  heredoc={heredoc}  bash={names.count('bash')}  " + " ".join(detail))
print(f"\n  ipy 命中        {ipy_hits}/{runs}")
print(f"  python heredoc  {heredoc_hits}/{runs}")
PY
echo "raw: $OUT"
