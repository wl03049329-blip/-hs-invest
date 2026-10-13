import unittest
import radar_offline_server as preview

class PreviewSafetyTests(unittest.TestCase):
    def test_required_chart_assets_allowlisted(self):
        for path in ['/radar-history-core.js','/radar-history-source.js','/radar-history-view.js','/radar-history.css','/final-core-production.js','/finalized-core-score-snapshots-v1.json','/vendor/lightweight-charts/lightweight-charts.standalone.production.js']:
            self.assertTrue(preview.allowed_static(path), path)

    def test_no_directory_secrets_ledger_or_raw_audit(self):
        for path in ['/', '/.git/config', '/.env', '/tests/', '/research/hs_leverage/forward/daily-incidents.jsonl', '/research/hs_leverage/forward/hs_leverage_c_v1_forward_ledger.jsonl','/data/radar-history/twse/evidence/tpex-daily-20261013.json','/../index.html','/%2e%2e/index.html','/scripts/audit_radar_tpex.py']:
            self.assertFalse(preview.allowed_static(path), path)

    def test_only_loopback_and_no_public_tunnel(self):
        text=preview.Path(preview.__file__).read_text(encoding='utf-8')
        self.assertIn('(("127.0.0.1", 8877), Handler)',text)
        self.assertNotIn('0.0.0.0',text)
        self.assertIn('def do_HEAD(self):',text)
        self.assertIn("connect-src 'self'; worker-src 'none'",text)

if __name__=='__main__': unittest.main()
