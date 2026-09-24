"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");

const root=path.resolve(__dirname,"..");
const html=fs.readFileSync(path.join(root,"index.html"),"utf8");
const css=fs.readFileSync(path.join(root,"formal-black-gold.css"),"utf8");
const section=html.slice(html.indexOf('<article class="panel radarOverviewPanel"><div class="radarOverviewTitle"><span>波段策略'),html.indexOf('id="radarSentimentShortcut"'));

assert.match(section,/id="radarOverviewSwing" class="radarSingleStrategy"/);
assert.doesNotMatch(section,/role="tablist"|radarOverviewSwingTabs|data-swing-overview/);
assert.doesNotMatch(html,/<details class="panel signalLegend">/);
assert.doesNotMatch(css,/\.radarOverviewSwingTabs|\.signalLegend|\.swingOverviewPane/);
assert.match(html,/\{id:"00733",name:/);
assert.match(html,/\{id:"006201",name:/);

const start=html.indexOf("function radarSingleStrategyHtml(item){");
const end=html.indexOf("function scoreFactorValue",start);
assert(start>=0&&end>start);
const calls=[];
const context={leverageRadarDashboardHtml:item=>{calls.push(item);return '<section class="radarLeverageDashboard" data-leverage-status="READY"></section>'}};
vm.createContext(context);
vm.runInContext(`${html.slice(start,end)};this.render=radarSingleStrategyHtml`,context);
const leverage={id:"00631L"};
const rendered=context.render(leverage);
assert.equal(calls.length,1);
assert.equal(calls[0],leverage);
assert.match(rendered,/class="radarLeverageDashboard"/);
assert.match(rendered,/<button class="swingDetailEntry" type="button" data-open-radar-detail="00631L">/);
assert.doesNotMatch(rendered,/role="tab"|data-swing-overview|00733|006201/);
assert.equal(calls.length,1);
assert.match(context.render(null),/00631L 資料載入中/);

console.log("PASS ETF Radar single HS LEVERAGE overview and retired UI removal");
