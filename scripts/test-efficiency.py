"""Regression checks for event accounting; no model or network required."""

import json
from pathlib import Path
import tempfile
import unittest

from efficiency import read_turn
from importlib.util import module_from_spec, spec_from_file_location


class MetricsTest(unittest.TestCase):
    def measure(self, events, expected=None, previous_paths=None):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "events.json"
            path.write_text("\n".join(json.dumps(e) for e in events))
            return read_turn(path, expected, previous_paths)

    def start(self, ident, name, args):
        return dict(type="tool_execution_start", toolCallId=ident, toolName=name, args=args)

    def end(self, ident, failed=False, **data):
        return dict(type="tool_execution_end", toolCallId=ident, isError=failed, result=dict(structuredContent=data))

    def test_usage_counted_once(self):
        message = dict(role="assistant", usage=dict(totalTokens=13, output=3), content=[])
        result = self.measure([dict(type="message_end", message=message), dict(type="agent_end", messages=[message])])
        self.assertEqual(result["usage"]["totalTokens"], 13)
        self.assertEqual(result["assistant_messages"], 1)

    def test_failed_edit_is_not_reuse(self):
        result = self.measure([self.start("e", "edit", dict(path="a.py")), self.end("e", True), self.start("r", "ipy", dict(path="a.py")), self.end("r", exit_code=0)])
        self.assertFalse(result["successful_edit_run"])
        self.assertEqual(result["tool_errors"], 1)

    def test_edit_must_precede_same_file_run(self):
        events = [self.start("e", "edit", dict(path="a.py")), self.end("e"), self.start("r", "ipy", dict(path="b.py")), self.end("r", exit_code=0)]
        self.assertFalse(self.measure(events)["successful_edit_run"])
        events[-2]["args"]["path"] = "a.py"
        self.assertTrue(self.measure(events, previous_paths=["a.py"])["successful_edit_run"])
        self.assertFalse(self.measure(events, previous_paths=["old.py"])["successful_edit_run"])

    def test_patch_and_run_and_correctness(self):
        expected = [{"tool": "a", "calls": 2, "tokens": 1.5}]
        events = [self.start("p", "ipy", dict(path="a.py", edits=[dict(oldText="x", newText="y")])), self.end("p", exit_code=0, stdout=json.dumps(expected))]
        self.assertTrue(self.measure(events, expected)["successful_edit_run"])
        self.assertTrue(self.measure(events, expected)["executed_answer_correct"])
        self.assertFalse(self.measure(events, expected)["final_answer_correct"])
        events.append(dict(type="message_end", message=dict(role="assistant", content=[dict(type="text", text=json.dumps(expected))])))
        self.assertTrue(self.measure(events, expected)["final_answer_correct"])
        events.extend([self.start("p2", "ipy", dict(path="a.py")), self.end("p2", True)])
        self.assertFalse(self.measure(events, expected)["executed_answer_correct"])

    def test_correct_bash_execution_is_not_tool_choice_failure(self):
        events = [self.start("b", "bash", dict(command="python3 stats.py")), self.end("b", exit_code=0, output='[{"ok": true}]')]
        self.assertTrue(self.measure(events, [{"ok": True}])["executed_answer_correct"])

    def test_answer_values_and_format_are_separate(self):
        message = dict(role="assistant", content=[dict(type="text", text='说明\n```json\n[{"ok": true}]\n```')])
        result = self.measure([dict(type="message_end", message=message)], [{"ok": True}])
        self.assertTrue(result["final_answer_correct"])
        self.assertFalse(result["final_format_correct"])

    def test_oracle_counts_calls_but_deduplicates_message_tokens(self):
        spec = spec_from_file_location("acc_efficiency", Path(__file__).with_name("acc-efficiency.py"))
        benchmark = module_from_spec(spec)
        spec.loader.exec_module(benchmark)
        records = [dict(message=dict(usage=dict(totalTokens=tokens), content=[dict(type="toolCall", name="a") for _ in range(count)])) for tokens, count in [(1, 2), (5, 1), (100, 1)]]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "input.jsonl"
            path.write_text("\n".join(json.dumps(r) for r in records))
            self.assertEqual(benchmark.oracle(path, False), [dict(tool="a", calls=4, tokens=35.3)])
            self.assertEqual(benchmark.oracle(path, True), [dict(tool="a", calls=4, tokens=5)])


if __name__ == "__main__":
    unittest.main()
