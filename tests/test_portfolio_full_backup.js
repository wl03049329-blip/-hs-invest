const assert=require("node:assert/strict");
const backup=require("../portfolio-full-backup-core.js");
const P="hsRadar.portfolio.";
class MemoryStorage{
  constructor(entries={}){this.data=new Map(Object.entries(entries));this.failKey="";this.failOnce=false}
  get length(){return this.data.size}
  key(index){return [...this.data.keys()][index]??null}
  getItem(key){return this.data.has(key)?this.data.get(key):null}
  setItem(key,value){if(this.failOnce&&key===this.failKey){this.failOnce=false;throw new Error("simulated write failure")}this.data.set(key,String(value))}
  removeItem(key){this.data.delete(key)}
}
const holdings=["0050","00830","00935","009815","00635U"].map((code,index)=>({code,shares:index+1,averageCost:20+index,targetAllocation:20,customName:"",name:code,strategyType:""}));
const settings={cash:90000,profile:"trend",customTolerance:3,reminder:"90",customDays:60,cashFirst:true,trendProtection:true,targets:{}};
function fixture(extra={}){return new MemoryStorage({
  [`${P}holdings`]:JSON.stringify(holdings),[`${P}rebalanceSettings`]:JSON.stringify(settings),
  [`${P}autoRefresh`]:"1",[`${P}snapshotHistory.v1`]:"[]",[`${P}goal.v1`]:"null",
  [`${P}monthlyPlan.v1`]:"null",[`${P}importState.v1`]:"null",
  [`${P}recoveryPoints.v1`]:"[]",[`${P}importHistory.v1`]:"[]",
  [`${P}quotes`]:JSON.stringify({0050:{price:100}}),[`${P}marketVersion`]:"cached",
  ...extra
})}
let passed=0;
function test(name,fn){fn();passed++;console.log(`PASS ${name}`)}
test("full export includes holdings, costs, targets, cash and settings",()=>{const data=backup.createBackup(fixture());assert.equal(data.schemaVersion,1);assert.equal(data.portfolio.holdings[0].averageCost,20);assert.equal(data.portfolio.cash,90000);assert.equal(data.portfolio.universe.length,5);assert.equal(data.portfolio.rebalanceSettings.profile,"trend");assert.equal(backup.validateBackup(data).ok,true)});
test("quote and market cache excluded while Portfolio preferences persist",()=>{const data=backup.createBackup(fixture());assert.equal(data.storage[`${P}quotes`],undefined);assert.equal(data.storage[`${P}marketVersion`],undefined);assert.equal(data.storage[`${P}autoRefresh`],"1")});
test("round trip restores exact Portfolio storage after holdings, targets and cash change",()=>{const storage=fixture(),before=backup.collectEntries(storage),data=backup.createBackup(storage);storage.setItem(`${P}holdings`,"[]");storage.setItem(`${P}rebalanceSettings`,JSON.stringify({...settings,cash:1,targets:{"00662":20}}));storage.setItem(`${P}newPreference.v1`,"changed");assert.equal(backup.restoreAtomic(storage,data).ok,true);assert.deepEqual(backup.collectEntries(storage),before);assert.equal(backup.createBackup(storage).portfolio.universe.length,5)});
test("zero-holding target survives export, import and reload",()=>{const storage=fixture({[`${P}rebalanceSettings`]:JSON.stringify({...settings,targets:{"00662":20}})}),data=backup.createBackup(storage);assert.deepEqual(data.portfolio.universe.find(row=>row.code==="00662"),{code:"00662",quantity:0});storage.setItem(`${P}rebalanceSettings`,JSON.stringify(settings));assert.equal(backup.restoreAtomic(storage,data).ok,true);const reloaded=backup.createBackup(storage);assert.equal(reloaded.portfolio.targets["00662"],20);assert.equal(reloaded.portfolio.universe.find(row=>row.code==="00662").quantity,0);assert.equal(reloaded.portfolio.holdings.length,5)});
test("Ledger, performance start date and snapshot history survive exact restore",()=>{const ledgerCore=require("../portfolio-ledger-core.js"),ledger=ledgerCore.migrateLegacyPortfolio({holdings,cash:settings.cash,tradeDate:"2026-09-18",timestamp:"2026-09-18T09:00:00+08:00"}),snapshot={date:"2026-09-18",timestamp:"2026-09-18T13:30:00+08:00",totalMarketValue:1000,cash:settings.cash,totalAssets:91000,unrealizedPnL:0,holdings:{"0050":{quantity:1,marketPrice:1000,marketValue:1000}}},storage=fixture({[ledgerCore.STORAGE_KEY]:JSON.stringify(ledger),[`${P}snapshotHistory.v1`]:JSON.stringify([snapshot])}),original=backup.collectEntries(storage),data=backup.createBackup(storage);assert.equal(data.portfolio.ledgerPresent,true);assert.equal(data.portfolio.snapshotCount,1);storage.removeItem(ledgerCore.STORAGE_KEY);storage.setItem(`${P}snapshotHistory.v1`,"[]");assert.equal(backup.restoreAtomic(storage,data).ok,true);assert.deepEqual(backup.collectEntries(storage),original);assert.equal(JSON.parse(storage.getItem(ledgerCore.STORAGE_KEY)).performanceStartDate,"2026-09-18")});
test("invalid schema and invalid JSON rejected without storage mutation",()=>{const storage=fixture(),before=backup.collectEntries(storage),data=backup.createBackup(storage);assert.equal(backup.restoreAtomic(storage,{...data,schemaVersion:9}).ok,false);assert.equal(backup.restoreAtomic(storage,{...data,storage:{...data.storage,[`${P}holdings`]:"{"}}).ok,false);assert.deepEqual(backup.collectEntries(storage),before)});
test("invalid quantity, cost, target and cash rejected",()=>{const cases=[{key:`${P}holdings`,value:JSON.stringify([{...holdings[0],shares:0}])},{key:`${P}holdings`,value:JSON.stringify([{...holdings[0],averageCost:"Infinity"}])},{key:`${P}rebalanceSettings`,value:JSON.stringify({...settings,targets:{"00662":101}})},{key:`${P}rebalanceSettings`,value:JSON.stringify({...settings,cash:"NaN"})}];for(const row of cases)assert.throws(()=>backup.createBackup(fixture({[row.key]:row.value})))});
test("failed restore rolls back all Portfolio storage",()=>{const storage=fixture(),before=backup.collectEntries(storage),data=backup.createBackup(storage);storage.setItem(`${P}rebalanceSettings`,JSON.stringify({...settings,cash:8}));const mutated=backup.collectEntries(storage);storage.failKey=`${P}holdings`;storage.failOnce=true;const result=backup.restoreAtomic(storage,data);assert.equal(result.status,"RESTORE_ROLLED_BACK");assert.deepEqual(backup.collectEntries(storage),mutated);assert.equal(storage.getItem(backup.JOURNAL_KEY),null);assert.notDeepEqual(mutated,before)});
test("interrupted restore journal recovers before Portfolio load",()=>{const storage=fixture(),before=backup.collectEntries(storage);storage.setItem(backup.JOURNAL_KEY,JSON.stringify({schema:backup.SCHEMA,entries:before}));storage.setItem(`${P}holdings`,"[]");assert.equal(backup.recoverPendingRestore(storage).status,"RECOVERED");assert.deepEqual(backup.collectEntries(storage),before)});
test("legacy holdings-only backups remain a separate supported UI path",()=>{const old={version:2,holdings};assert.equal(old.version,2);assert.equal(backup.validateBackup(old).ok,false);assert.deepEqual(require("../portfolio-core.js").validateImportPayload(old).map(row=>row.code),holdings.map(row=>row.code))});
console.log(`${passed}/${passed} Portfolio full-backup tests PASS`);
