#!/usr/bin/env python3
"""Audit existing acc-reuse records without making new model calls."""

import json
from pathlib import Path
import statistics
import sys

from efficiency import read_turn


def main():
    for name in sys.argv[1:]:
        directory = Path(name)
        rows = []
        for first in sorted(directory.glob("rep*.turn1.json"), key=lambda p: int(p.name.split(".")[0][3:])):
            second = first.with_name(first.name.replace("turn1", "turn2"))
            if not second.exists():
                continue
            t1 = read_turn(first)
            t2 = read_turn(second, previous_paths=t1["script_paths"])
            rows.append(dict(rep=int(first.name.split(".")[0][3:]), turn1=t1, turn2=t2))
        if not rows:
            raise ValueError(f"no completed turn pairs in {directory}")
        summary = {"reps": len(rows), "successful_edit_run": sum(r["turn2"]["successful_edit_run"] for r in rows),
                   "correctness": "unknown: this experiment has no immutable input snapshot/oracle"}
        for turn in ("turn1", "turn2"):
            summary[turn] = {
                "usage_median": {key: statistics.median(r[turn]["usage"][key] for r in rows) for key in rows[0][turn]["usage"]},
                "tool_errors": sum(r[turn]["tool_errors"] for r in rows),
                "code_bytes_median": statistics.median(r[turn]["code_bytes"] for r in rows),
                "tool_args_bytes_median": statistics.median(r[turn]["tool_args_bytes"] for r in rows),
                "event_span_seconds_median": statistics.median(r[turn]["event_span_seconds"] for r in rows if r[turn]["event_span_seconds"] is not None),
            }
        (directory / "audit.json").write_text(json.dumps(dict(summary=summary, rows=rows), indent=2))
        print(directory)
        print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
