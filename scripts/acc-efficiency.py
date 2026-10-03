#!/usr/bin/env python3
"""Paired pi runs on immutable inputs with an independent answer oracle (stdlib only)."""

import argparse
from collections import Counter, defaultdict
import hashlib
import json
import os
from pathlib import Path
import random
import shutil
import statistics
import subprocess
import tempfile
import time
import uuid

from efficiency import read_turn


def fixture(path):
    rng = random.Random(20261003)
    records = []
    for i in range(450):
        names = [rng.choice(["read", "edit", "bash", "write", "search", "ipy"]) for _ in range(rng.randint(1, 4))]
        records.append({"type": "message", "message": {
            "role": "assistant", "usage": {"totalTokens": rng.randint(1000, 99000) + (i % 7) * 23000},
            "content": [{"type": "toolCall", "name": name, "arguments": {}} for name in names],
        }})
    path.write_text("".join(json.dumps(r) + "\n" for r in records))
    path.chmod(0o444)


def oracle(path, median):
    counts, tokens = Counter(), defaultdict(list)
    for line in path.read_text().splitlines():
        message = json.loads(line)["message"]
        names = [c["name"] for c in message["content"] if c["type"] == "toolCall"]
        counts.update(names)
        for name in set(names):
            tokens[name].append(message["usage"]["totalTokens"])
    aggregate = statistics.median if median else statistics.mean
    rows = [{"tool": name, "calls": counts[name], "tokens": round(aggregate(values), 1)} for name, values in tokens.items()]
    return sorted(rows, key=lambda r: (-r["tokens"], r["tool"]))[:3 if median else 5]


def summary(rows):
    result = {}
    for arm in ("baseline", "candidate"):
        group = [r for r in rows if r["arm"] == arm]
        result[arm] = {"reps": len(group)}
        for turn in ("turn1", "turn2"):
            samples = [r[turn] for r in group]
            result[arm][turn] = {
                "correct": sum(s["final_answer_correct"] and s["executed_answer_correct"] and s["process_exit"] == 0 and s["completed"] for s in samples),
                "format_correct": sum(s["final_format_correct"] for s in samples),
                "successful_edit_run": sum(s["successful_edit_run"] for s in samples),
                **{key + "_median": statistics.median(s[key] for s in samples) for key in ("wall_seconds", "tool_calls", "code_bytes", "patch_bytes", "tool_args_bytes", "tool_errors")},
                "usage_median": {key: statistics.median(s["usage"][key] for s in samples) for key in samples[0]["usage"]},
            }
        result[arm]["both_turns"] = {
            "wall_seconds_median": statistics.median(r["turn1"]["wall_seconds"] + r["turn2"]["wall_seconds"] for r in group),
            "usage_median": {key: statistics.median(r["turn1"]["usage"][key] + r["turn2"]["usage"][key] for r in group) for key in group[0]["turn1"]["usage"]},
        }
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", help="Pinned pi provider/model")
    parser.add_argument("--reanalyze", type=Path, help="Re-evaluate saved records, without model calls")
    parser.add_argument("--agent-dir", type=Path, default=Path(os.environ.get("PI_CODING_AGENT_DIR", os.environ.get("PI_AGENT_DIR", str(Path.home() / ".pi/agent")))))
    parser.add_argument("--baseline", type=Path, help="Unmodified extension index.ts snapshot")
    parser.add_argument("--candidate", type=Path, default=Path(__file__).resolve().parents[1] / "index.ts")
    parser.add_argument("--reps", type=int, default=5)
    parser.add_argument("--timeout", type=float, default=180, help="Per-turn wall time ceiling in seconds")
    options = parser.parse_args()
    if options.reanalyze:
        out = options.reanalyze
        metadata = json.loads((out / "meta.json").read_text())
        if hashlib.sha256((out / "input.jsonl").read_bytes()).hexdigest() != metadata["input_sha256"]:
            raise RuntimeError("input snapshot changed; this experiment cannot be re-evaluated")
        expected = [oracle(out / "input.jsonl", median) for median in (False, True)]
        rows = json.loads((out / "results.json").read_text())
        for row in rows:
            work = out / f"{row['arm']}-{row['rep']}"
            for number in (1, 2):
                key = f"turn{number}"
                old = row[key]
                row[key] = read_turn(work / f"{key}.json", expected[number - 1], row["turn1"]["script_paths"] if number == 2 else None)
                row[key].update(wall_seconds=old["wall_seconds"], process_exit=old["process_exit"])
        (out / "results.json").write_text(json.dumps(rows, indent=2))
        report = summary(rows)
        (out / "summary.json").write_text(json.dumps(report, indent=2))
        print(json.dumps(report, indent=2))
        return
    if not options.model or not options.baseline:
        parser.error("--model and --baseline are required for new experiments")
    if options.reps < 1 or options.timeout <= 0:
        parser.error("reps and timeout must be positive")
    extensions = {arm: path.resolve() for arm, path in (("baseline", options.baseline), ("candidate", options.candidate))}
    if any(not p.is_file() for p in extensions.values()):
        parser.error("both extension entry files must exist (including their lib directories)")
    out = Path(tempfile.mkdtemp(prefix="ipy-efficiency-"))
    print(f"raw: {out}", flush=True)
    # Copy credentials privately so pi can take its locks without mutating the user's agent directory.
    agent = out / "agent"
    agent.mkdir(mode=0o700)
    for filename in ("auth.json", "models-store.json", "models.json"):
        source_config = options.agent_dir / filename
        if source_config.is_file():
            shutil.copy2(source_config, agent / filename)
            (agent / filename).chmod(0o600)
    for arm, entry in list(extensions.items()):
        snapshot = out / "extensions" / arm
        (snapshot / "lib").mkdir(parents=True)
        for filename in ("index.ts", "lib/store.ts", "lib/run.ts"):
            shutil.copy2(entry.parent / filename, snapshot / filename)
        extensions[arm] = snapshot / "index.ts"
    source = out / "input.jsonl"
    fixture(source)
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    expected = [oracle(source, median) for median in (False, True)]
    (out / "expected.json").write_text(json.dumps(expected, indent=2))
    extension_hashes = {arm: {filename: hashlib.sha256((entry.parent / filename).read_bytes()).hexdigest() for filename in ("index.ts", "lib/store.ts", "lib/run.ts")} for arm, entry in extensions.items()}
    (out / "meta.json").write_text(json.dumps({"model": options.model, "reps": options.reps, "input_sha256": digest, "extensions": {a: str(p) for a, p in extensions.items()}, "extension_sha256": extension_hashes}, indent=2))
    prompt1 = (f"用一个可再次修改和运行的 Python 脚本解析 {source}。按 assistant 消息的 toolCall.name 汇总调用次数；"
               "同一条消息含同一工具多次时，调用次数全部计入，usage.totalTokens 每个工具每条消息只计一次。"
               "按 totalTokens 平均值降序取前 5，同值时工具名升序。tokens 四舍五入到 1 位小数。"
               '脚本 stdout 和最终回答都只输出 JSON 数组，每项格式 {"tool":"名称","calls":次数,"tokens":统计值}。')
    prompt2 = "修改刚才的脚本：平均值改为中位数，只取前 3；其余口径和输出格式不变。运行后给出结果。"
    rows = []
    env = dict(os.environ)
    env["PI_CODING_AGENT_DIR"] = str(agent)
    env.pop("PI_IPY_QUIET", None)
    for rep in range(1, options.reps + 1):
        # Alternate order; both arms have identical discovery flags and isolated cwd/session files.
        for arm in (("baseline", "candidate") if rep % 2 else ("candidate", "baseline")):
            work = out / f"{arm}-{rep}"
            work.mkdir()
            sid = str(uuid.uuid4())
            row = {"arm": arm, "rep": rep}
            for number, prompt in enumerate((prompt1, prompt2), 1):
                path = work / f"turn{number}.json"
                cmd = ["pi", "--offline", "-p", "--mode", "json", "--model", options.model, "-ne", "-ns", "-np", "-nc", "-e", str(extensions[arm]), "--session-dir", str(work / "sessions"), "--session-id", sid, prompt]
                started = time.monotonic()
                # Interrupt pi first so its abort handler can terminate detached Python groups.
                with path.open("w") as stdout, (work / f"turn{number}.err").open("w") as stderr:
                    process = subprocess.Popen(cmd, cwd=work, env=env, stdout=stdout, stderr=stderr, start_new_session=True)
                    try:
                        exit_code = process.wait(timeout=options.timeout)
                    except subprocess.TimeoutExpired:
                        import signal
                        try:
                            os.killpg(process.pid, signal.SIGINT)
                        except ProcessLookupError:
                            pass
                        try:
                            process.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            os.killpg(process.pid, signal.SIGKILL)
                            process.wait()
                        exit_code = 124
                metrics = read_turn(path, expected[number - 1], row["turn1"]["script_paths"] if number == 2 else None)
                metrics.update(wall_seconds=time.monotonic() - started, process_exit=exit_code)
                row[f"turn{number}"] = metrics
                print(f"{arm} rep{rep} turn{number}: correct={metrics['final_answer_correct'] and metrics['executed_answer_correct']} calls={metrics['tool_calls']} wall={metrics['wall_seconds']:.1f}s", flush=True)
                if not metrics["assistant_messages"]:
                    raise RuntimeError(f"no model response; inspect {work / f'turn{number}.err'} and {path}")
            rows.append(row)
            (out / "results.json").write_text(json.dumps(rows, indent=2))
            if hashlib.sha256(source.read_bytes()).hexdigest() != digest:
                raise RuntimeError("input was modified: discard this experiment")
    report = summary(rows)
    (out / "summary.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
    print(f"raw: {out}")


if __name__ == "__main__":
    main()
