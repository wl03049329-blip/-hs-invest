"""Keep P0 placement under the existing Dashboard service, never a code override.

This is a local configuration contract, not proof of cloud deployment or Volume
compatibility. Dashboard/pending-change checks remain a separate release gate.
"""
import copy
import json
from pathlib import Path
import re
import shlex
import unittest


ROOT = Path(__file__).resolve().parents[1]
PLACEMENT_KEYS = {"region", "multiRegionConfig", "numReplicas"}


def deployment_sections(config, path="root"):
    yield path, config.get("deploy", {})
    for name, override in config.get("environments", {}).items():
        yield from deployment_sections(override, path + ".environments." + name)


def require_dashboard_placement(config):
    for path, deploy in deployment_sections(config):
        forbidden = PLACEMENT_KEYS.intersection(deploy)
        if forbidden:
            raise ValueError(f"{path}: placement override {sorted(forbidden)}")


class RailwayRegionConfigTests(unittest.TestCase):
    def setUp(self):
        self.config = json.loads((ROOT / "railway.json").read_text(encoding="utf-8"))

    def test_all_environments_inherit_existing_dashboard_placement(self):
        require_dashboard_placement(self.config)
        self.assertFalse((ROOT / "railway.toml").exists(), "Unreviewed alternate config")

    def test_docker_healthcheck_and_restart_controls_remain_intact(self):
        self.assertEqual(self.config["build"], {
            "builder": "DOCKERFILE", "dockerfilePath": "backend/Dockerfile",
        })
        deploy = self.config["deploy"]
        self.assertEqual(deploy["healthcheckPath"], "/healthz")
        self.assertEqual(deploy["healthcheckTimeout"], 30)
        self.assertEqual(deploy["restartPolicyType"], "ON_FAILURE")
        self.assertEqual(deploy["restartPolicyMaxRetries"], 10)
        self.assertNotIn("environments", self.config, "P0 adds no environment overrides")

    def test_existing_single_worker_command_is_not_overridden(self):
        for path, deploy in deployment_sections(self.config):
            for key in ("startCommand", "preDeployCommand", "cronSchedule", "sleepApplication"):
                self.assertNotIn(key, deploy, f"{path}: unexpected runtime override")
        dockerfile = (ROOT / self.config["build"]["dockerfilePath"]).read_text(encoding="utf-8")
        commands = re.findall(r"^CMD\s+(\[.*\])\s*$", dockerfile, re.MULTILINE)
        self.assertEqual(len(commands), 1)
        command = json.loads(commands[0])
        self.assertEqual(command[:2], ["sh", "-c"])
        args = shlex.split(command[2])
        self.assertEqual(args[:3], ["exec", "uvicorn", "backend.app:app"])
        self.assertEqual(args.count("--workers"), 1)
        self.assertEqual(args[args.index("--workers") + 1], "1")
        self.assertNotIn("--reload", args)

    def test_guard_rejects_base_and_environment_placement_overrides(self):
        # Including null: it can alter inherited settings and is not omission.
        for scope in ("root", "production", "pr"):
            for key, value in (("region", "iad"), ("numReplicas", 2),
                               ("multiRegionConfig", {"asia-southeast1-eqsg3a": {"numReplicas": 1}}),
                               ("multiRegionConfig", None)):
                with self.subTest(scope=scope, key=key, value=value):
                    config = {"deploy": {}}
                    target = config if scope == "root" else config.setdefault("environments", {}).setdefault(scope, {})
                    target.setdefault("deploy", {})[key] = copy.deepcopy(value)
                    with self.assertRaisesRegex(ValueError, "placement override"):
                        require_dashboard_placement(config)


if __name__ == "__main__":
    unittest.main()
