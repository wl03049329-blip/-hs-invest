const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const version = JSON.parse(fs.readFileSync(path.join(root, "version.json"), "utf8"));
const versionScript = fs.readFileSync(path.join(root, "app-version.js"), "utf8");
const guideScript = fs.readFileSync(path.join(root, "beginner-guide.js"), "utf8");
const css = fs.readFileSync(path.join(root, "formal-black-gold.css"), "utf8");

assert.equal(version.version, "3.0.0", "the product version has one SemVer source");
assert.match(versionScript, /version\.json/);
assert.match(versionScript, /document\.title\s*=/);
assert.match(versionScript, /data-hs-version-full/);
assert.doesNotMatch(html, /HS ETF 股市雷達 2\.0|VERSION 2\.0/);
assert.match(html, /id="hsOnboardingOpenHome"/);
assert.match(html, /id="hsOnboardingOpenHeader"[^>]*aria-label="重新開啟新手導覽"/);
assert.match(html, /id="hsBeginnerGuide"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-hidden="true"[^>]*inert/);
for (const id of ["hsBeginnerGuidePrevious", "hsBeginnerGuideNext", "hsBeginnerGuideFinish", "hsBeginnerGuideClose", "hsBeginnerGuideProgress"]) {
  assert.ok(html.includes(`id="${id}"`), `missing onboarding control ${id}`);
}
assert.equal((guideScript.match(/\{ kicker:/g) || []).length, 7, "guide contains exactly seven pages");
assert.match(guideScript, /event\.key === "Escape"/);
assert.match(guideScript, /localStorage\.setItem\(STORAGE_KEY/);
assert.match(guideScript, /catch \(_\) \{ \/\* optional preference \*\/ \}/);
assert.doesNotMatch(guideScript, /open\(\);\s*$/m, "guide must never auto-open");
assert.ok(guideScript.includes("初次使用"));
assert.ok(guideScript.includes("分數高不等於必須買進"));
assert.ok(guideScript.includes("正式分數為主"));
assert.ok(guideScript.includes("HS 不預測市場"));
assert.match(css, /\.hsBeginnerGuide\.is-open/);
assert.match(css, /prefers-reduced-motion:reduce/);

for (const [file, source] of [["app-version.js", versionScript], ["beginner-guide.js", guideScript]]) {
  assert.doesNotThrow(() => new Function(source), `${file} syntax`);
}
const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
  .map(match => match[1]).filter(source => source.trim());
assert.ok(inlineScripts.length > 0);
for (const source of inlineScripts) assert.doesNotThrow(() => new Function(source), "inline script syntax");

console.log("HS 3 version source and 7-page onboarding regression: PASS");
