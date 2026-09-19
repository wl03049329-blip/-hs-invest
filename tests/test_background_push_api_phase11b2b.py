from __future__ import annotations
import os,tempfile,unittest
from fastapi.testclient import TestClient
from backend.push_service import PushConfig,PushService
from backend.push_store import PushSubscriptionStore
from backend.state_store import StateStore

SUB={"endpoint":"https://fcm.googleapis.com/fcm/send/b2b-api","keys":{"p256dh":"A"*87,"auth":"B"*22}}
RULE={"cross_level":True,"downward_cross":True,"levels":"ALL","score_enabled":False,"score_threshold":50,"distance":0,"percentile_enabled":False,"percentiles":[90],"data_status":True,"data_recovery":True}
PREF={"version":"HS_RADAR_ALERT_RULES_V1","global":RULE,"etfs":{}}
class SchedulerStub:
    mode="production"
    async def run_forever(self): return None

class ApiTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);os.environ["HS_LIVE_DISABLE_SCHEDULER"]="1";os.environ["HS_BACKGROUND_ALERT_DISABLE"]="1";os.environ["HS_LIVE_VOLUME_PATH"]=self.temp.name;from backend.app import create_app;store=StateStore(self.temp.name);self.sent=[];service=PushService(PushSubscriptionStore(store.root),config=PushConfig("B"+"A"*86,"private-test","https://example.test"),sender=lambda **kw:self.sent.append(kw));self.client=TestClient(create_app(store,SchedulerStub(),backend_mode="production",push_service=service))
    def subscribe(self): return self.client.post("/api/push/subscribe",json={"subscription":SUB,"rules":PREF})
    def test_01_subscribe_syncs_rules_and_baselines_zero(self):
        response=self.subscribe();self.assertEqual(response.status_code,200);self.assertEqual(response.json()["rules"]["status"],"SYNCED");self.assertEqual(response.json()["rules"]["pending_push_count"],0);self.assertEqual(self.sent,[])
    def test_02_rule_sync_rejects_unknown_subscription(self): self.assertEqual(self.client.post("/api/push/rules",json={"subscription_id":"unknown","rules":PREF}).status_code,404)
    def test_03_fixed_alert_simulation_sends(self):
        sid=self.subscribe().json()["subscription_id"];response=self.client.post("/api/push/test-alert",json={"subscription_id":sid});self.assertEqual((response.status_code,response.json()["status"]),(200,"SENT"))
    def test_04_arbitrary_alert_simulation_rejected(self):
        sid=self.subscribe().json()["subscription_id"];response=self.client.post("/api/push/test-alert",json={"subscription_id":sid,"etf":"0050","message":"buy"});self.assertEqual(response.status_code,422)
    def test_05_health_exposes_engine_without_secret(self):
        response=self.client.get("/healthz");self.assertEqual(response.json()["background_alert_engine"],"HS_BACKGROUND_ALERT_ENGINE_V1");self.assertNotIn("private-test",response.text)
if __name__=="__main__":unittest.main(verbosity=2)
