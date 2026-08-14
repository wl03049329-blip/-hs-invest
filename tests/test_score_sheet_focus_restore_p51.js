const assert=require("assert");
const fs=require("fs");
const path=require("path");
const vm=require("vm");

const root=path.resolve(__dirname,"..");
const html=fs.readFileSync(path.join(root,"index.html"),"utf8");
const start=html.indexOf("let lastScoreSheetTrigger=null;");
const end=html.indexOf("function renderSearchResults",start);
assert.ok(start>=0&&end>start,"shared score-sheet focus helper must exist");

function modal(){return{classList:{values:new Set(),add(value){this.values.add(value)},remove(value){this.values.delete(value)}},attrs:{},setAttribute(key,value){this.attrs[key]=value}}}
const coreModal=modal(),historyModal=modal(),coreContent={innerHTML:""},historyContent={innerHTML:""},historyTicker={textContent:""};
const document={activeElement:null,contains(element){return Boolean(element?.connected)}};
const trigger=(id)=>({id,connected:true,focus(){document.activeElement=this}});
const items=[{id:"00830",name:"國泰費城半導體"},{id:"0050",name:"元大台灣50"},{id:"009815",name:"大華美國MAG7+"}];
const decision={coreScore:32,coreScoreDisplay:32,label:"回檔訊號出現",historicalTriggerRate:22.1,cta:{headline:"維持紀律",detail:"分批評估"}};
const nodes={"#coreScoreModal":coreModal,"#coreScoreContent":coreContent,"#coreScoreHistoryModal":historyModal,"#coreScoreHistoryContent":historyContent,"#coreScoreHistoryTicker":historyTicker};
const context={document,all:items,$:selector=>nodes[selector],strategyDecisionFor:()=>decision,coreStatusTier:()=>"status-tier-2",esc:String,fmt:value=>String(value),requestAnimationFrame:fn=>fn(),coreScoreHistoryState:ticker=>ticker==="009815"?{kind:"wait_native",rows:[]}:{kind:"empty",rows:[]},console};
vm.createContext(context);vm.runInContext(html.slice(start,end),context);

const core00830=trigger("core-00830");context.openCoreScoreModal("00830",core00830);context.closeCoreScoreModal();
assert.strictEqual(document.activeElement,core00830);console.log("TEST 1 PASS: Core Score Sheet restores its real trigger");

const history00830=trigger("history-00830");context.openCoreScoreHistoryModal("00830",history00830);context.closeCoreScoreHistoryModal();
assert.strictEqual(document.activeElement,history00830);console.log("TEST 2 PASS: History Sheet restores its real trigger");

const core0050=trigger("core-0050");context.openCoreScoreModal("0050",core0050);context.closeCoreScoreModal();
assert.strictEqual(document.activeElement,core0050);assert.notStrictEqual(document.activeElement,core00830);console.log("TEST 3 PASS: a different ETF never restores the first card trigger");

const history009815=trigger("history-009815");context.openCoreScoreHistoryModal("009815",history009815);context.closeCoreScoreHistoryModal();
assert.strictEqual(document.activeElement,history009815);assert.match(historyContent.innerHTML,/歷史分數尚未建立/);console.log("TEST 4 PASS: WAIT_NATIVE History Sheet restores the 009815 trigger");

assert.match(html,/let lastHsStoryTrigger=/);assert.match(html,/lastHsStoryTrigger\?\.focus\(\)/);console.log("TEST 5 PASS: P4 About HS focus restore remains intact");
assert.match(html,/openCoreScoreModal\(button\.dataset\.readCoreScore,button\)/);
assert.match(html,/openCoreScoreHistoryModal\(button\.dataset\.coreScoreHistory,button\)/);
console.log("P5.1 focus restore tests: 5\/5 PASS");
