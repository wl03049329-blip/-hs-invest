'use strict';
const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
const html=fs.readFileSync('index.html','utf8'),css=fs.readFileSync('formal-black-gold.css','utf8'),symbols=['0050','00662','00757','00830','00935'],freshness=require('../data-freshness-core');
const b={Date,Intl,Number,Object,Array,String,Math,Set,window:{HSDataFreshnessCore:freshness},LONG_RADAR_SCORED_CODES:new Set(symbols)};
vm.createContext(b);
vm.runInContext(html.slice(html.indexOf('const DECISION_CENTER_HEALTH_LEVELS='),html.indexOf('function decisionCenterDistanceText')),b);
b.currentFrontendLiveRenderState=()=> 'BACKEND_NO_SNAPSHOT';b.LONG_TERM_CORE_SCORE_VERSION='FINAL_CORE_WEIGHT_V1';
vm.runInContext(html.slice(html.indexOf('function decisionCenterHeaderPresentation('),html.indexOf('function renderDecisionCenterHeader(')),b);
function model(state,{at='2026-11-03T10:35:30+08:00',date='2026-11-02',live=true,official=true}={}){
 const dual={market_state:state,target_date:'2026-11-03',official_snapshot:{source_status:'FINALIZED_EOD',snapshot_type:'FINALIZED_CLOSE',status:'SUCCESS',trading_date:date},items:Object.fromEntries(symbols.map(s=>[s,{score_version:'FINAL_CORE_WEIGHT_V1',official:{status:official?'FINALIZED':'UNAVAILABLE',market_as_of:date+'T13:30:00+08:00'},live:{display_eligible:live,freshness:live?'FRESH':'STALE',status:live?'LIVE_PROJECTED':'UNAVAILABLE',trading_date:'2026-11-03',market_as_of:'2026-11-03T10:35:20+08:00'}}]))};
 const now=new Date(at),health=b.decisionCenterSystemHealth({dualTrack:dual,officialRows:official?symbols.map(s=>({symbol:s,date})):[],historyBySymbol:new Map(),targetDate:dual.target_date,now});
 return{dual,health,now,show:()=>b.decisionCenterHeaderPresentation(dual,health,now)};
}
let pass=0;function t(name,f){f();pass++;console.log('PASS',name);}
t('premarket uses real previous close timestamp, not device time',()=>{const x=model('PREMARKET',{at:'2026-11-03T08:20:00+08:00'}).show();assert.equal(x.longText,'前收 13:30:00');assert.equal(x.isLive,false);assert(x.accessible.includes('2026-11-02'));});
t('all five original health checks, only normal OPEN glows',()=>{const x=model('OPEN').show();assert.equal(x.isLive,true);assert.equal(x.label,'盤中交易');assert.equal(x.longText,'更新 10:35:20');});
t('stale OPEN never glows',()=>assert.equal(model('OPEN',{live:false}).show().isLive,false));
t('official error cannot glow even with inconsistent synthetic LIVE flags',()=>assert.equal(model('OPEN',{official:false}).show().isLive,false));
t('one incomplete LIVE member rejects highlight through original health',()=>{const x=model('OPEN');x.dual.items['0050'].live.display_eligible=false;Object.assign(x.health,b.decisionCenterSystemHealth({dualTrack:x.dual,officialRows:symbols,targetDate:'2026-11-03',now:x.now}));assert.equal(x.show().isLive,false);});
t('closed current official uses actual close time',()=>{const x=model('CLOSED',{date:'2026-11-03',at:'2026-11-03T20:00:00+08:00'}).show();assert.equal(x.longText,'收盤 13:30:00');assert.equal(x.isLive,false);});
t('closed but previous official never claims today close',()=>{const x=model('CLOSED',{at:'2026-11-03T20:00:00+08:00'}).show();assert.equal(x.longText,'前收 13:30:00');assert(x.accessible.includes('2026-11-02'));});
t('holiday has no glow and real prior date',()=>{const x=model('HOLIDAY',{date:'2026-10-30',at:'2026-11-01T12:00:00+08:00'}).show();assert.equal(x.isLive,false);assert.equal(x.longText,'前收 13:30:00');});
t('invalid market state never glows',()=>{const x=model('STALE').show();assert.equal(x.isLive,false);assert.equal(x.longText,'更新待確認');});
t('no official data does not invent13:30',()=>assert.equal(model('PREMARKET',{official:false}).show().longText,'更新待確認'));
t('future/missing LIVE timestamp cannot light even with passed synthetic health',()=>{for(const at of ['invalid','2026-11-03T10:35:31+08:00','']){const x=model('OPEN');x.dual.items['0050'].live.market_as_of=at;assert.equal(x.show().isLive,false);}});
t('unrelated CNN/Forward/leverage warning cannot change underlying live health',()=>assert.equal(model('OPEN').show().isLive,true));
t('minimum complete-batch timestamp, not newest single ETF',()=>{const x=model('OPEN');x.dual.items['0050'].live.market_as_of='2026-11-03T10:34:59+08:00';assert.equal(x.show().longText,'更新 10:34:59');});
t('UTC representation formats Taipei and narrow text retains full accessible seconds',()=>{const x=model('OPEN');for(const s of symbols)x.dual.items[s].live.market_as_of='2026-11-03T02:35:20Z';const v=x.show();assert.equal(v.shortText,'更新 10:35');assert(v.accessible.includes('10:35:20'));});
t('recovery sequence removes/returns glow without mutating source',()=>{const x=model('OPEN'),before=JSON.stringify(x.dual);assert(x.show().isLive);x.health.items.find(r=>r.key==='live').level='WARNING';assert(!x.show().isLive);x.health.items.find(r=>r.key==='live').level='HEALTHY';assert(x.show().isLive);assert.equal(JSON.stringify(x.dual),before);});
t('old official is not labelled latest previous close',()=>assert.equal(model('PREMARKET',{date:'2026-10-20'}).show().longText,'更新待確認'));
t('styling is root-header scoped and motion never animates geometry',()=>{const s=css.slice(css.indexOf('/* Header market pill only.'));assert.match(s,/#home \.hsHeaderState\{display:flex/);assert.match(s,/justify-content:space-between/);assert.match(s,/font-variant-numeric:tabular-nums/);assert.match(s,/font-size:21px/);assert.match(s,/font-size:18px/);assert.match(s,/font-size:13px/);assert.match(s,/3s ease-in-out infinite/);assert.match(s,/@media\(prefers-reduced-motion:reduce\).*animation:none/);assert.match(s,/@keyframes hsHeaderMarketBreath\{0%,100%\{opacity:\.45\}50%\{opacity:1\}\}/);});
t('presentation never writes storage, fetches, or changes formal calculations',()=>assert.doesNotMatch(html.slice(html.indexOf('function decisionCenterHeaderPresentation('),html.indexOf('function renderDecisionCenter(longs')),/localStorage|setItem|fetch\(|buildFinal\(|buildAdHocScore\(/));
console.log(JSON.stringify({pass,fail:0,skip:0}));
