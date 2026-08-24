import importlib.util
import json
import subprocess
import tempfile
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo


ROOT = Path(__file__).resolve().parents[1]
TAIPEI = ZoneInfo("Asia/Taipei")
spec = importlib.util.spec_from_file_location(
    "intraday_artifact_staging_p0", ROOT / "scripts" / "run_intraday_radar_session.py"
)
runner = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(runner)


def at(value: str) -> datetime:
    return datetime.fromisoformat(value).replace(tzinfo=TAIPEI)


def fake_completed(returncode: int) -> subprocess.CompletedProcess:
    return subprocess.CompletedProcess([], returncode)


with tempfile.TemporaryDirectory() as temp_dir:
    temp = Path(temp_dir)
    original_root, original_run, original_subprocess_run = runner.ROOT, runner.run, runner.subprocess.run
    commands: list[list[str]] = []
    staged_returncode = [0]

    def fake_run(command, **_kwargs):
        commands.append(command)
        return fake_completed(0)

    def fake_subprocess_run(command, **_kwargs):
        assert command == ["git", "diff", "--cached", "--quiet"]
        return fake_completed(staged_returncode[0])

    try:
        runner.ROOT = temp
        runner.run = fake_run
        runner.subprocess.run = fake_subprocess_run

        # All artifacts exist: normal staging preserves the full cache set.
        for filename in runner.CACHE_FILES:
            (temp / filename).write_text("{}", encoding="utf-8")
        runner.commit_slot("2026-08-24", "09:30", True)
        assert commands == [["git", "add", "--", *runner.CACHE_FILES]]
        print("TEST 1 PASS: all cache artifacts stage normally")

        # A failed slot may not produce a canonical snapshot.  Its absence
        # must not invoke git add with an invalid pathspec.
        commands.clear()
        (temp / "intraday-core-snapshots-v1.json").unlink()
        runner.commit_slot("2026-08-24", "10:30", False)
        assert commands == [["git", "add", "--", *runner.CACHE_FILES[:-1]]]
        print("TEST 2 PASS: absent conditional artifact is skipped")

        # FAILED metadata remains persistable and commit-able even without a
        # canonical snapshot; the upstream failure stays a FAILED outcome.
        state = runner.new_completeness("2026-08-24")
        state = runner.record_slot_outcome(
            state, "11:30", runner.SLOT_FAILED,
            {"error": "upstream quote source unavailable"}, at("2026-08-24T11:32:00"),
        )
        (temp / "market-quotes.json").write_text(json.dumps({"items": []}), encoding="utf-8")
        (temp / "market-quotes-meta.json").write_text(json.dumps({"status": "ok"}), encoding="utf-8")
        runner.persist_completeness(state)
        assert json.loads((temp / "market-quotes-meta.json").read_text(encoding="utf-8"))["intraday_completeness"]["slots"]["11:30"]["status"] == runner.SLOT_FAILED
        commands.clear()
        staged_returncode[0] = 1
        runner.commit_slot("2026-08-24", "11:30", False)
        assert commands[0] == ["git", "add", "--", *runner.CACHE_FILES[:-1]]
        assert ["git", "commit", "-m", "Record failed intraday radar 2026-08-24 11:30"] in commands
        assert ["git", "push"] in commands
        print("TEST 3 PASS: failed metadata persists without a pathspec crash")

        # No staged cache diff remains a safe no-op and never creates an
        # empty commit.  Existing success/idempotency coverage remains in the
        # completeness contract suite.
        commands.clear()
        staged_returncode[0] = 0
        runner.commit_slot("2026-08-24", "11:30", False)
        assert not any(command[:2] == ["git", "commit"] for command in commands)
        print("TEST 4 PASS: no staged cache diff is a clean no-op")
    finally:
        runner.ROOT, runner.run, runner.subprocess.run = original_root, original_run, original_subprocess_run

print("PASS intraday artifact staging / failure persistence P0")
