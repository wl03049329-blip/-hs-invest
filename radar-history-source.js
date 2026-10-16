/* Same public FinMind provider as the application. Never reads Railway Volume. */
(function(root,factory){const api=factory(typeof module==='object'&&module.exports?require('./radar-history-core.js'):root.HSRadarHistory);if(typeof module==='object'&&module.exports)module.exports=api;else root.HSRadarHistorySource=api;})(typeof globalThis!=='undefined'?globalThis:this,function(core){
  'use strict';
  const CACHE_KEY='hsRadar.history.publicRawCache.v1',COOLDOWN_KEY='hsRadar.history.sourceCooldown.v1';
  // Verified corporate-action annotation, not a price/calendar replacement.
  const SUSPENSIONS={"0050":{dates:['2025-06-11','2025-06-12','2025-06-13','2025-06-16','2025-06-17'],source:'https://www.twse.com.tw/zh/ETFortune/announcement?company=A00005&date=20250617&fund=0050&seq=1&type=other'}};
  const browserStorage=()=>{try{return typeof localStorage==='undefined'?null:localStorage;}catch{return null;}};
  const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
  async function sha256(value){const bytes=new TextEncoder().encode(JSON.stringify(canonical(value)));const cryptoApi=typeof module==='object'&&module.exports?require('node:crypto').webcrypto:globalThis.crypto;return Array.from(new Uint8Array(await cryptoApi.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');}
  class Source {
    constructor({fetcher=(...args)=>fetch(...args),headers=()=>({}),now=()=>new Date(),storage=browserStorage(),savedFetcher=typeof window==='undefined'?null:(...args)=>fetch(...args),archiveFetcher=typeof window==='undefined'?null:(...args)=>fetch(...args)}={}){
      this.fetcher=fetcher;this.headers=headers;this.now=now;this.storage=storage;this.savedFetcher=savedFetcher;this.saved=new Map();this.cache=new Map();this.blockedUntil=0;
      this.archiveFetcher=archiveFetcher;this.archives=new Map();this.archiveChecked=new Map();this.archiveErrors=new Map();this.updateManifest=null;this.manifestChecked=0;
      try{const stored=JSON.parse(storage?.getItem(CACHE_KEY)||'null');if(stored?.schema===1&&Array.isArray(stored.entries))for(const [key,value] of stored.entries.slice(-80))if(typeof key==='string'&&Array.isArray(value?.rows)&&Number.isFinite(value.at)&&Number.isFinite(Date.parse(value.fetchedAt)))this.cache.set(key,value);this.blockedUntil=Number(storage?.getItem(COOLDOWN_KEY))||0;}catch{/* Corrupt/private storage is never a data source. */}
    }
    persist(){try{const entries=[...this.cache.entries()];while(entries.length&&JSON.stringify(entries).length>1800000)entries.shift();this.storage?.setItem(CACHE_KEY,JSON.stringify({schema:1,entries}));}catch{/* Quota/privacy failure retains the in-memory cache. */}}
    cooldown(ms){this.blockedUntil=this.now().getTime()+ms;try{this.storage?.setItem(COOLDOWN_KEY,String(this.blockedUntil));}catch{}}
    async query(params,signal){
      if(signal?.aborted)throw Error('CANCELLED');
      const key=new URLSearchParams(params).toString(),cached=this.cache.get(key),now=this.now();
      const historical=params.dataset==='TaiwanStockPrice'&&params.end_date<now.toISOString().slice(0,4)+'-01-01';
      if(cached&&now.getTime()>=cached.at&&now.getTime()-cached.at<(historical?30*86400000:30*60*1000))return cached;
      if(now.getTime()<this.blockedUntil)throw Error('SOURCE_COOLDOWN');
      const abort=new AbortController(),cancel=()=>abort.abort();if(signal?.aborted)throw Error('CANCELLED');signal?.addEventListener('abort',cancel,{once:true});
      const timer=setTimeout(cancel,20000);
      try{const response=await this.fetcher('https://api.finmindtrade.com/api/v4/data?'+key,{headers:this.headers(),signal:abort.signal});if(!response.ok){if([402,429].includes(response.status))this.cooldown(3600000);throw Error('SOURCE_HTTP_'+response.status);}const p=await response.json();if(p.status!==200||!Array.isArray(p.data)){if([402,429].includes(p.status))this.cooldown(3600000);throw Error('SOURCE_SCHEMA_INVALID');}if(signal?.aborted)throw Error('CANCELLED');const result={rows:p.data,fetchedAt:this.now().toISOString(),at:this.now().getTime()};this.cache.set(key,result);if(this.cache.size>80)this.cache.delete(this.cache.keys().next().value);this.persist();return result;}
      catch(error){if(!signal?.aborted&&this.blockedUntil<=this.now().getTime())this.cooldown(300000);throw error;}
      finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
    }
    async savedSource(symbol,signal){
      if(this.saved.has(symbol))return this.saved.get(symbol);
      if(!this.savedFetcher)return null;
      // This file preserves original TaiwanStockPrice responses. Never import
      // research scores or the derived adjusted rows beside it.
      const response=await this.savedFetcher('research/c4_historical/source/'+encodeURIComponent(symbol)+'.json',{signal});
      if(response.status===404){this.saved.set(symbol,null);return null;}
      if(!response.ok)throw Error('SAVED_SOURCE_UNAVAILABLE');
      const p=await response.json();
      if(p.symbol!==symbol||p.provider!=='FinMind'||p.source_version!=='FINMIND_AS_OF_ADJUSTED_OHLC_V1'||!Array.isArray(p.price)||!Array.isArray(p.dividend)||!core.dateOK(p.requested_start)||!core.dateOK(p.requested_end)||!Number.isFinite(Date.parse(p.fetched_at)))throw Error('SAVED_SOURCE_INVALID');
      this.saved.set(symbol,p);return p;
    }
    async sessions(cutoff,signal){const result=await this.query({dataset:'TaiwanStockTradingDate'},signal);return{dates:core.calendar(result.rows,cutoff),fetchedAt:result.fetchedAt};}
    invalidate(symbol){this.cache.clear();this.archiveChecked.delete(symbol);this.manifestChecked=0;}
    async updateStatus(signal){
      if(!this.archiveFetcher)return null;
      const now=this.now().getTime();
      if(this.updateManifest&&this.manifestChecked&&now-this.manifestChecked<300000)return this.updateManifest;
      const response=await this.archiveFetcher('data/radar-history/status-v1.json?verified_at='+now,{signal,cache:'no-store'});
      if(response.status===404)return null;
      if(!response.ok)throw Error('DAILY_UPDATE_STATUS_UNAVAILABLE');
      const p=await response.json(),copy={...p};delete copy.content_sha256;
      if(p.schema_version!==1||p.price_type!=='RAW_UNADJUSTED'||!core.dateOK(p.price_cutoff)||p.expected_completed_bar!==null&&!core.dateOK(p.expected_completed_bar)||p.next_expected_trading_day!==null&&!core.dateOK(p.next_expected_trading_day)||!p.symbols||['0050','00662','00757','00830','00935','009815'].some(s=>!['CURRENT','STALE','UNAVAILABLE'].includes(p.symbols[s]?.status))||await sha256(copy)!==p.content_sha256)throw Error('DAILY_UPDATE_STATUS_INVALID');
      if(signal?.aborted)throw Error('CANCELLED');
      this.updateManifest=p;this.manifestChecked=now;return p;
    }
    async archive(symbol,signal){
      const now=this.now().getTime(),checked=this.archiveChecked.get(symbol),previous=this.archives.get(symbol);
      if(this.archives.has(symbol)&&checked!==undefined&&now>=checked&&now-checked<300000)return previous;
      try{
        const p=await this.fetchArchive(symbol,signal);
        if(previous&&!p)throw Error('VERIFIED_ARCHIVE_REMOVED');
        if(previous&&p&&p.requested_end<previous.requested_end)throw Error('VERIFIED_ARCHIVE_ROLLBACK');
        if(previous&&p){
          const byDate=new Map(p.price.map(r=>[r.date,r]));
          if(previous.price.some(r=>!byDate.has(r.date)||['open','max','min','close','Trading_Volume'].some(k=>byDate.get(r.date)[k]!==r[k])))throw Error('VERIFIED_ARCHIVE_HISTORY_CONFLICT');
        }
        this.archives.set(symbol,p);this.archiveChecked.set(symbol,now);this.archiveErrors.delete(symbol);return p;
      }catch(error){
        if(signal?.aborted)throw error;
        if(previous){this.archiveChecked.set(symbol,now);this.archiveErrors.set(symbol,error.message);return previous;}
        throw error;
      }
    }
    async fetchArchive(symbol,signal){
      if(!this.archiveFetcher)return null;
      const exchange=symbol==='009815'?'tpex':'twse';
      const response=await this.archiveFetcher('data/radar-history/'+exchange+'/'+encodeURIComponent(symbol)+'.json?verified_at='+this.now().getTime(),{signal,cache:'no-store'});
      if(response.status===404)return null;
      if(!response.ok)throw Error('TWSE_ARCHIVE_UNAVAILABLE');
      const p=await response.json(),copy={...p};delete copy.content_sha256;
      if(p.schema_version!==1||p.symbol!==symbol||p.provider!==(exchange==='tpex'?'TPEx/dailyQuotes':'TWSE/STOCK_DAY')||p.price_type!=='RAW_UNADJUSTED'||p.currency!=='TWD'||p.volume_unit!=='SHARES'||p.verified!==true||!Array.isArray(p.price)||!Array.isArray(p.dividends)||!core.dateOK(p.requested_start)||!core.dateOK(p.requested_end)||!Number.isFinite(Date.parse(p.fetched_at))||await sha256(copy)!==p.content_sha256)throw Error('TWSE_ARCHIVE_INVALID');
      const base=await this.savedSource(symbol,signal);
      if(base?(await sha256(base)!==p.base_source_sha256||base.price.at(-1)?.date!==p.base_last_date):p.base_source_sha256!==null)throw Error('TWSE_BASE_PROVENANCE_MISMATCH');
      if(p.price.some(r=>r.date<p.requested_start||r.date>p.requested_end||(base&&r.date<=p.base_last_date))||new Set(p.price.map(r=>r.date)).size!==p.price.length||core.prices(p.price,symbol,p.price.map(r=>r.date),p.requested_end,p.fetched_at).invalid.length)throw Error('TWSE_PRICE_INVALID');
      if(p.action_coverage?.start!==p.requested_start||p.action_coverage?.end!==p.requested_end||p.dividends.some(e=>!core.dateOK(e.date)||e.date<p.requested_start||e.date>p.requested_end||!core.finite(e.amount)||e.amount<=0||e.source!=='TWSE/TWT49U'))throw Error('TWSE_ACTION_INVALID');
      if(exchange==='tpex'&&(!Array.isArray(p.action_checks)||p.action_checks.length!==5||['exDailyQ','etfSplitRslt','etfRvsRslt','revivt','pvChgRslt'].some(key=>p.action_checks.filter(a=>a.source===key&&Array.isArray(a.matches)&&a.matches.length===0&&/^[a-f0-9]{64}$/.test(a.sha256)).length!==1)||p.overlap?.volume_differences?.length!==0||p.calendar_completeness!=='TPEX_INDEX_SESSIONS_VERIFIED'))throw Error('TPEX_VERIFICATION_INCOMPLETE');
      if(signal?.aborted)throw Error('CANCELLED');return p;
    }
    async savedSessions(symbol,scoreDates,signal){
      const saved=await this.savedSource(symbol,signal);
      const archive=await this.archive(symbol,signal);
      // An observed-date axis is NOT a complete exchange calendar. Callers must
      // disable calendar-dependent MA/completeness claims in this degraded mode.
      return{dates:[...new Set([...(saved?.price||[]).map(r=>r.date),...(archive?.price||[]).map(r=>r.date),...scoreDates].filter(core.dateOK))].sort(),fetchedAt:archive?.fetched_at||saved?.fetched_at||null,observedOnly:true};
    }
    async year(symbol,year,dates,cutoff,signal){
      if(!/^\d{4,6}[A-Z]?$/.test(symbol)||!Number.isInteger(year)||year<1999||year>Number(cutoff.slice(0,4)))throw Error('SOURCE_REQUEST_INVALID');
      const params={data_id:symbol,start_date:year+'-01-01',end_date:year+'-12-31'};
      const saved=await this.savedSource(symbol,signal),end=params.end_date<cutoff?params.end_date:cutoff;
      const archive=await this.archive(symbol,signal);
      if(archive){
        // Separate verified public archive. Never rewrite/replace overlapping
        // FinMind rows and never relabel raw TWSE prices as adjusted or FinMind.
        const inYear=r=>r.date.startsWith(year+'-')&&r.date<=end;
        const old=core.prices((saved?.price||[]).filter(inYear),symbol,dates,cutoff,saved?.fetched_at||archive.fetched_at);
        const tail=core.prices(archive.price.filter(inYear),symbol,dates,cutoff,archive.fetched_at);
        for(const r of tail.rows)r.source=archive.provider;
        const events=core.dividends((saved?.dividend||[]).filter(inYear),symbol,dates);
        for(const e of archive.dividends.filter(inYear))if((!saved||e.date>saved.requested_end)&&dates.includes(e.date))events.push({time:e.date,amount:e.amount,source:e.source});
        let manifest=null,statusWarning=null;
        try{manifest=await this.updateStatus(signal);}catch(error){if(signal?.aborted)throw error;statusWarning=error.message;}
        const state=manifest?.symbols?.[symbol],next=manifest?.next_expected_trading_day;
        const expected=manifest?(next&&cutoff>=next?next:manifest.expected_completed_bar||cutoff):cutoff;
        const expectedCompleted=expected<cutoff?expected:cutoff;
        const statusMatches=state?.archive_sha256===archive.content_sha256;
        const sourceWarning=this.archiveErrors.get(symbol)||(archive.requested_end<expectedCompleted?'TWSE_ARCHIVE_STALE':null)
          ||(state&&!statusMatches?'PUBLICATION_VERSION_MISMATCH':null)
          ||(statusMatches&&state.status!=='CURRENT'?state.reason||'OFFICIAL_SOURCE_PENDING':null)
          ||(manifest&&!next&&manifest.price_cutoff<cutoff?'OFFICIAL_UPDATE_OVERDUE':null)||statusWarning;
        return{rows:[...old.rows,...tail.rows].sort((a,b)=>a.time.localeCompare(b.time)),invalid:[...old.invalid,...tail.invalid],events,dividendStatus:archive.requested_end>=end||archive.action_coverage.end>=expectedCompleted?'VERIFIED':'UNAVAILABLE',fetchedAt:archive.fetched_at,sourceWarning,savedThrough:archive.requested_end,expectedCompleted,provider:archive.provider};
      }
      let raw,sourceWarning=null;
      if(saved&&saved.requested_start<=params.start_date){
        const prior=saved.price.filter(r=>r.date>=params.start_date&&r.date<=end);
        raw={rows:prior,fetchedAt:saved.fetched_at};
        if(saved.requested_end<end){
          try{
            // One overlapping session validates continuity. Never refetch the
            // already saved full history, and never silently overwrite conflicts.
            const start=prior.at(-1)?.date||params.start_date;
            const tail=await this.query({dataset:'TaiwanStockPrice',...params,start_date:start,end_date:end},signal);
            if(core.prices(tail.rows,symbol,dates,cutoff,tail.fetchedAt).invalid.length)throw Error('SOURCE_INCREMENT_INVALID');
            const returned=new Set(tail.rows.map(r=>r.date));
            if(prior.length&&!returned.has(start))throw Error('SOURCE_CONTINUITY_ANCHOR_MISSING');
            if(dates.some(d=>d>start&&d<=end&&!returned.has(d)))throw Error('SOURCE_CONTINUITY_GAP');
            const old=new Map(prior.map(r=>[r.date,r]));
            for(const r of tail.rows){const a=old.get(r.date);if(a&&['open','max','min','close','Trading_Volume'].some(k=>a[k]!==r[k]))throw Error('SOURCE_CONTINUITY_CONFLICT:'+r.date);}
            const fresh=new Set(tail.rows.map(r=>r.date));raw={rows:[...prior.filter(r=>!fresh.has(r.date)),...tail.rows],fetchedAt:tail.fetchedAt};
          }catch(error){if(signal?.aborted)throw error;sourceWarning=error.message;}
        }
      }else raw=await this.query({dataset:'TaiwanStockPrice',...params,end_date:end},signal);
      const inYear=r=>typeof r?.date==='string'&&r.date.startsWith(year+'-');
      const prices=core.prices(raw.rows.filter(inYear),symbol,dates,cutoff,raw.fetchedAt);
      prices.invalid.push(...raw.rows.filter(r=>!inYear(r)).map(r=>r?.date||'INVALID_DATE'));
      // Dividend history is small: one cached query per symbol, not one request
      // for every price chunk (important for the provider's public quota).
      let events=core.dividends(saved?.dividend?.filter(inYear)||[],symbol,dates),dividendStatus='VERIFIED';
      if(!saved||saved.requested_end<end)try{const result=await this.query({dataset:'TaiwanStockDividendResult',data_id:symbol,start_date:'1999-01-01',end_date:cutoff},signal);events=core.dividends(result.rows.filter(inYear),symbol,dates);}catch(error){if(signal?.aborted)throw error;dividendStatus='UNAVAILABLE';}
      // Preserve the acquisition date of cached bars, not the incremental request time.
      if(saved)for(const row of prices.rows)if(row.time<saved.requested_end)row.fetchedAt=saved.fetched_at;
      return{...prices,events,dividendStatus,fetchedAt:raw.fetchedAt,sourceWarning,savedThrough:saved?.requested_end||null};
    }
  }
  return{Source,SUSPENSIONS};
});
