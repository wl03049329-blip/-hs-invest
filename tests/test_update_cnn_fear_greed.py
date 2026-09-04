import contextlib
import datetime as dt
import importlib.util
import io
import json
import tempfile
import unittest
import urllib.error
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "update_cnn_fear_greed", ROOT / "scripts" / "update_cnn_fear_greed.py"
)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def source_response(score=35.7):
    return {
        "fear_and_greed": {
            "score": score,
            "timestamp": dt.datetime.now(dt.timezone.utc).isoformat(),
            "previous_close": 33.2,
            "previous_1_week": 55.4,
            "previous_1_month": 50.7,
        }
    }


def valid_artifact():
    return MODULE.build_payload(source_response())


class FakeResponse:
    def __init__(self, body, status=200):
        self.body = body
        self.status = status
        self.headers = {}

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def getcode(self):
        return self.status

    def read(self):
        return self.body


class CNNFearGreedUpdaterTests(unittest.TestCase):
    def test_connection_reset_then_success(self):
        calls = []
        sleeps = []

        def urlopen(_request, timeout):
            calls.append(timeout)
            if len(calls) == 1:
                raise ConnectionResetError("temporary reset")
            return FakeResponse(json.dumps(source_response()).encode())

        result = MODULE.fetch_data(urlopen=urlopen, sleeper=sleeps.append)
        self.assertEqual(result["fear_and_greed"]["score"], 35.7)
        self.assertEqual(len(calls), 2)
        self.assertEqual(sleeps, [2])

    def test_request_uses_public_json_headers(self):
        seen = {}

        def urlopen(request, timeout):
            seen["timeout"] = timeout
            seen["user_agent"] = request.get_header("User-agent")
            seen["accept"] = request.get_header("Accept")
            seen["accept_language"] = request.get_header("Accept-language")
            return FakeResponse(json.dumps(source_response()).encode())

        MODULE.fetch_data(urlopen=urlopen, sleeper=lambda _delay: None)
        self.assertEqual(seen["timeout"], 30)
        self.assertTrue(seen["user_agent"])
        self.assertIn("application/json", seen["accept"])
        self.assertIn("zh-TW", seen["accept_language"])

    def test_five_failures_with_old_data_preserves_artifact_and_succeeds(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory) / "cnn-fear-greed.json"
            original = json.dumps(valid_artifact(), ensure_ascii=False, indent=2) + "\n"
            out.write_text(original, encoding="utf-8")
            calls = []
            sleeps = []

            def urlopen(_request, timeout):
                calls.append(timeout)
                raise urllib.error.URLError("temporary outage")

            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                code = MODULE.main(
                    out_path=out,
                    fetcher=lambda: MODULE.fetch_data(urlopen=urlopen, sleeper=sleeps.append),
                )
            self.assertEqual(code, 0)
            self.assertEqual(len(calls), 5)
            self.assertEqual(sleeps, [2, 4, 8, 16])
            self.assertEqual(out.read_text(encoding="utf-8"), original)
            self.assertIn("CNN_FETCH_FAILED", output.getvalue())
            self.assertIn("USING_LAST_VALID_DATA", output.getvalue())

    def test_five_failures_without_old_data_exits_one(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory) / "cnn-fear-greed.json"
            calls = []

            def urlopen(_request, timeout):
                calls.append(timeout)
                raise TimeoutError("temporary timeout")

            code = MODULE.main(
                out_path=out,
                fetcher=lambda: MODULE.fetch_data(urlopen=urlopen, sleeper=lambda _delay: None),
            )
            self.assertEqual(code, 1)
            self.assertEqual(len(calls), 5)
            self.assertFalse(out.exists())

    def test_http_429_then_success(self):
        calls = []
        sleeps = []

        def urlopen(request, timeout):
            calls.append(timeout)
            if len(calls) == 1:
                raise urllib.error.HTTPError(request.full_url, 429, "rate limited", {}, None)
            return FakeResponse(json.dumps(source_response(41.2)).encode())

        result = MODULE.fetch_data(urlopen=urlopen, sleeper=sleeps.append)
        self.assertEqual(result["fear_and_greed"]["score"], 41.2)
        self.assertEqual(len(calls), 2)
        self.assertEqual(sleeps, [2])

    def test_http_503_then_success(self):
        calls = []
        sleeps = []

        def urlopen(request, timeout):
            calls.append(timeout)
            if len(calls) == 1:
                raise urllib.error.HTTPError(request.full_url, 503, "unavailable", {}, None)
            return FakeResponse(json.dumps(source_response(29.4)).encode())

        result = MODULE.fetch_data(urlopen=urlopen, sleeper=sleeps.append)
        self.assertEqual(result["fear_and_greed"]["score"], 29.4)
        self.assertEqual(len(calls), 2)
        self.assertEqual(sleeps, [2])

    def test_malformed_json_does_not_overwrite_valid_artifact(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory) / "cnn-fear-greed.json"
            original = json.dumps(valid_artifact(), ensure_ascii=False, indent=2) + "\n"
            out.write_text(original, encoding="utf-8")

            def fetcher():
                return MODULE.fetch_data(
                    urlopen=lambda _request, timeout: FakeResponse(b"{not-json"),
                    sleeper=lambda _delay: None,
                )

            code = MODULE.main(out_path=out, fetcher=fetcher)
            self.assertEqual(code, 0)
            self.assertEqual(out.read_text(encoding="utf-8"), original)


if __name__ == "__main__":
    unittest.main()
