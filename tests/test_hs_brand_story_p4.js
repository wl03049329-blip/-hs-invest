const assert=require("assert");
const fs=require("fs");
const path=require("path");

const root=path.resolve(__dirname,"..");
const html=fs.readFileSync(path.join(root,"index.html"),"utf8");
const css=fs.readFileSync(path.join(root,"formal-black-gold.css"),"utf8");
const start=html.indexOf('<div class="hsBrandStory hsStoryHub">');
const end=html.indexOf('<script src="market-ui-core.js"');
assert.ok(start>=0&&end>start,"brand story must exist");
const story=html.slice(start,end);

assert.match(html,/id="openHsStory"/);assert.match(html,/id="closeHsStory"/);assert.match(html,/function openHsStory/);assert.match(html,/function closeHsStory/);
console.log("TEST 1 PASS: About page opens, closes and returns through the existing modal flow");

const chapters=["intention","etfs","birth","research","leverage","future"];
for(const id of chapters)assert.ok(story.includes(`id="hs-story-${id}"`)&&story.includes(`data-story-target="hs-story-${id}"`),`missing Story V2 chapter/navigation ${id}`);
assert.match(story,/我的初衷/);assert.match(story,/我選擇的 ETF/);assert.match(story,/HS 的誕生/);assert.match(story,/研究與回測/);assert.match(story,/00631L 實驗室/);assert.match(story,/讓未來回答/);
assert.match(html,/function setHsStoryActive/);assert.match(html,/function syncHsStoryActive/);assert.match(html,/\[data-story-target\]/);
console.log("TEST 2 PASS: six Chinese-first Story chapters have active navigation");

const sections=["why","belief","universe","mega-tech","how","score","score-guide","not-all-in","backtest","no-look-ahead","iteration","learned","not","long-term","tools","purpose","philosophy","finale"];
for(const id of sections)assert.ok(story.includes(`id="hs-story-${id}"`),`missing section ${id}`);
console.log("TEST 3 PASS: all original long-form brand content remains represented");

assert.match(story,/00757｜統一FANG\+/);assert.match(story,/正式可評分的觀察標的/);
console.log("TEST 4 PASS: 00757 is present as a native-history candidate");

assert.match(story,/009815 × 00757/);assert.match(story,/Mega Tech.*配置槽位/s);
console.log("TEST 5 PASS: 009815 × 00757 share one Mega Tech allocation slot");

assert.match(story,/資料不夠，就不假裝有答案。/);
console.log("TEST 6 PASS: data maturity principle is preserved");

assert.match(story,/最終，我只會從兩者之中選擇一個。/);
console.log("TEST 7 PASS: final one-of-two allocation rule is explicit");

assert.match(story,/NO LOOK-AHEAD/);assert.match(story,/當時真的看得到嗎？/);assert.match(story,/只能使用那一天當下真正已經知道的資料/);
console.log("TEST 8 PASS: no-look-ahead and as-of principle are explicit");

assert.match(story,/研究與回測/);assert.match(story,/重新計算。/);assert.match(story,/重新回測。/);assert.match(story,/重新檢查。/);
console.log("TEST 9 PASS: backtest, rejection and rebuild story is present");

assert.match(story,/我是科技樂觀主義者。/);assert.match(story,/AI、機器人、自動駕駛、半導體、能源科技、基因療法/);
console.log("TEST 10 PASS: technology optimism belief is present");

assert.match(story,/HS 怎麼使用？/);assert.match(story,/資金節奏控制器。/);assert.match(story,/分批，而不是猜最低點。紀律，而不是預測。/);
console.log("TEST 11 PASS: HS usage and capital pacing are present");

assert.match(html,/HSFinalCoreProduction\?\.LABELS/);assert.match(html,/id="hsCanonicalScoreGuide"/);assert.doesNotMatch(story,/週 J 低檔：?30%|52 週高點回檔：?55%|20 日急跌：?15%/);
console.log("TEST 12 PASS: Score Guide uses canonical LABELS without a second hard-coded methodology");

assert.match(css,/@media\(max-width:620px\)/);assert.match(css,/\.hsBrandStory\{[^}]*overflow-wrap:anywhere/);assert.match(css,/\.hsStoryNav\{[^}]*overflow-x:auto/);assert.match(css,/\.hsStoryProblemFlow\{grid-template-columns:1fr/);
console.log("TEST 13 PASS: mobile chapter navigation and overflow guards are present");

assert.match(story,/好的投資訊號，本來就不應該天天出現。/);assert.match(story,/Stay optimistic about the future\./);assert.match(story,/Stay disciplined with the price\./);assert.match(story,/對未來保持樂觀。/);assert.match(story,/對價格保持紀律。/);
console.log("TEST 14 PASS: final HS brand spirit is preserved");

for(const [zh,en] of [["未來驗證","Forward Test"],["未來模擬驗證","Forward Shadow"],["規則已定版","Frozen"],["資料不足，不做判斷","Fail Closed"],["不偷看未來","No Look-Ahead"],["只新增，不回頭改寫","Append-only"],["核心分數","Core Score"],["急跌速度","Crash Velocity"]]){
  assert.match(story,new RegExp(zh));assert.match(story,new RegExp(en,"i"));
}
assert.match(story,/不知道的時候，就讓它保持不知道。/);assert.match(story,/我要讓未來的市場來回答。/);assert.match(story,/data-story-target="hs-story-/);
console.log("TEST 15 PASS: Chinese-first research terms, 00631L lab and continuation CTAs are present");

console.log("HS Story V2 tests: 15/15 PASS");
