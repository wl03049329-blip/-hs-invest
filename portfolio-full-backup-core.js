(function(root,factory){const dependencies=typeof module==="object"&&module.exports?{portfolio:require("./portfolio-core.js"),ledger:require("./portfolio-ledger-core.js"),performance:require("./portfolio-performance-core.js"),dashboard:require("./portfolio-dashboard-core.js")}: {portfolio:root.HSPortfolioCore,ledger:root.HSPortfolioLedgerCore,performance:root.HSPortfolioPerformanceCore,dashboard:root.HSPortfolioDashboardCore};const api=factory(dependencies);if(typeof module==="object"&&module.exports)module.exports=api;if(root)root.HSPortfolioFullBackupCore=api;})(typeof window!=="undefined"?window:globalThis,function(dependencies){
  "use strict";
  const {portfolio,ledger,performance,dashboard}=dependencies;
  const SCHEMA="HS_PORTFOLIO_FULL_BACKUP_V1",SCHEMA_VERSION=1,PREFIX="hsRadar.portfolio.",JOURNAL_KEY=`${PREFIX}preRestoreJournal.v1`;
  const EXCLUDED=new Set([`${PREFIX}quotes`,`${PREFIX}marketVersion`,JOURNAL_KEY,"hs_portfolio_quotes_v1","hs_portfolio_market_version_v1"]);
  const LEGACY_KEYS=new Set(["hs_portfolio_v6","hs_portfolio_auto_v1"]);
  const HOLDINGS_KEY=`${PREFIX}holdings`,SETTINGS_KEY=`${PREFIX}rebalanceSettings`;
  const JSON_KEYS=new Set([HOLDINGS_KEY,SETTINGS_KEY,ledger.STORAGE_KEY,ledger.LEGACY_BACKUP_KEY,performance.STORAGE_KEY,`${PREFIX}goal.v1`,`${PREFIX}monthlyPlan.v1`,`${PREFIX}importState.v1`,`${PREFIX}recoveryPoints.v1`,`${PREFIX}importHistory.v1`,"hs_portfolio_v6"]);
  const isPortfolioKey=key=>(key.startsWith(PREFIX)||LEGACY_KEYS.has(key))&&!EXCLUDED.has(key);
  const own=(object,key)=>Object.prototype.hasOwnProperty.call(object,key);
  const plain=value=>Boolean(value&&typeof value==="object"&&!Array.isArray(value));
  const parse=(value,fallback)=>value===undefined?fallback:JSON.parse(value);
  function collectEntries(storage){const entries={};for(let index=0;index<storage.length;index++){const key=storage.key(index);if(key&&isPortfolioKey(key))entries[key]=storage.getItem(key)}return Object.fromEntries(Object.entries(entries).sort(([a],[b])=>a.localeCompare(b)))}
  function validateSettings(value){if(!plain(value))throw new Error("INVALID_REBALANCE_SETTINGS");const finite=(number,min,max)=>typeof number==="number"&&Number.isFinite(number)&&number>=min&&number<=max;
    if(!finite(value.cash,0,Number.MAX_VALUE)||!["conservative","balanced","trend","custom"].includes(value.profile)||!finite(value.customTolerance,0,20)||!finite(value.customDays,7,365)||!["30","90","custom"].includes(String(value.reminder))||typeof value.cashFirst!=="boolean"||typeof value.trendProtection!=="boolean"||!plain(value.targets))throw new Error("INVALID_REBALANCE_SETTINGS");
    for(const [code,target] of Object.entries(value.targets))if(!portfolio.CODE_PATTERN.test(code)||!dashboard.normalizeTarget(target).ok||target!==null&&typeof target!=="number")throw new Error("INVALID_TARGET");
  }
  function describe(entries){const holdings=parse(entries[HOLDINGS_KEY],[]),settings=parse(entries[SETTINGS_KEY],{cash:0,profile:"trend",customTolerance:3,reminder:"90",customDays:60,cashFirst:true,trendProtection:true,targets:{}});
    if(!Array.isArray(holdings))throw new Error("INVALID_HOLDINGS");portfolio.validateImportPayload(holdings);validateSettings(settings);
    if(own(entries,ledger.STORAGE_KEY)&&entries[ledger.STORAGE_KEY]!=="null"&&!ledger.validateLedger(parse(entries[ledger.STORAGE_KEY])))throw new Error("INVALID_LEDGER");
    const snapshots=parse(entries[performance.STORAGE_KEY],[]);if(!Array.isArray(snapshots)||snapshots.some(row=>!performance.validateSnapshot(row)))throw new Error("INVALID_SNAPSHOTS");
    for(const key of JSON_KEYS)if(own(entries,key))parse(entries[key]);
    const actual=new Map(holdings.map(row=>[row.code,row.shares]));const universe=[...new Set([...actual.keys(),...Object.keys(settings.targets)])].sort().map(code=>({code,quantity:actual.get(code)||0}));
    return{holdings,targets:settings.targets,cash:settings.cash,universe,rebalanceSettings:settings,ledgerPresent:Boolean(own(entries,ledger.STORAGE_KEY)&&entries[ledger.STORAGE_KEY]!=="null"),snapshotCount:snapshots.length};
  }
  function createBackup(storage,{exportedAt=new Date().toISOString()}={}){const entries=collectEntries(storage),portfolioState=describe(entries);return{schema:SCHEMA,schemaVersion:SCHEMA_VERSION,exportedAt,portfolio:portfolioState,storage:entries}}
  function validateBackup(raw){try{if(!plain(raw)||raw.schema!==SCHEMA||raw.schemaVersion!==SCHEMA_VERSION||!Number.isFinite(Date.parse(raw.exportedAt))||!plain(raw.storage)||!plain(raw.portfolio))throw new Error("INVALID_SCHEMA");const entries=raw.storage;
      if(JSON.stringify(raw).length>5*1024*1024)throw new Error("BACKUP_TOO_LARGE");
      for(const [key,value] of Object.entries(entries))if(!isPortfolioKey(key)||typeof value!=="string")throw new Error("INVALID_STORAGE_ENTRY");
      const state=describe(entries);if(JSON.stringify(raw.portfolio)!==JSON.stringify(state))throw new Error("BACKUP_MISMATCH");
      return{ok:true,status:"VALID",state,entries};
    }catch(error){return{ok:false,status:error instanceof SyntaxError?"INVALID_JSON":String(error.message||"INVALID_BACKUP")}}}
  function writeEntries(storage,entries){const current=collectEntries(storage);for(const key of Object.keys(current))if(!own(entries,key))storage.removeItem(key);for(const [key,value] of Object.entries(entries))storage.setItem(key,value)}
  function recoverPendingRestore(storage){const raw=storage.getItem(JOURNAL_KEY);if(raw===null)return{ok:true,status:"NONE"};try{const journal=JSON.parse(raw);if(!plain(journal)||!plain(journal.entries))throw new Error("INVALID_JOURNAL");for(const [key,value] of Object.entries(journal.entries))if(!isPortfolioKey(key)||typeof value!=="string")throw new Error("INVALID_JOURNAL");writeEntries(storage,journal.entries);storage.removeItem(JOURNAL_KEY);return{ok:true,status:"RECOVERED"}}catch{return{ok:false,status:"RECOVERY_FAILED"}}}
  function restoreAtomic(storage,backup){const checked=validateBackup(backup);if(!checked.ok)return checked;let before;try{const recovered=recoverPendingRestore(storage);if(!recovered.ok)return recovered;before=collectEntries(storage);storage.setItem(JOURNAL_KEY,JSON.stringify({schema:SCHEMA,entries:before}));writeEntries(storage,checked.entries);if(JSON.stringify(collectEntries(storage))!==JSON.stringify(Object.fromEntries(Object.entries(checked.entries).sort(([a],[b])=>a.localeCompare(b)))))throw new Error("RESTORE_VERIFY_FAILED");storage.removeItem(JOURNAL_KEY);return{ok:true,status:"RESTORED",before}}catch{try{if(before)writeEntries(storage,before);storage.removeItem(JOURNAL_KEY);return{ok:false,status:"RESTORE_ROLLED_BACK"}}catch{return{ok:false,status:"RECOVERY_REQUIRED"}}}}
  return Object.freeze({SCHEMA,SCHEMA_VERSION,JOURNAL_KEY,collectEntries,createBackup,validateBackup,restoreAtomic,recoverPendingRestore});
});
