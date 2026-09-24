"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");

const html=fs.readFileSync(path.join(__dirname,"..","index.html"),"utf8");
const buttons=[...html.matchAll(/class="bottomNavButton appNavButton(?: active)?"[^>]*data-tab="([^"]+)"/g)].map(match=>match[1]);
assert.deepEqual(buttons,["today","signals","portfolio","sentiment","more"]);
assert.match(html,/btn\.classList\.contains\("bottomNavButton"\)\?switchBottomNavTab\(btn\):switchTab\(btn\.dataset\.tab\)/);

const source=html.match(/function switchBottomNavTab\(button\)\{[\s\S]*?\n\}/)?.[0];
assert(source,"bottom navigation must have one shared handler");
for(const samePage of [false,true]){
  const events=[];
  const context={
    switchTab:(name,options)=>events.push(["switch",name,options.scroll]),
    requestAnimationFrame:callback=>{events.push(["frame"]);callback()},
    window:{scrollTo:options=>events.push(["scroll",options.top,options.behavior])}
  };
  const handler=vm.runInNewContext(`${source};switchBottomNavTab`,context);
  handler({dataset:{tab:"signals"},classList:{contains:name=>name==="active"&&samePage}});
  assert.deepEqual(JSON.parse(JSON.stringify(events)),[["switch","signals",false],["frame"],["scroll",0,samePage?"smooth":"auto"]]);
}
console.log("PASS bottom navigation shared switch, deferred scroll, same-page smooth and cross-page instant");
