// Prices must first pass the existing HSRadarHistorySource.fetchArchive validator.
// Validate only the explicitly verified incremental window, never promote an
// OBSERVED_ONLY historical file into a complete exchange calendar.
(function(root,f){if(typeof module==='object'&&module.exports)module.exports=f();else root.HSPersonalV3HistoryBasis=f();})(globalThis,function(){
 function apply(q,archive,status,actions,now){try{
 if(!q||!archive||archive.verified!==true||archive.price_type!=='RAW_UNADJUSTED'||archive.currency!=='TWD'||archive.symbol!==q.symbol||!Number.isFinite(Date.parse(archive.fetched_at))||Date.parse(archive.fetched_at)>Date.parse(now)||!/^[a-f0-9]{64}$/.test(archive.content_sha256)||!Array.isArray(archive.price))return q;
 const inc=archive.incremental_verification;if(!inc||inc.corporate_actions!=='VERIFIED'||!Array.isArray(inc.sessions)||!Array.isArray(inc.calendar_evidence)||!inc.calendar_evidence.some(e=>/^https:\/\/www.twse.com.tw\/exchangeReport\/FMTQIK\?response=json&date=\d{8}$/.test(e.url)&&/^[a-f0-9]{64}$/.test(e.sha256)))return q;
 const sessions=inc.sessions;if(new Set(sessions).size!==sessions.length||sessions.some((d,i)=>d<inc.start||d>inc.end||i&&d<=sessions[i-1]))return q;
 const live=q.kind==='INTRADAY_REFERENCE';let previous;
 if(live){if(q.date!==status?.next_expected_trading_day||status.expected_completed_bar>archive.requested_end)return q;previous=status.expected_completed_bar;}
 else{const i=sessions.indexOf(q.date);if(i<1)return q;previous=sessions[i-1];if(!archive.price.some(p=>p.date===q.date&&p.close===q.price))return q;}
 const old=archive.price.find(p=>p.date===previous);if(!archive.action_coverage?.start||!archive.action_coverage?.end||!old||!Number.isFinite(old.close)||old.close<=0||!Number.isFinite(q.previous_reference)||archive.action_coverage?.start>previous||archive.action_coverage?.end<(live?previous:q.date))return q;
 const split=actions.find(a=>a.symbol===q.symbol&&a.effective&&previous<a.effective&&q.date>=a.effective),ratio=split?.ratio||1;
 const dividends=archive.dividends.filter(d=>d.date===q.date);if(live&&archive.action_coverage.end<q.date)return q; // no guessing today's action absence
 const entitlement=dividends.reduce((n,d)=>n+d.amount,0);if(!Number.isFinite(entitlement)||entitlement<0||ratio!==1&&entitlement!==0)return q;
 if(Math.abs(old.close/ratio-entitlement-q.previous_reference)>1e-6)return q;
 return{...q,previous_reference:old.close,previous_session_date:previous,reference_kind:'RAW_PREVIOUS_OFFICIAL',cash_entitlement_per_share:entitlement,history_sha256:archive.content_sha256,calendar_scope:'VERIFIED_INCREMENTAL_WINDOW'};
 }catch{return q;}}
 return Object.freeze({apply});
});
