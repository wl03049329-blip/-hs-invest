"""Read-only audit of the immutable TWSE OpenAPI mirror and HS close records."""
import json
import subprocess
from urllib.request import urlopen
from scripts.update_00631l_observation import ROOT, SYMBOL, verify_archive

PIN = "a77b63cd27fdd1c93298979b1d6b39c0cd1a7aaa"
BASE = f"https://raw.githubusercontent.com/88jiayu/tw-chip-open-data/{PIN}/data/official/price_twse/"
AUDIT = [
    ("09", "0d9831ef", "44c0501fe8bac85a57296ae115c0c3feec9e907bc87083c0d331b85813080303"),
    ("10", "2655fce1", "b9b0b0c0a99a2a93f2f87a5b788ba817b8d2bf13b8f11aac113dbcd48e2761fb"),
    ("11", "56c9a25c", "444b843cc56f5f1d121ad5475852f3f08447388966db8312f37dce05a2f5bf0b"),
    ("12", "91f2fe61", "2415d34e9df274c2833846877d3369cd9ce3dacd90e4ba410d877f90e6cb73f5"),
    ("16", "dce192a9", "7e495dbac1e92e51ba9f22982b4dcfecfda20a90257529ac1470117561a66450"),
    ("17", "f9441183", "e3a6f77179bae4208a96941376a35a5c286b2c84353c737b934bff0744951118"),
]

if __name__ == "__main__":
    for suffix, commit, fingerprint in AUDIT:
        day = f"2026-11-{suffix}"
        q = json.loads(subprocess.check_output(["git", "show", commit + ":market-quotes.json"], cwd=ROOT))
        close, = [r["price"] for r in q["items"] if r["code"] == SYMBOL and r["date"] == day
                  and r["market"] == "TWSE" and r["quote_mode"] == "close"]
        with urlopen(BASE + day + ".json", timeout=15) as response:
            raw = response.read(4_000_001)
        print(day, fingerprint, *verify_archive(raw, day, close, fingerprint))
