import datetime as dt
import importlib.util
import json
import math
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("update_margin_data", ROOT / "scripts" / "update_margin_data.py")
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(MODULE)


def rec(market="twse", code="2330", previous=1000, buy=0, sell=0, cash=0,
        balance=1000, close=100, average=100, short_previous=10, short_balance=10):
    return {"market": market, "code": code, "name": code, "previous": previous,
            "buy": buy, "sell": sell, "cash": cash, "balance": balance,
            "close": close, "average": average,
            "short_previous": short_previous, "short_balance": short_balance}


def shorts():
    return {"twse": {"short_balance": 10, "short_previous": 9},
            "tpex": {"short_balance": 20, "short_previous": 18}}


class MarginDataTests(unittest.TestCase):
    def test_initial_sixty_percent_financing_is_166_67(self):
        state = MODULE.blank_state()
        result = MODULE.summarize(state, [rec()], shorts(), dt.date(2026, 1, 2))
        self.assertAlmostEqual(result["markets"]["combined"]["maintenance_ratio"], 166.67, places=2)

    def test_price_down_and_up_change_ratio_without_changing_cost(self):
        state = MODULE.blank_state()
        MODULE.summarize(state, [rec()], shorts(), dt.date(2026, 1, 2))
        down = MODULE.summarize(state, [rec(close=80, average=80)], shorts(), dt.date(2026, 1, 5))
        self.assertAlmostEqual(down["markets"]["combined"]["maintenance_ratio"], 133.33, places=2)
        up = MODULE.summarize(state, [rec(close=120, average=120)], shorts(), dt.date(2026, 1, 6))
        self.assertAlmostEqual(up["markets"]["combined"]["maintenance_ratio"], 200.0, places=2)

    def test_new_buy_uses_average_then_close_fallback(self):
        old = {"shares": 1000, "estimated_cost": 100000, "last_close": 100, "price_date": "2026-01-02"}
        rolled, _ = MODULE.roll_security(rec(previous=1000, buy=100, balance=1100, close=120, average=110), old, dt.date(2026, 1, 5))
        self.assertEqual(rolled["estimated_cost"], 111000)
        rolled, _ = MODULE.roll_security(rec(previous=1000, buy=100, balance=1100, close=120, average=None), old, dt.date(2026, 1, 5))
        self.assertEqual(rolled["estimated_cost"], 112000)

    def test_sell_and_cash_repayment_remove_previous_average_cost(self):
        old = {"shares": 1000, "estimated_cost": 120000, "last_close": 100, "price_date": "2026-01-02"}
        rolled, _ = MODULE.roll_security(rec(previous=1000, sell=100, cash=50, balance=850), old, dt.date(2026, 1, 5))
        self.assertEqual(rolled["estimated_cost"], 102000)

    def test_twse_and_tpex_use_identical_numerator_denominator_scope(self):
        state = MODULE.blank_state()
        result = MODULE.summarize(state, [rec(), rec("tpex", "6488", close=50, average=50)], shorts(), dt.date(2026, 1, 2))
        combined = result["markets"]["combined"]
        self.assertEqual(combined["collateral_market_value"], 150000)
        self.assertEqual(combined["estimated_financing_principal"], 90000)
        self.assertAlmostEqual(combined["maintenance_ratio"], 166.67, places=2)

    def test_split_preserves_total_cost(self):
        old = {"shares": 1000, "estimated_cost": 100000, "last_close": 100, "price_date": "2026-01-02"}
        rolled, event = MODULE.roll_security(rec(previous=2000, balance=2000, close=50, average=50), old, dt.date(2026, 1, 5))
        self.assertTrue(event["corporate_action"])
        self.assertEqual(rolled["estimated_cost"], 100000)
        self.assertEqual(rolled["shares"], 2000)

    def test_suspended_security_uses_recent_close_not_zero(self):
        old = {"shares": 1000, "estimated_cost": 100000, "last_close": 100, "price_date": "2026-01-02"}
        rolled, event = MODULE.roll_security(rec(close=None, average=None), old, dt.date(2026, 1, 5))
        self.assertTrue(event["stale"])
        self.assertEqual(rolled["last_close"], 100)

    def test_checked_in_payload_is_valid_and_no_old_denominator(self):
        payload = json.loads((ROOT / "margin-data.json").read_text(encoding="utf-8"))
        MODULE.validate_payload(payload)
        self.assertEqual(payload["model"]["name"], "rolling_estimated_margin_cost")
        self.assertGreaterEqual(payload["model"]["warmup_trading_days"], 120)
        self.assertNotIn("value", payload["margin_balance"])
        self.assertNotIn("financing_amount", payload["maintenance_ratio"])
        self.assertNotIn("FinMind", json.dumps(payload, ensure_ascii=False))

    def test_payload_rejects_nan_zero_and_mismatched_principal(self):
        payload = {"data_date": "2026-07-31", "model": {"name": "rolling_estimated_margin_cost", "warmup_trading_days": 120},
                   "margin_balance": {"estimated_financing_principal": math.nan, "balance_shares": 1},
                   "maintenance_ratio": {"value": 0, "collateral_market_value": 1, "estimated_financing_principal": 2},
                   "markets": {}}
        with self.assertRaises(ValueError):
            MODULE.validate_payload(payload)

    def test_workflow_has_two_after_hours_runs_and_persists_state(self):
        workflow = (ROOT / ".github" / "workflows" / "update-margin-data.yml").read_text(encoding="utf-8")
        self.assertIn('cron: "0 10 * * 1-5"', workflow)
        self.assertIn('cron: "0 11 * * 1-5"', workflow)
        self.assertIn("margin-cost-state.json", workflow)
        self.assertNotIn("FINMIND_TOKEN", workflow)


if __name__ == "__main__":
    unittest.main()
