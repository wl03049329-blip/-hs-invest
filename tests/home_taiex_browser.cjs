"use strict";
const { chromium, webkit } = require("playwright-core");
const assert = require("node:assert/strict");
const fs = require("node:fs"), http = require("node:http"), path = require("node:path");
const core = require("../home-taiex-core");
const known = require("../home-taiex.json");
const { build } = require("../scripts/build_stable_app.cjs");
const out = process.env.HS_TAIEX_TEST_OUT;
if (!out) throw Error("HS_TAIEX_TEST_OUT_REQUIRED");
const site = build({out:path.join(out,"site")}).out;
const types = {".html":"text/html;charset=utf-8", ".js":"text/javascript", ".css":"text/css", ".json":"application/json", ".svg":"image/svg+xml", ".webmanifest":"application/manifest+json"};
let payload = null, reads = 0;
const server = http.createServer((req,res) => {
  const file = path.resolve(site, "." + new URL(req.url,"http://localhost").pathname);
  if (file === path.join(site,"home-taiex.json")) {
    reads++;
    return res.writeHead(payload ? 200 : 503, {"Content-Type":"application/json","Cache-Control":"no-store"})
      .end(JSON.stringify(payload));
  }
  const target = file === site ? path.join(site,"index.html") : file;
  if (!target.startsWith(site+path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) return res.writeHead(404).end();
  res.writeHead(200,{"Content-Type":types[path.extname(target)] || "application/octet-stream"}).end(fs.readFileSync(target));
});
const next = {...known, trade_date:"2026-11-09", previous_trade_date:known.trade_date,
  close_cents:known.close_cents+30000, previous_close_cents:known.close_cents, change_cents:30000,
  retrieved_at:"2026-11-09T09:00:00.000Z", updated_at:"2026-11-09T09:00:00.000Z"};
async function run(){
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const base = "http://127.0.0.1:"+server.address().port+"/";
  for (const [name,engine] of [["chrome",chromium],["webkit",webkit]]) {
    const browser = await engine.launch(name==="chrome"?{channel:"chrome"}:{});
    try {
      for (const width of [320,375,390,1280]) {
        const ctx = await browser.newContext({viewport:{width,height:900},isMobile:width<600,hasTouch:width<600,timezoneId:"Asia/Taipei"});
        try {
          await ctx.route(u=>u.origin!==new URL(base).origin,r=>r.fulfill({status:503,headers:{"access-control-allow-origin":"*"},body:""}));
          payload = null; reads = 0;
          const page = await ctx.newPage();
          await page.clock.setFixedTime(new Date("2026-11-15T01:00:00.000Z"));
          const errors = [];
          page.on("pageerror", error=>errors.push(error.message));
          await page.goto(base);
          await page.waitForFunction(()=>self.HSStableApp?.status().phase==="CURRENT",null,{timeout:50000});
          const card = page.locator("#homeTaiexCard"), retail=page.locator("#homeTmfRatioCard");
          const idle = () => page.locator('#homeTaiexCard[aria-busy="false"]').waitFor();
          await idle();
          const read = () => card.evaluate(e=>[e.querySelector("b").textContent,e.querySelector("strong").textContent,e.querySelector("time").dateTime]);
          const waitDate = date=>page.waitForFunction(d=>document.querySelector("#homeTaiexCard time").dateTime===d,date);
          assert.match(await card.innerText(),/資料尚未建立/);
          assert.match(await retail.innerText(),/散戶微台多空比/);
          assert.match(await retail.innerText(),/非三大法人部位推估/);
          const refresh = async () => {
            await idle();
            const previousReads=reads;
            const response = page.waitForResponse(r=>new URL(r.url()).pathname.endsWith("/home-taiex.json"));
            await page.evaluate(()=>window.dispatchEvent(new Event("online")));
            await response;
            await idle();
            assert.equal(reads,previousReads+1);
          };
          payload=known;
          await refresh();
          await waitDate(known.trade_date);
          const before=await read();
          assert.deepEqual(before,["39,701.64","▼ −1,873.08 點（−4.51%）","2026-11-06"]);
          assert.equal(await card.locator("strong").evaluate(e=>getComputedStyle(e).color),"rgb(121, 217, 173)");
          assert.equal(await page.locator("#homeSentimentCards > .homeSentimentCard").count(),5);
          assert.equal(await page.locator(".homeMarginExternalLinks a").count(),2);
          assert.ok(await page.evaluate(()=>{
            const e=document.querySelector("#homeTaiexCard"), c=e.getBoundingClientRect();
            return document.documentElement.scrollWidth<=innerWidth+1 &&
              [...e.children].filter(el=>!el.hidden).every(el=>el.scrollWidth<=el.clientWidth+1 && el.getBoundingClientRect().right<=c.right+1);
          }));
          await page.locator("#homeSentiment").screenshot({path:path.join(out,name+"-"+width+".png")});
          payload={...next,change_cents:0};
          await refresh();
          await card.locator("[data-taiex-state]:not([hidden])").waitFor();
          assert.deepEqual(await read(),before);
          payload=null;
          await page.reload({waitUntil:"domcontentloaded"});
          await waitDate(known.trade_date);
          assert.deepEqual(await read(),before);
          assert.match(await card.innerText(),/沿用已驗證資料/);
          await ctx.setOffline(true);
          if (name === "chrome") {
            await page.reload({waitUntil:"domcontentloaded"});
            await waitDate(known.trade_date);
            assert.deepEqual(await read(),before);
          } else {
            console.log("SKIP",name,width,"native offline top-level reload on Windows; existing Worker suite isolates this engine limitation");
            await page.evaluate(()=>window.dispatchEvent(new Event("online")));
            await idle();
            assert.deepEqual(await read(),before);
          }
          payload=next;
          await ctx.setOffline(false);
          await waitDate(next.trade_date);
          assert.deepEqual(await read(),["40,001.64","▲ +300.00 點（+0.76%）","2026-11-09"]);
          assert.equal(await card.locator("strong").evaluate(e=>getComputedStyle(e).color),"rgb(255, 133, 133)");
          payload=known;
          await refresh();
          await card.locator("[data-taiex-state]:not([hidden])").waitFor();
          assert.equal((await read())[2],next.trade_date);
          assert.equal(await page.evaluate(key=>Object.keys(localStorage).filter(k=>k.startsWith(key+".")).length,core.key),1);
          assert.deepEqual(errors,[]);
          console.log("PASS",name,width);
        } finally { await ctx.close(); }
      }
    } finally { await browser.close(); }
  }
}
run().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>server.close());
