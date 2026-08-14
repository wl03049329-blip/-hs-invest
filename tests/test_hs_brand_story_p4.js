const assert=require("assert");
const fs=require("fs");
const path=require("path");

const root=path.resolve(__dirname,"..");
const html=fs.readFileSync(path.join(root,"index.html"),"utf8");
const css=fs.readFileSync(path.join(root,"formal-black-gold.css"),"utf8");
const start=html.indexOf('<div class="hsBrandStory">');
const end=html.indexOf('<script src="market-ui-core.js"');
assert.ok(start>=0&&end>start,"brand story must exist");
const story=html.slice(start,end);

assert.match(html,/id="openHsStory"/);assert.match(html,/id="closeHsStory"/);assert.match(html,/function openHsStory/);assert.match(html,/function closeHsStory/);
console.log("TEST 1 PASS: About page opens, closes and returns through the existing modal flow");

const sections=["why","belief","universe","mega-tech","how","score","score-guide","not-all-in","backtest","no-look-ahead","iteration","learned","not","long-term","tools","purpose","philosophy","finale"];
for(const id of sections)assert.ok(story.includes(`id="hs-story-${id}"`),`missing section ${id}`);
console.log("TEST 2 PASS: all required long-form brand sections exist");

assert.match(story,/00757｜統一FANG\+/);assert.match(story,/正式可評分的觀察標的/);
console.log("TEST 3 PASS: 00757 is present as a native-history candidate");

assert.match(story,/009815 × 00757/);assert.match(story,/Mega Tech.*配置槽位/s);
console.log("TEST 4 PASS: 009815 × 00757 share one Mega Tech allocation slot");

assert.match(story,/資料不夠，就不假裝有答案。/);
console.log("TEST 5 PASS: data maturity principle is preserved");

assert.match(story,/最終，我只會從兩者之中選擇一個。/);
console.log("TEST 6 PASS: final one-of-two allocation rule is explicit");

assert.match(story,/NO LOOK-AHEAD/);assert.match(story,/當時真的看得到嗎？/);assert.match(story,/只能使用那一天當下真正已經知道的資料/);
console.log("TEST 7 PASS: no-look-ahead and as-of principle are explicit");

assert.match(story,/THE BACKTEST STORY/);assert.match(story,/重新計算。/);assert.match(story,/重新回測。/);assert.match(story,/重新檢查。/);
console.log("TEST 8 PASS: backtest, rejection and rebuild story is present");

assert.match(story,/我是科技樂觀主義者。/);assert.match(story,/AI、機器人、自動駕駛、半導體、能源科技、基因療法/);
console.log("TEST 9 PASS: technology optimism belief is present");

assert.match(story,/HS 怎麼使用？/);assert.match(story,/資金節奏控制器。/);assert.match(story,/分批，而不是猜最低點。紀律，而不是預測。/);
console.log("TEST 10 PASS: HS usage and capital pacing are present");

assert.match(html,/HSFinalCoreProduction\?\.LABELS/);assert.match(html,/id="hsCanonicalScoreGuide"/);assert.doesNotMatch(story,/週 J 低檔：?30%|52 週高點回檔：?55%|20 日急跌：?15%/);
console.log("TEST 11 PASS: Score Guide uses canonical LABELS without a second hard-coded methodology");

assert.match(css,/@media\(max-width:620px\)/);assert.match(css,/\.hsBrandStory\{[^}]*overflow-wrap:anywhere/);assert.match(css,/\.hsBrandEtfList,.hsMegaPair,.hsBrandSteps,.hsToolGrid\{grid-template-columns:1fr\}/);
console.log("TEST 12 PASS: mobile long-form layout and overflow guards are present");

assert.match(story,/好的投資訊號，本來就不應該天天出現。/);assert.match(story,/Stay optimistic about the future\./);assert.match(story,/Stay disciplined with the price\./);assert.match(story,/對未來保持樂觀。/);assert.match(story,/對價格保持紀律。/);
console.log("TEST 13 PASS: final HS brand spirit is preserved");

console.log("P4 HS brand story tests: 13/13 PASS");
