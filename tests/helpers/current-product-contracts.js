"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const root=path.resolve(__dirname,"../..");

function checkFeaturedWatchlist(html){
  const list=html.match(/const DEFAULT_WATCHLIST=\[([\s\S]*?)\n\];/);
  const selector=html.match(/function radarList\(\)\{[^\n]+\}/);
  assert.ok(list&&selector,"featured source and selector exist");
  const universe=JSON.parse(fs.readFileSync(path.join(root,"etf-universe.json"),"utf8"));
  const context={radarMode:"featured",watchlist:[{id:"006208",name:"fixture watchlist"}]};
  vm.runInNewContext("const DEFAULT_WATCHLIST=["+list[1]+"];"+selector[0]+";this.list=DEFAULT_WATCHLIST;this.select=radarList;",context);
  const ids=Array.from(context.list,x=>x.id);
  assert.equal(new Set(ids).size,ids.length,"featured codes unique");
  for(const id of ids)assert.ok(universe.items.some(x=>x.code===id),"featured "+id+" remains searchable");
  for(const id of ["0050","00662","00757","00830","00935","009815","00631L","00733","006201"])
    assert.ok(ids.includes(id),"current featured catalog retains "+id);
  assert.equal(context.select(),context.list);
  context.radarMode="my";
  assert.equal(context.select(),context.watchlist,"my watchlist is independent of featured catalog");
  assert.notEqual(context.watchlist,context.list);
}

async function checkProductVersion(html){
  assert.match(html,/data-hs-version/);
  assert.match(html,/app-version\.js/);
  const current=JSON.parse(fs.readFileSync(path.join(root,"version.json"),"utf8")).version;
  assert.match(current,/^\d+\.\d+\.\d+$/);
  const script=fs.readFileSync(path.join(root,"app-version.js"),"utf8");
  for(const version of [current,"4.2.1"]){
    const short={textContent:""},full={textContent:""},document={baseURI:"https://fixture.invalid/",
      documentElement:{dataset:{}},querySelectorAll:s=>s==="[data-hs-version]"?[short]:[full]};
    const window={};
    vm.runInNewContext(script,{URL,document,window,fetch:async(url,options)=>{
      assert.equal(url.href,"https://fixture.invalid/version.json");
      assert.equal(options.cache,"no-store");
      return {ok:true,json:async()=>({version})};
    }});
    await new Promise(setImmediate);
    assert.equal(short.textContent,version.split(".").slice(0,2).join("."));
    assert.equal(full.textContent,version);
    assert.equal(window.HSProductVersion.full,version);
    assert.equal(document.title,"HS ETF 股市雷達 "+short.textContent);
  }
}

function checkPortfolioConsolePrivacy(ui){
  const calls=[],secret="PRIVATE_HOLDINGS_FIXTURE_MUST_NOT_BE_LOGGED";
  const storage={secret,getItem(){throw Error("restore failure must return before reading holdings")}};
  const window=new Proxy({HSPortfolioFullBackupCore:{recoverPendingRestore(s){assert.equal(s,storage);return {ok:false}}}},
    {get:(target,key)=>target[key]||{}});
  vm.runInNewContext(ui,{window,localStorage:storage,console:{error:(...args)=>calls.push(args)}});
  assert.deepEqual(calls,[["Portfolio 備份還原中斷，請勿修改資料。 "]]);
  assert.ok(!JSON.stringify(calls).includes(secret));
  const consoleCalls=ui.match(/console\.[A-Za-z]+\(/g)||[];
  assert.deepEqual(consoleCalls,["console.error("],"only a fixed non-sensitive recovery warning is allowed");
}
module.exports={checkFeaturedWatchlist,checkProductVersion,checkPortfolioConsolePrivacy};
