const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const workflow = fs.readFileSync(
  path.join(root, ".github", "workflows", "update-trump-news.yml"),
  "utf8"
);

assert.match(workflow, /ref:\s*main/);
assert.match(workflow, /fetch-depth:\s*0/);
assert.match(workflow, /group:\s*update-trump-market-watch/);
assert.match(workflow, /cancel-in-progress:\s*false/);
assert.match(workflow, /git diff --cached --quiet/);
assert.match(workflow, /TRUMP_NEWS_NO_CHANGES/);
assert.match(workflow, /for attempt in 1 2 3/);
assert.match(workflow, /git fetch origin main/);
assert.match(workflow, /git rebase origin\/main/);
assert.match(workflow, /git push origin HEAD:main/);
assert.match(workflow, /TRUMP_REBASE_CONFLICT/);
assert.match(workflow, /TRUMP_PUSH_FAILED_AFTER_RETRIES/);
assert.doesNotMatch(workflow, /git push[^\n]*(?:--force|-f\b)/);
assert.doesNotMatch(workflow, /git reset --hard/);

const updater = fs.readFileSync(
  path.join(root, "scripts", "update_trump_news.py"),
  "utf8"
);
assert.ok(updater.length > 0, "Trump updater must remain present");

console.log("PASS Trump workflow safe rebase/retry and no-op contract");
