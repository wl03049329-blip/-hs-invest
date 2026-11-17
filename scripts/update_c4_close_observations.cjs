"use strict";
// Independent publisher: only the fixed observation artifact is writable.
process.env.TZ="UTC";
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const {decisionAtClose, VERSION, WEIGHTS}=require("./finalize_core_score_history");
const {labelFor}=require("../final-core-production");
const file=path.join(__dirname,"../data/c4-close-observations-v1.json");
const symbols=["0050","00757","00830","00935"];
const start="2026-11-11", limit=10;
const iso=d=>typeof d==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&Number.isFinite(Date.parse(d))&&new Date(d).toISOString().slice(0,10)===d;
const shift=(d,n)=>new Date(Date.parse(d)+n*86400000).toISOString().slice(0,10);
const n=x=>/^\d+(\.\d+)?$/.test(String(x).trim().replaceAll(",",""))?Number(String(x).trim().replaceAll(",","")):NaN;
const hash=b=>crypto.createHash("sha256").update(b).digest("hex");
function dates(now){
 const stamp=new Date(+now+28800000).toISOString(), today=stamp.slice(0,10);
 return {today,cutoff:stamp.slice(11,16)>="18:00"?today:shift(today,-1)};
}
async function get(url){
 for(let i=0;i<3;i++){
  try{
   const r=await fetch(url,{redirect:"error",signal:AbortSignal.timeout(15000)});
   if(!r.ok){if(r.status<500)throw Object.assign(Error("SOURCE_HTTP_"+r.status),{stop:true});throw Error("SOURCE_HTTP_"+r.status);}
   return Buffer.from(await r.arrayBuffer());
  }catch(e){if(e.stop||i===2)throw e;await new Promise(r=>setTimeout(r,2000*(i+1)));}
 }
}
async function tradingDays(first,last,fetchBytes=get){
 const cache=new Map(), days=[];
 for(let day=first;day<=last;day=shift(day,1)){
  if([0,6].includes(new Date(day).getUTCDay()))continue;
  const year=Number(day.slice(0,4));
  if(!cache.has(year)){
   const p=JSON.parse(await fetchBytes("https://www.twse.com.tw/rwd/zh/holidaySchedule/holidaySchedule?response=json&date="+year+"0101"));
   if(p.stat!=="ok"||p.queryYear!==year||!Array.isArray(p.data)||!p.data.length||p.total!==p.data.length||
    JSON.stringify(p.fields)!==JSON.stringify(["日期","名稱","說明"])||
    p.data.some(r=>!Array.isArray(r)||r.length!==3||!r.every(v=>typeof v==="string")||!iso(r[0])||!r[0].startsWith(year+"-")))throw Error("CALENDAR_UNVERIFIED");
   cache.set(year,p.data);
  }
  if(!cache.get(year).some(([d,name,description])=>d===day&&/休市|放假|市場無交易/.test(name+" "+description)&&!/開始交易|最後交易/.test(name+" "+description)))days.push(day);
 }
 return days;
}
function official(raw,day){
 const p=JSON.parse(raw),fields=["證券代號","開盤價","最高價","最低價","收盤價","成交股數"];
 if(p.stat!=="OK"||p.date!==day.replaceAll("-",""))throw Error("OFFICIAL_DATE_UNVERIFIED");
 const tables=(p.tables||[]).filter(t=>fields.every(f=>t.fields?.filter(x=>x===f).length===1));
 if(tables.length!==1||!Array.isArray(tables[0].data))throw Error("OFFICIAL_SCHEMA_UNVERIFIED");
 const table=tables[0], indexes=fields.map(f=>table.fields.indexOf(f)), out=new Map();
 for(const row of table.data){
  if(!Array.isArray(row))throw Error("OFFICIAL_ROW_UNVERIFIED");
  const [s,...v]=indexes.map(i=>row[i]);
  if(!symbols.includes(s))continue;
  if(out.has(s)){out.set(s,null);continue;}
  const [o,h,l,c,shares]=v.map(n);
  out.set(s,[o,h,l,c,shares].every(x=>Number.isFinite(x)&&x>0)&&Number.isSafeInteger(shares)&&
    h>=Math.max(o,c)&&l<=Math.min(o,c)?c:null);
 }
 return out;
}
async function extend(artifact,now,{fetchBytes=get,decide=decisionAtClose}={}){
 if(artifact.schema!=="HS_INDIVIDUAL_C4_CLOSE_OBSERVATIONS_V1"||artifact.official_final!==false||
    artifact.production_eligible!==false||artifact.score_version!==VERSION||artifact.calculation_timezone!=="UTC"||
    !Array.isArray(artifact.sessions)||artifact.sessions.some((s,i)=>!iso(s?.date)||s.date<start||
     (i>0&&s.date<=artifact.sessions[i-1].date)))throw Error("OBSERVATION_ARTIFACT_INVALID");
 const existing=new Map(artifact.sessions.map(s=>[s.date,s])),{cutoff}=dates(now);
 if(artifact.sessions.some(s=>s.date>cutoff))throw Error("FUTURE_OBSERVATION");
 const days=(await tradingDays(start,cutoff,fetchBytes)).filter(day=>symbols.some(s=>!existing.get(day)?.symbols?.[s])).slice(0,limit), added=[],pending=[];
 for(const day of days){
  const source="https://www.twse.com.tw/exchangeReport/MI_INDEX?response=json&date="+day.replaceAll("-","")+"&type=ALLBUT0999";
  const prior=existing.get(day);
  let raw,closes;
  try{
   raw=await fetchBytes(source);closes=official(raw,day);
   if(prior&&(prior.source!==source||prior.source_sha256!==hash(raw)))throw Error("OFFICIAL_RECEIPT_CHANGED");
  }catch(e){pending.push({date:day,symbol:"ALL",reason:/^[A-Z0-9_]+$/.test(e.message)?e.message:"OFFICIAL_UNAVAILABLE"});continue;}
  const rows={...prior?.symbols};
  let count=0;
  for(const s of symbols){
   if(rows[s])continue;
   try{
   if(!closes.get(s))throw Error("OFFICIAL_OHLC_UNVERIFIED");
   const d=await decide(s,day), factors={};
   if(d?.coreScoreVersion!==VERSION||!Number.isFinite(d.coreScore)||d.coreScore<0||d.coreScore>100||
      !Number.isFinite(d.source_close)||Math.abs(d.source_close-closes.get(s))>1e-6||
      d.label!==labelFor(d.coreScore).label)throw Error("SCORE_CLOSE_UNVERIFIED_"+s);
   let total=0;
   for(const [key,field] of [["weekly_j","weeklyJ"],["dd52","dd52"],["crash","crash"]]){
    const f=d.coreFactors?.[field], weight=WEIGHTS[key];
    if(!Number.isFinite(f?.raw)||!Number.isFinite(f?.score)||f.score<0||f.score>100||f.weight!==weight||
       !Number.isFinite(f.contribution)||Math.abs(f.contribution-f.score*weight/100)>1e-8)throw Error("FACTOR_UNVERIFIED_"+s);
    factors[key]=[f.raw,f.score];total+=f.contribution;
   }
   if(Math.abs(total-d.coreScore)>1e-8)throw Error("TOTAL_UNVERIFIED_"+s);
   rows[s]={status:"VERIFIED_OBSERVATION",close:closes.get(s),score:d.coreScore,tier:d.label,factors};
   count++;
   }catch(e){pending.push({date:day,symbol:s,reason:/^[A-Z0-9_]+$/.test(e.message)?e.message:"ADJUSTED_INPUT_UNAVAILABLE"});}
  }
  if(count){const session={date:day,source,source_sha256:hash(raw),symbols:rows};existing.set(day,session);added.push(session);}
 }
 return {added,pending,result:{...artifact,sessions:[...existing.values()].sort((a,b)=>a.date.localeCompare(b.date))}};
}
async function main(){
 const write=process.argv[2]==="--write";
 if(process.argv.length>3||(process.argv[2]&&!write))throw Error("USAGE");
 const base=fs.readFileSync(file),{added,pending,result}=await extend(JSON.parse(base),new Date());
 if(write&&added.length){
  const tmp=file+".tmp-"+process.pid;
  fs.writeFileSync(tmp,JSON.stringify(result,null,2)+"\n",{flag:"wx"});
  try{if(!fs.readFileSync(file).equals(base))throw Error("SOURCE_CHANGED");fs.renameSync(tmp,file);}
  finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
 }
 if(pending.length){
  console.warn("::warning::Incomplete independent observations: "+JSON.stringify(pending));
  if(!added.length)throw Error("NO_VERIFIED_OBSERVATION_ADDED");
 }
 console.log("close observations:",added.map(s=>s.date).join(",")||"current (no write)");
}
if(require.main===module)main().catch(e=>{console.error("CLOSE_OBSERVATION_FAILED",e.message);process.exitCode=1;});
module.exports={dates,official,extend};
