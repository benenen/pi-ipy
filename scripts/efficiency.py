"""Read pi JSON events once; tool attempts, successful execution and answers are separate."""

import json
import re
from pathlib import Path


def json_answer(text):
    """Accept a JSON answer, optionally in a Markdown fence; never guess from numbers."""
    text = text.strip()
    if text.startswith("```json\n") and text.endswith("```"):
        text = text[8:-3].strip()
    elif text.startswith("```\n") and text.endswith("```"):
        text = text[4:-3].strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


def answer_value(text):
    value = json_answer(text)
    if value is not None:
        return value
    blocks = re.findall(r"```(?:json)?\s*\n(.*?)\n```", text, re.DOTALL)
    return json_answer(blocks[0]) if len(blocks) == 1 else None


def read_turn(path, expected=None, previous_paths=None):
    calls = {}
    successful_edits = set()
    reuse = False
    emitted_code = 0
    transmitted_patch = 0
    argument_bytes = 0
    script_paths = set()
    errors = 0
    execution_correct = False
    final_text = ""
    usage = dict(input=0, output=0, cacheRead=0, cacheWrite=0, totalTokens=0)
    timestamps = []
    messages = 0
    completed = False
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        kind = event.get("type")
        if kind == "agent_end":
            completed = True
        elif kind == "message_end":
            message = event.get("message", {})
            if isinstance(message.get("timestamp"), (int, float)):
                timestamps.append(message["timestamp"])
            if message.get("role") != "assistant":
                continue
            messages += 1
            for key in usage:
                usage[key] += message.get("usage", {}).get(key, 0)
            text = "".join(c.get("text", "") for c in message.get("content", []) if c.get("type") == "text")
            if text:
                final_text = text
        elif kind == "tool_execution_start":
            calls[event["toolCallId"]] = event
            args = event.get("args") or {}
            argument_bytes += len(json.dumps(args, ensure_ascii=False, separators=(",", ":")).encode())
            if event.get("toolName") == "ipy":
                emitted_code += len(args.get("code", "").encode())
                transmitted_patch += sum(len(e.get("oldText", "").encode()) + len(e.get("newText", "").encode()) for e in args.get("edits", []))
        elif kind == "tool_execution_end":
            call = calls.get(event.get("toolCallId"), {})
            args = call.get("args") or {}
            name = call.get("toolName")
            result = event.get("result") or {}
            data = result.get("structuredContent") or {}
            script = data.get("script_path") or result.get("details", {}).get("scriptPath")
            if script:
                script_paths.add(script)
            failed = bool(event.get("isError") or result.get("isError") or data.get("exit_code", 0) != 0)
            errors += int(failed)
            if failed:
                if name in ("ipy", "bash"):
                    execution_correct = False
                continue
            path = args.get("path") or args.get("file_path")
            if name in ("edit", "write") and path:
                successful_edits.add(path)
            if name == "ipy" and path and (previous_paths is None or path in previous_paths) and (args.get("edits") or path in successful_edits):
                reuse = True
            if name in ("ipy", "bash") and data.get("exit_code") == 0 and expected is not None:
                output = data.get("stdout", "") if name == "ipy" else data.get("output", "")
                execution_correct = json_answer(output) == expected
    return {
        "usage": usage, "assistant_messages": messages, "tool_calls": len(calls),
        "tool_errors": errors, "code_bytes": emitted_code, "patch_bytes": transmitted_patch,
        "tool_args_bytes": argument_bytes, "script_paths": sorted(script_paths),
        "successful_edit_run": reuse, "completed": completed,
        "executed_answer_correct": execution_correct if expected is not None else None,
        "final_answer_correct": answer_value(final_text) == expected if expected is not None else None,
        "final_format_correct": json_answer(final_text) == expected if expected is not None else None,
        "event_span_seconds": (max(timestamps) - min(timestamps)) / 1000 if timestamps else None,
    }
