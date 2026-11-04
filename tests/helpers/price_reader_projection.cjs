'use strict';
// Exact, reviewed projection of the independently authorized pricing boundary.
// No financial assertion is removed: every non-price byte still matches the
// prior production reader and the original test then checks its older seal.
const assert=require('assert/strict'),cp=require('child_process'),crypto=require('crypto');
module.exports=function(source){
 const prior=cp.execFileSync('git',['show','6b7a0c5:portfolio-v3/personal-v3.js'],{maxBuffer:8e6}).toString();
 const a=source.indexOf(' // Calendar expectation is NOT proof'),b=source.indexOf(' function closeQuotes(',a);assert(a>0&&b>a);
 const helper=source.slice(a,b);assert.equal(crypto.createHash('sha256').update(helper).digest('hex'),'9d8fb4eae522f677e3b3e275fae0cf96d12b369ac8bb32b985cbebaf8f6b8425');
 const raw=s=>s.slice(s.indexOf(' function session('),s.indexOf(' function closeQuotes('));assert.equal(raw(source).replace(helper,''),raw(prior),'RAW_HISTORY_POLICY_CHANGED');
 const close=s=>s.split('\n').find(l=>l.startsWith(' function closeQuotes(')),oldClose=close(prior),newClose=close(source);
 assert.equal(newClose,oldClose.replace('const s=session(status,now)','const s=priceSession(status,now)').replace('if(!/^[0-9A-Z]','if(priceBlock(status,row.code)||!/^[0-9A-Z]').replace("s?.known&&!s.live&&row.date===s.completed&&!(day(now)===status.next_expected_trading_day&&Date.parse(now)>=Date.parse(day(now)+'T13:30:00+08:00')&&row.date!==day(now))","s?.known&&!s.live&&row.date===s.expected_price_date"),'NON_DATE_QUOTE_GUARD_CHANGED');
 const read=s=>s.slice(s.lastIndexOf(' function read(){'),s.indexOf(' host.HSPersonalV2=Object.freeze({read,mode:'));
 const expected=read(prior).replace('session=V.session(status,now),effectiveQuotes','session=V.session(status,now),priceSession=V.priceSession(status,now),effectiveQuotes').replace('latest:sc.score!==null&&session?.completed===sc.date','latest:sc.score!==null&&priceSession?.known===true&&priceSession.required_c4_date===sc.date').replace('x.unit_status=x.unit_status||V.unitStatus(x,q);',"x.unit_status=V.priceBlock(status,h.symbol)?'ACTION_EVIDENCE_REQUIRED':x.unit_status||V.unitStatus(x,q);").replace('plan_progress:progress,actual_cost_minor','plan_progress:progress,price_session:priceSession,price_source_status:cache?.source_status||null,c4_required_date:priceSession?.required_c4_date,actual_cost_minor');
 assert.equal(read(source),expected,'FINANCIAL_READ_CHANGED_OUTSIDE_PRICING_BINDING');
 const normalized=source.replace(helper,'').replace(newClose,oldClose).replace('session,priceSession,priceBlock,closeQuotes','session,closeQuotes').replace(read(source),read(prior));
 const end=s=>s.indexOf("const scope=document.getElementById('hpv2')");assert.equal(normalized.slice(0,end(normalized)),prior.slice(0,end(prior)),'SEALED_OR_FINANCIAL_CORE_CHANGED');
 return normalized;
};
