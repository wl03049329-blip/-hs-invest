"""FINALIZED-only background alert evaluation; never computes market data or C4."""
from __future__ import annotations

import asyncio
import hashlib
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .push_service import PushService

ENGINE_VERSION = "HS_BACKGROUND_ALERT_ENGINE_V1"
RULES_VERSION = "HS_RADAR_PUSH_RULES_V1"
SOURCE_RULES_VERSION = "HS_RADAR_ALERT_RULES_V1"
ROOT = Path(__file__).resolve().parent.parent
FINALIZED_PATH = ROOT / "finalized-core-score-snapshots-v1.json"
BRIDGE_PATH = Path(__file__).resolve().parent / "background_alert_bridge.js"

class BackgroundAlertError(RuntimeError): pass

def _canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))

def _fingerprint(value: Any) -> str:
    return hashlib.sha256(_canonical(value).encode()).hexdigest()

def finalized_context(path: Path = FINALIZED_PATH) -> dict[str, Any]:
    artifact=json.loads(path.read_text(encoding="utf-8"))
    snapshots=[row for row in artifact.get("snapshots",[]) if row.get("finalized") is True and row.get("snapshot_type")=="FINALIZED_CLOSE"]
    if artifact.get("core_score_version")!="FINAL_CORE_WEIGHT_V1" or not snapshots: raise BackgroundAlertError("FINALIZED_UNAVAILABLE")
    snapshots.sort(key=lambda row: row.get("date", "")); current=snapshots[-1]; previous=snapshots[-2] if len(snapshots)>1 else current
    if any(row.get("core_score_version") not in (None,"FINAL_CORE_WEIGHT_V1") for row in current.get("rows",[])): raise BackgroundAlertError("FINALIZED_VERSION_MISMATCH")
    return {"date":current["date"],"fingerprint":_fingerprint(current),"current":current,"previous":previous}

def allowed_symbols(context: dict[str, Any]) -> set[str]:
    return {str(row.get("symbol")) for row in context["current"].get("rows",[]) if row.get("symbol")}

def validate_rules(value: dict[str, Any], universe: set[str]) -> dict[str, Any]:
    if not isinstance(value,dict) or value.get("version")!=SOURCE_RULES_VERSION or not isinstance(value.get("global"),dict) or not isinstance(value.get("etfs",{}),dict): raise BackgroundAlertError("INVALID_RULE_SNAPSHOT")
    allowed={"cross_level","downward_cross","levels","score_enabled","score_threshold","distance","percentile_enabled","percentiles","data_status","data_recovery"}
    def rule(source: Any) -> dict[str,Any]:
        if not isinstance(source,dict) or set(source)-allowed: raise BackgroundAlertError("INVALID_RULE_FIELDS")
        score=source.get("score_threshold"); distance=source.get("distance"); percentiles=source.get("percentiles")
        if isinstance(score,bool) or not isinstance(score,int) or not 0<=score<=100: raise BackgroundAlertError("INVALID_SCORE_THRESHOLD")
        if distance not in (0,1,2): raise BackgroundAlertError("INVALID_DISTANCE")
        if not isinstance(percentiles,list) or any(value not in (85,90,95) for value in percentiles): raise BackgroundAlertError("INVALID_PERCENTILE")
        levels=source.get("levels");
        if levels!="ALL" and not isinstance(levels,list): raise BackgroundAlertError("INVALID_LEVELS")
        for key in ("cross_level","downward_cross","score_enabled","percentile_enabled","data_status","data_recovery"):
            if not isinstance(source.get(key),bool): raise BackgroundAlertError("INVALID_RULE_BOOLEAN")
        return json.loads(json.dumps(source))
    normalized={"version":SOURCE_RULES_VERSION,"global":rule(value["global"]),"etfs":{}}
    for symbol,entry in value.get("etfs",{}).items():
        if symbol not in universe or not isinstance(entry,dict) or entry.get("mode") not in ("inherit","custom"): raise BackgroundAlertError("INVALID_ETF_OVERRIDE")
        normalized["etfs"][symbol]={"mode":entry["mode"],"rules":rule(entry.get("rules",value["global"]))}
    return normalized

def bridge_input(context: dict[str,Any], preferences: dict[str,Any], state: dict[str,Any]|None) -> dict[str,Any]:
    current={str(row.get("symbol")):row for row in context["current"].get("rows",[])}; previous={str(row.get("symbol")):row for row in context["previous"].get("rows",[])}
    symbols=[]
    for symbol,row in current.items():
        research=ROOT / "research" / "c4_historical" / f"{symbol}.json"
        prior=previous.get(symbol,row)
        normalized_current={**row,"trading_date":context["current"]["date"],"display_score":int(float(row["final_core_score"])) if row.get("final_core_score") is not None else None}
        normalized_previous={**prior,"trading_date":context["previous"]["date"],"display_score":int(float(prior["final_core_score"])) if prior.get("final_core_score") is not None else None}
        symbols.append({"symbol":symbol,"current":normalized_current,"previous":normalized_previous,"research_path":str(research) if research.exists() else None})
    return {"preferences":preferences,"state":state,"symbols":symbols}

def run_bridge(payload: dict[str,Any]) -> dict[str,Any]:
    process=subprocess.run(["node",str(BRIDGE_PATH)],input=json.dumps(payload,ensure_ascii=True),text=True,encoding="utf-8",capture_output=True,timeout=15,check=False)
    if process.returncode: raise BackgroundAlertError("ALERT_ENGINE_FAILED")
    result=json.loads(process.stdout)
    if result.get("engine_version")!=ENGINE_VERSION or result.get("rule_version")!=SOURCE_RULES_VERSION: raise BackgroundAlertError("ALERT_ENGINE_VERSION_MISMATCH")
    return result

class BackgroundAlertEvaluator:
    def __init__(self,push_service:PushService,*,finalized_path:Path=FINALIZED_PATH,interval_seconds:int=60)->None:
        self.push_service=push_service; self.store=push_service.store; self.finalized_path=finalized_path; self.interval_seconds=interval_seconds
        self.last_evaluation_at=None; self.last_evaluation_fingerprint=None; self.last_candidate_count=0; self.last_bundle_count=0; self.failure_count=0

    def sync_rules(self,subscription_id:str,rules:dict[str,Any])->dict[str,Any]:
        context=finalized_context(self.finalized_path); preferences=validate_rules(rules,allowed_symbols(context)); baseline=run_bridge(bridge_input(context,preferences,None))
        record=self.store.sync_rules(subscription_id,rules=preferences,rule_version=RULES_VERSION,baseline={"date":context["date"],"fingerprint":context["fingerprint"],"alert_state":baseline["state"]})
        return{"status":"SYNCED","rule_version":RULES_VERSION,"baseline_finalized_date":record["baseline_finalized_date"],"pending_push_count":0}

    def evaluate_once(self)->dict[str,Any]:
        context=finalized_context(self.finalized_path); subscriptions=self.store.active_records(); candidates=bundles=successes=failures=0
        for record in subscriptions:
            if record.get("rules_sync_status")!="SYNCED" or not record.get("push_rules"): continue
            if record.get("last_evaluated_finalized_fingerprint")==context["fingerprint"]: continue
            subscription_failures=0
            try: result=run_bridge(bridge_input(context,record["push_rules"],record.get("alert_state")))
            except Exception: failures+=1; self.failure_count+=1; continue
            candidates+=len(result["alerts"]); bundles+=len(result["bundles"]); handled_alerts=list(record.get("handled_alert_ids") or []); handled_bundles=list(record.get("handled_bundle_ids") or []); pushed_at=None
            for bundle in result["bundles"]:
                if bundle["bundle_id"] in handled_bundles: continue
                alert_ids=[item["alert_id"] for item in bundle["alerts"]]; handled_bundles.append(bundle["bundle_id"]); handled_alerts.extend(alert_ids)
                try: self.push_service.send_alert_bundle(record["subscription_id"],bundle); successes+=1; pushed_at=datetime.now(timezone.utc).isoformat()
                except Exception: failures+=1; subscription_failures+=1; self.failure_count+=1
            self.store.save_evaluation(record["subscription_id"],fingerprint=context["fingerprint"],alert_state=result["state"],handled_alert_ids=handled_alerts,handled_bundle_ids=handled_bundles,pushed_at=pushed_at,failure_increment=subscription_failures)
        self.last_evaluation_at=datetime.now(timezone.utc).isoformat(); self.last_evaluation_fingerprint=context["fingerprint"]; self.last_candidate_count=candidates; self.last_bundle_count=bundles
        metrics={"status":"BACKGROUND_ALERT_EVALUATION","evaluation_fingerprint":context["fingerprint"],"subscription_count":len(subscriptions),"candidate_count":candidates,"bundle_count":bundles,"push_success_count":successes,"push_failure_count":failures}
        print(json.dumps(metrics,separators=(",",":")),flush=True)
        return metrics

    async def run_forever(self)->None:
        while True:
            try: await asyncio.to_thread(self.evaluate_once)
            except Exception: pass
            await asyncio.sleep(self.interval_seconds)

    def diagnostics(self)->dict[str,Any]:
        return{"background_alert_engine":ENGINE_VERSION,"push_last_evaluation":self.last_evaluation_at,"push_last_evaluation_fingerprint":self.last_evaluation_fingerprint,"push_last_candidate_count":self.last_candidate_count,"push_last_bundle_count":self.last_bundle_count,"push_background_failure_count":self.failure_count}
