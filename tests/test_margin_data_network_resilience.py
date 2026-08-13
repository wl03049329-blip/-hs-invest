import http.client
import importlib.util
import json
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "update_margin_data_network_p0", ROOT / "scripts" / "update_margin_data.py"
)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(MODULE)


class Response:
    status = 200

    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return self.payload


GOOD = Response(json.dumps({"stat": "OK"}).encode())


class MarginNetworkResilienceTests(unittest.TestCase):
    def call_get_json(self, side_effect):
        with mock.patch.object(MODULE.urllib.request, "urlopen", side_effect=side_effect) as opened, \
                mock.patch.object(MODULE.time, "sleep") as sleep:
            result = MODULE.get_json("https://example.test/data")
        return result, opened.call_count, [call.args[0] for call in sleep.call_args_list]

    def test_incomplete_read_retries_then_succeeds(self):
        result, calls, delays = self.call_get_json([
            http.client.IncompleteRead(b'{"stat":', 20), GOOD
        ])
        self.assertEqual(result, {"stat": "OK"})
        self.assertEqual(calls, 2)
        self.assertEqual(delays, [1])

    def test_remote_disconnect_then_url_error_then_success(self):
        result, calls, delays = self.call_get_json([
            http.client.RemoteDisconnected("peer closed"),
            urllib.error.URLError("temporary"),
            GOOD,
        ])
        self.assertEqual(result, {"stat": "OK"})
        self.assertEqual(calls, 3)
        self.assertEqual(delays, [1, 2])

    def test_all_transport_attempts_raise_runtime_error(self):
        errors = [http.client.IncompleteRead(b"", 10) for _ in range(4)]
        with mock.patch.object(MODULE.urllib.request, "urlopen", side_effect=errors), \
                mock.patch.object(MODULE.time, "sleep"):
            with self.assertRaises(MODULE.NetworkFetchError) as raised:
                MODULE.get_json("https://example.test/data")
        self.assertIsInstance(raised.exception, RuntimeError)
        self.assertNotIsInstance(raised.exception, http.client.HTTPException)

    def test_valid_previous_cache_is_byte_identical_after_network_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            out, state = directory / "margin-data.json", directory / "margin-cost-state.json"
            out.write_bytes((ROOT / "margin-data.json").read_bytes())
            state.write_bytes((ROOT / "margin-cost-state.json").read_bytes())
            before_out, before_state = out.read_bytes(), state.read_bytes()
            with mock.patch.object(MODULE, "OUT", out), \
                    mock.patch.object(MODULE, "STATE", state), \
                    mock.patch.object(MODULE, "RECONCILIATION", directory / "reconciliation-report.json"), \
                    mock.patch.object(MODULE, "newest_day", side_effect=MODULE.NetworkFetchError("fixture outage")), \
                    mock.patch.object(sys, "argv", ["update_margin_data.py"]):
                self.assertEqual(MODULE.main(), 0)
            self.assertEqual(out.read_bytes(), before_out)
            self.assertEqual(state.read_bytes(), before_state)
            self.assertEqual(json.loads(out.read_text(encoding="utf-8"))["data_date"], "2026-08-11")

    def test_first_build_without_cache_still_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            with mock.patch.object(MODULE, "OUT", directory / "margin-data.json"), \
                    mock.patch.object(MODULE, "STATE", directory / "margin-cost-state.json"), \
                    mock.patch.object(MODULE, "RECONCILIATION", directory / "reconciliation-report.json"), \
                    mock.patch.object(MODULE, "trading_days_to_fetch", side_effect=MODULE.NetworkFetchError("fixture outage")), \
                    mock.patch.object(sys, "argv", ["update_margin_data.py"]):
                with self.assertRaises(MODULE.NetworkFetchError):
                    MODULE.main()

    def test_malformed_json_retries_then_succeeds(self):
        result, calls, delays = self.call_get_json([Response(b'{"stat":'), GOOD])
        self.assertEqual(result, {"stat": "OK"})
        self.assertEqual(calls, 2)
        self.assertEqual(delays, [1])

    def test_workflow_has_timeout_without_continue_on_error(self):
        workflow = (ROOT / ".github" / "workflows" / "update-margin-data.yml").read_text(encoding="utf-8")
        self.assertIn("timeout-minutes: 15", workflow)
        self.assertNotIn("continue-on-error", workflow)


if __name__ == "__main__":
    unittest.main()
