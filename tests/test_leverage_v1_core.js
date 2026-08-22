const assert = require("node:assert/strict");
const fs = require("node:fs");
const core = require("../leverage-v1-core.js");

const rows = (lastClose) => [100, 100, 100, 100, 100, lastClose].map((close, index) => ({
  date: `2026-08-${String(index + 10).padStart(2, "0")}`,
  open: close,
  high: close,
  low: close,
  close
}));

assert.deepEqual(core.V1_CONFIG, {
  strategy: "HS_LEVERAGE_C_V1",
  threshold: 2.033335,
  trainingEnd: "2025-12-31",
  forwardStart: "2026-08-24"
});

const below = core.evaluateCrashVelocity(rows(89.84));
assert.equal(below.status, "STANDBY");
assert.equal(below.trigger, false);
assert.ok(below.value < core.V1_CONFIG.threshold);

const atThreshold = core.evaluateCrashVelocity(rows(89.833325));
assert.equal(atThreshold.status, "TRIGGER");
assert.equal(atThreshold.trigger, true);
assert.ok(Math.abs(atThreshold.value - core.V1_CONFIG.threshold) < 1e-10);

const above = core.evaluateCrashVelocity(rows(89.8));
assert.equal(above.status, "TRIGGER");
assert.equal(above.trigger, true);
assert.ok(above.value > core.V1_CONFIG.threshold);

const missing = core.evaluateCrashVelocity(rows(90).slice(0, 5));
assert.equal(missing.status, "DATA_UNAVAILABLE");
assert.equal(missing.available, false);
assert.equal(missing.trigger, false);

// V1 only accepts 00631L adjusted/restored OHLC rows. Tactical/benchmark inputs cannot affect it.
assert.deepEqual(
  core.evaluateCrashVelocity(rows(89.84), { ...core.V1_CONFIG, tacticalScore: 99, benchmark: "0050" }),
  below
);

const source = fs.readFileSync(require.resolve("../leverage-v1-core.js"), "utf8");
assert.doesNotMatch(source, /localStorage|appendForward|recordForward|saveTradeState|fetch\(/);

console.log("HS LEVERAGE V1 frozen crash-velocity contract: PASS");
