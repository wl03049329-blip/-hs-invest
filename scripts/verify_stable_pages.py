"""Read-only Pages Actions receipt + original exact public-JSON verification.

No collection, price calculation, ledger writes, approval or dispatch here.
"""
import argparse
import json
import os
import pathlib
import re
import subprocess
import time
from urllib.request import urlopen


def verify(root, base_url, attempts=6, delay=20, fetcher=urlopen, run_reader=None):
    from scripts.update_radar_daily import SYMBOLS, path_for, PUBLIC_STATUS
    root = pathlib.Path(root)
    expected = {str(path_for(root, s).relative_to(root)).replace('\\', '/'):
                json.loads(path_for(root, s).read_text(encoding='utf-8')) for s in SYMBOLS}
    expected[PUBLIC_STATUS] = json.loads((root / PUBLIC_STATUS).read_text(encoding='utf-8'))
    if run_reader is None:
        def run_reader():
            return json.loads(subprocess.check_output([
                'gh', 'api', 'repos/' + os.environ['GITHUB_REPOSITORY'] +
                '/actions/workflows/hs-stable-pages.yml/runs?branch=main&status=success&per_page=20'], text=True))['workflow_runs']
    for attempt in range(attempts):
        try:
            with fetcher(base_url.rstrip('/') + '/app-release.json?verify=' + str(time.time_ns()), timeout=25) as response:
                receipt = json.loads(response.read())
            commit = receipt.get('deployment_commit', '')
            if receipt.get('schema') != 'HS_STABLE_APP_RELEASE_V1' or not re.fullmatch('[a-f0-9]{40}', commit):
                raise ValueError('PAGES_RECEIPT_INVALID')
            if not any(r.get('head_sha') == commit and r.get('head_branch') == 'main' and
                       r.get('status') == 'completed' and r.get('conclusion') == 'success' for r in run_reader()):
                raise ValueError('PAGES_RUN_NOT_SUCCESSFUL_FOR_PUBLIC_COMMIT')
            for name, payload in expected.items():
                with fetcher(base_url.rstrip('/') + '/' + name + '?v=' + payload['content_sha256'], timeout=25) as response:
                    if json.loads(response.read()) != payload:
                        raise ValueError('PUBLICATION_MISMATCH:' + name)
            print(json.dumps({'event': 'PUBLICATION_VERIFIED', 'files': len(expected), 'pages_commit': commit}))
            return True
        except Exception as exc:
            print(json.dumps({'event': 'PUBLICATION_PENDING', 'attempt': attempt + 1, 'reason': str(exc)}))
            if attempt + 1 < attempts:
                time.sleep(delay)
    return False


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--base-url', required=True)
    args = p.parse_args()
    raise SystemExit(0 if verify(pathlib.Path(__file__).resolve().parents[1], args.base_url) else 1)
