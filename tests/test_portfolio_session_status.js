'use strict';
const assert=require('assert/strict'),fs=require('fs'),vm=require('vm'),crypto=require('crypto'),source=fs.readFileSync('portfolio-v3/personal-v3.js','utf8'),end=source.indexOf("const scope=document.getElementById('hpv2')"),box={crypto:crypto.webcrypto,TextEncoder,TextDecoder,console};vm.createContext(box);vm.runInContext(source.slice(0,end)+'host.contract=window;})(globalThis);',box);
const V=box.contract.HSPersonalV3Core,real=JSON.parse(fs.readFileSync('data/radar-history/status-v1.json')),cache=JSON.parse(fs.readFileSync('market-quotes.json'));let pass=0;const t=(name,f)=>{f();pass++;console.log('PASS',name);},clone=x=>JSON.parse(JSON.stringify(x));
// Isolated calendar fixtures only. Never used to modify the published manifest.
function status(last,next){const s=clone(real);s.expected_completed_bar=last;s.next_expected_trading_day=next;for(const r of Object.values(s.symbols)){r.status='CURRENT';r.latest_verified_date=last;}return s;}
const fresh=status('2026-11-03','2026-11-04'),stale=status('2026-11-02','2026-11-03');
for(const [name,time]of[['midnight','2026-11-04T00:53:00+08:00'],['premarket','2026-11-04T08:55:00+08:00']])t(name+' uses verified Nov3, never nonexistent Nov4 close',()=>{const s=V.session(fresh,time);assert.equal(s.completed,'2026-11-03');assert.equal(s.known,true);assert.equal(s.live,false);});
t('intraday keeps formal prior session plus existing live gate',()=>{const s=V.session(fresh,'2026-11-04T10:00:00+08:00');assert.equal(s.live,true);assert.equal(s.completed,'2026-11-03');});
t('post13:30 old close not marked latest',()=>{const q=V.closeQuotes(cache,fresh,'2026-11-04T14:00:00+08:00');assert.equal(q.get('0050').latest,false);});
t('17:59 cannot certify Nov4',()=>assert.equal(V.session(fresh,'2026-11-04T17:59:59+08:00').completed,'2026-11-03'));
t('18:00 wall clock requests but does not verify Nov4',()=>{const s=V.session(fresh,'2026-11-04T18:00:00+08:00');assert.equal(s.known,false);assert.equal(s.completed,null);assert.equal(s.expected_completed,'2026-11-04');assert.equal(s.reason,'COMPLETED_SESSION_AWAITING_VERIFICATION');});
t('verified producer Nov4 completes the handoff',()=>assert.equal(V.session(status('2026-11-04','2026-11-05'),'2026-11-04T20:00:00+08:00').completed,'2026-11-04'));
t('stale manifest gives explicit diagnosis, cannot silently advance',()=>{const s=V.session(stale,'2026-11-04T00:53:00+08:00');assert.equal(s.reason,'TRADING_STATUS_STALE');assert.equal(s.last_verified_completed,'2026-11-02');assert.equal(s.completed,null);assert.equal(s.known,false);});
t('fresh prices alone do not repair an old calendar',()=>assert.equal(V.closeQuotes(cache,stale,'2026-11-04T00:53:00+08:00').get('0050').latest,false));
t('verified Nov3 cache is latest before Nov4 open',()=>assert.equal(V.closeQuotes(cache,fresh,'2026-11-04T00:53:00+08:00').get('0050').latest,true));
for(const date of['2026-11-07T12:00:00+08:00','2026-11-08T19:00:00+08:00'])t('weekend uses Friday via verified next-session metadata '+date,()=>{const s=V.session(status('2026-11-06','2026-11-09'),date);assert.equal(s.completed,'2026-11-06');assert.equal(s.live,false);assert.equal(s.known,true);});
t('holiday uses last verified session, not weekday assumption',()=>assert.equal(V.session(status('2026-10-08','2026-10-12'),'2026-10-09T19:00:00+08:00').completed,'2026-10-08'));
t('one failed historical source blocks readiness even with fresh quotes',()=>{const s=clone(fresh);s.symbols['009815'].status='STALE';assert.equal(V.session(s,'2026-11-04T00:53:00+08:00').reason,'DAILY_HISTORY_INCOMPLETE');});
t('mismatched historical date cannot clear readiness',()=>{const s=clone(fresh);s.symbols['0050'].latest_verified_date='2026-11-02';assert.equal(V.session(s,'2026-11-04T00:53:00+08:00').known,false);});
t('missing history integrity binding blocks readiness',()=>{const s=clone(fresh);delete s.symbols['0050'].archive_sha256;assert.equal(V.session(s,'2026-11-04T00:53:00+08:00').known,false);});
t('invalid wall clock cannot fabricate completion',()=>assert.equal(V.session(fresh,'invalid'),null));
t('future status rejected',()=>assert.equal(V.session(fresh,'2026-11-02T12:00:00+08:00'),null));
console.log(JSON.stringify({pass,fail:0,skip:0,fixture:'ISOLATED_CALENDAR_NO_FINANCIAL_WRITES'}));
