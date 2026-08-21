"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ledger = require("../scripts/append_forward_action_policy_v1.js");

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "fapv1-test-"));
const ledgerPath = path.join(tempDirectory, "ledger.jsonl");
const records = [];

function append(record) {
  const result = ledger.appendRecord(ledgerPath, record);
  if (result.status === "APPENDED") records.push(result.record);
  return result;
}
function daily(date, score, options = {}) {
  return ledger.buildDailySignal({
    etf: options.etf || "00830",
    trading_date: date,
    source_date: date,
    appended_at: `${date}T13:31:00+08:00`,
    data_quality: options.data_quality || "PASS",
    source: { provider: "canonical-adjusted-ohlc", source_snapshot_hash: "abc" },
    dataset: { id: "historical-adjusted", revision: "test" },
    adjusted_ohlc: { close: 100, asof_available_at: `${date}T13:30:00+08:00` },
    episode: { asof_52w_high_date: options.highDate || "2025-01-02", new_asof_52w_high: Boolean(options.newHigh) },
    factors: {
      weekly_j: { raw_value: 10, mapping_bucket: "frozen", mapped_component: options.missing ? null : score },
      dd52: { raw_value: -20, mapping_bucket: "frozen", mapped_component: score },
      crash: { raw_value: 0, mapping_bucket: "frozen", mapped_component: score }
    },
    future_return: 999
  }, records);
}

try {
  assert.equal(ledger.dailySignalId("00830", "2025-04-07"), "FAPV1:DAILY_SIGNAL:00830:2025-04-07:FINAL_CORE_WEIGHT_V1:SHARED");
  assert.equal(ledger.executionReferenceId("00830", "2025-04-07", "2025-04-08"), "FAPV1:EXECUTION_REFERENCE:00830:2025-04-07:2025-04-08:ADJUSTED_OPEN");
  assert.equal(ledger.episodeId("00830", "2025-01-02"), "FAPV1:EPISODE:00830:2025-01-02");

  const first = daily("2025-04-07", 66);
  assert.equal(first.core.core_valid, true);
  assert.equal(first.virtual_ledgers.candidate.newly_crossed_tier, 1);
  assert.equal(first.virtual_ledgers.candidate.virtual_allocation, 0.15);
  assert.equal(first.virtual_ledgers.baseline.virtual_allocation, 0.20);
  assert.equal(first.provenance.adjusted_ohlc_snapshot_hash, "abc");
  assert.equal(Object.hasOwn(first, "future_return"), false, "daily signal must not persist future data");
  assert.equal(append(first).status, "APPENDED");
  assert.equal(append(first).status, "NOOP_IDENTICAL", "same deterministic payload is idempotent");
  assert.throws(() => ledger.appendRecord(ledgerPath, { record_id: "bad", record_type: "UNKNOWN" }), /RECORD_TYPE_INVALID/);

  const conflicting = { ...first, factors: { ...first.factors, dd52: { ...first.factors.dd52, mapped_component: 67 } } };
  assert.throws(() => append(conflicting), /RECORD_ID_CONFLICT/);

  const second = daily("2025-04-08", 75);
  assert.equal(second.virtual_ledgers.candidate.newly_crossed_tier, 2);
  append(second);
  const noRepeat = daily("2025-04-09", 75);
  assert.equal(noRepeat.virtual_ledgers.candidate.newly_crossed_tier, null, "a tier fires only once per episode");
  append(noRepeat);
  const third = daily("2025-04-10", 82);
  assert.equal(third.virtual_ledgers.candidate.newly_crossed_tier, 3);
  append(third);

  const failClosed = daily("2025-04-11", 90, { missing: true });
  assert.equal(failClosed.core.core_valid, false);
  assert.equal(failClosed.core.internal_score, null);
  assert.equal(failClosed.virtual_ledgers.candidate.action_status, "NO_ACTION_CORE_UNAVAILABLE");
  assert.equal(failClosed.virtual_ledgers.candidate.virtual_allocation, 0);
  append(failClosed);

  const reset = daily("2025-04-14", 66, { highDate: "2025-04-14", newHigh: true });
  assert.equal(reset.virtual_ledgers.candidate.newly_crossed_tier, 1, "new 52-week high starts a fresh episode");
  append(reset);

  const signalBeforeExecution = JSON.stringify(first);
  const execution = ledger.buildExecutionReference({
    etf: "00830", signal_record_id: first.record_id, signal_date: "2025-04-07", execution_date: "2025-04-08",
    adjusted_open: 101.25, appended_at: "2025-04-08T13:31:00+08:00", source: { provider: "canonical-adjusted-ohlc" }
  });
  assert.equal(execution.record_id, "FAPV1:EXECUTION_REFERENCE:00830:2025-04-07:2025-04-08:ADJUSTED_OPEN");
  assert.equal(JSON.stringify(first), signalBeforeExecution, "T+1 reference cannot mutate the prior signal");
  assert.equal(append(execution).status, "APPENDED");
  assert.equal(append(execution).status, "NOOP_IDENTICAL", "candidate and baseline share one execution reference");

  const close = ledger.buildEpisodeClose({
    etf: "00830", episode_id: first.episode.episode_id, closed_on: "2025-04-14", appended_at: "2025-04-14T13:31:00+08:00"
  }, records);
  assert.equal(close.classification, "NO_90", "episodes without tier 4 close as NO_90");
  append(close);
  const evaluation = ledger.buildEvaluation({ etf: "00830", episode_id: first.episode.episode_id, policy: "CANDIDATE", appended_at: "2025-04-14T13:32:00+08:00" });
  assert.equal(evaluation.record_id, `FAPV1:EVALUATION:00830:${first.episode.episode_id}:CANDIDATE`);
  append(evaluation);
  const correction = ledger.buildCorrection({ original_record_id: first.record_id, previous_value: 66, corrected_value: 66, reason: "source annotation", provenance: { source: "test" }, corrected_at: "2025-04-15T13:30:00+08:00" });
  assert.match(correction.record_id, /^FAPV1:CORRECTION:FAPV1:DAILY_SIGNAL:/);
  append(correction);
  assert.equal(records.find(record => record.record_id === first.record_id).core.internal_score, 66, "corrections are appended and never rewrite originals");

  assert.doesNotThrow(() => ledger.verifyChain(ledger.readLedger(ledgerPath)));
  const brokenPath = path.join(tempDirectory, "broken.jsonl");
  const broken = ledger.readLedger(ledgerPath);
  broken[1].previous_record_hash = "corrupted";
  fs.writeFileSync(brokenPath, broken.map(JSON.stringify).join("\n") + "\n");
  assert.throws(() => ledger.verifyChain(ledger.readLedger(brokenPath)), /LEDGER_PREVIOUS_HASH_MISMATCH/);
  console.log("PASS forward-action-policy-v1 ledger tests");
} finally {
  fs.rmSync(tempDirectory, { recursive: true, force: true });
}
