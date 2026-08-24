(function(root,factory){
  const api=factory(
    typeof require==="function"?require("./portfolio-core.js"):root?.HSPortfolioCore,
    typeof require==="function"?require("./data-freshness-core.js"):root?.HSDataFreshnessCore
  );
  if(typeof module==="object"&&module.exports)module.exports=api;
  if(root)root.HSPersonalCapitalInputCore=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(portfolioCore,freshnessCore){
  "use strict";

  // Contract only: this module never scores securities or calculates portfolio values itself.
  const VERSION="PERSONAL_CAPITAL_INPUT_V1";
  const ELIGIBLE_SYMBOLS=Object.freeze(["0050","00662","00830","00935","009815"]);
  const EXCLUDED_SYMBOLS=Object.freeze(["00631L","006201","00733","00757"]);
  const MAX_FORMAL_TRADING_DAY_AGE=1;
  const MAX_INTRADAY_AGE_MINUTES=90;
  const MAX_FUTURE_SKEW_MS=5*60*1000;
  const SOURCE_CONFLICT_PCT=.5;
  const DATE_RE=/^\d{4}-\d{2}-\d{2}$/;
  const finite=value=>{
    if(value===null||value===undefined||value==="")return null;
    const number=Number(value);
    return Number.isFinite(number)?number:null;
  };
  const symbolOf=value=>String(value??"").trim().toUpperCase();
  const unique=values=>[...new Set(values)];
  const validDate=value=>DATE_RE.test(String(value||""));
  const dateAtClose=value=>Date.parse(`${value}T13:30:00+08:00`);
  const nowDate=(now)=>freshnessCore?.taipeiDate?freshnessCore.taipeiDate(now):new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Taipei",year:"numeric",month:"2-digit",day:"2-digit"}).format(now);
  const tradingAge=(date,now)=>freshnessCore?.tradingDayAge?freshnessCore.tradingDayAge(date,nowDate(now)):null;
  function blank(status){return{status,valid:false};}
  function formalFreshness(date,fetchedAt,now){
    if(!validDate(date))return blank("MISSING");
    const dateTime=dateAtClose(date),fetched=Date.parse(String(fetchedAt||""));
    if(!Number.isFinite(dateTime)||!Number.isFinite(fetched))return blank("INVALID");
    if(dateTime>now.getTime()+MAX_FUTURE_SKEW_MS||fetched>now.getTime()+MAX_FUTURE_SKEW_MS)return blank("FUTURE_DATED");
    const age=tradingAge(date,now);
    if(age===null)return blank("INVALID");
    if(age>MAX_FORMAL_TRADING_DAY_AGE)return blank("EXPIRED");
    return{status:"CURRENT",valid:true,tradingDayAge:age};
  }
  function intradayFreshness(date,asOf,now){
    if(!validDate(date)||date!==nowDate(now))return blank(validDate(date)&&date>nowDate(now)?"FUTURE_DATED":"STALE");
    const timestamp=Date.parse(String(asOf||""));
    if(!Number.isFinite(timestamp))return blank("INVALID");
    const age=now.getTime()-timestamp;
    if(age< -MAX_FUTURE_SKEW_MS)return blank("FUTURE_DATED");
    if(age>MAX_INTRADAY_AGE_MINUTES*60*1000)return blank("STALE");
    return{status:"CURRENT",valid:true,ageMinutes:age/60000};
  }
  function quoteFreshness(quote,now=new Date()){
    if(!quote||typeof quote!=="object")return blank("MISSING");
    const price=finite(quote.price);
    if(price===null||price<=0)return blank("INVALID");
    const date=String(quote.date||"");
    const mode=quote.quoteMode==="delayed"?"INTRADAY":"FORMAL";
    const asOf=quote.quoteAsOf||quote.asOf||quote.fetchedAt;
    const verdict=mode==="INTRADAY"?intradayFreshness(date,asOf,now):formalFreshness(date,quote.fetchedAt,now);
    return{...verdict,mode,date,fetchedAt:String(quote.fetchedAt||""),asOf:String(asOf||"")};
  }
  function sourceConflict(quote,sources=[]){
    const current=finite(quote?.price),date=String(quote?.date||"");
    if(current===null||current<=0||!validDate(date)||!Array.isArray(sources))return false;
    return sources.some(source=>{
      const price=finite(source?.price),sourceDate=String(source?.date||"");
      return price!==null&&price>0&&sourceDate===date&&Math.abs(price-current)/current*100>SOURCE_CONFLICT_PCT;
    });
  }
  function portfolioRow(symbol,holdings,quotes){
    if(!portfolioCore?.calculatePortfolio)return null;
    const calculated=portfolioCore.calculatePortfolio(Array.isArray(holdings)?holdings:[],quotes instanceof Map?quotes:new Map(Object.entries(quotes||{})));
    return calculated.rows.find(row=>row.code===symbol)||null;
  }
  function normalizePortfolioSymbol({symbol,holdings,quotes,now=new Date(),quoteSources=[]}={}){
    const code=symbolOf(symbol),row=portfolioRow(code,holdings,quotes);
    if(!row)return{symbol:code,quoteStatus:"MISSING",valid:false,reasons:["PORTFOLIO_HOLDING_MISSING"]};
    const quote=row.quote;
    const freshness=quoteFreshness(quote,now);
    const conflict=sourceConflict(quote,quoteSources);
    const marketValue=finite(row.marketValue),marketPrice=finite(quote?.price),target=finite(row.targetAllocation);
    const reasons=[];
    if(!quote)reasons.push("PORTFOLIO_QUOTE_MISSING");
    else if(!freshness.valid)reasons.push(freshness.status==="FUTURE_DATED"?"PORTFOLIO_QUOTE_FUTURE":freshness.status==="MISSING"?"PORTFOLIO_QUOTE_MISSING":freshness.status==="STALE"||freshness.status==="EXPIRED"?"PORTFOLIO_QUOTE_STALE":"PORTFOLIO_QUOTE_INVALID");
    if(marketPrice===null||marketPrice<=0||marketValue===null||marketValue<=0)reasons.push("PORTFOLIO_MARKET_VALUE_UNAVAILABLE");
    if(target===null||target<0||target>100)reasons.push("TARGET_ALLOCATION_MISSING");
    if(conflict)reasons.push("SOURCE_CONFLICT");
    return{symbol:code,shares:finite(row.shares),averageCost:finite(row.averageCost),marketPrice,marketValue,actualWeightPct:finite(row.weight),targetAllocationPct:target,quoteDate:String(quote?.date||""),quoteFetchedAt:String(quote?.fetchedAt||""),quoteStatus:conflict?"SOURCE_CONFLICT":freshness.status,quoteMode:freshness.mode||"FORMAL",quoteAsOf:freshness.asOf||"",valid:!reasons.length,reasons};
  }
  function radarSource(item,decision){
    const mode=item?.scoreMode==="intraday"?"INTRADAY":"FORMAL";
    if(mode==="INTRADAY")return{mode,decision:decision||item?.strategyDecisions?.long_term_core||null,asOf:String(item?.intraday?.asOf||""),date:String(item?.intraday?.quoteDate||item?.date||""),finalizedThrough:String(item?.formalState?.date||"")};
    return{mode,decision:decision||item?.formalStrategyDecisions?.long_term_core||item?.strategyDecisions?.long_term_core||null,asOf:String(item?.formalState?.date||item?.date||""),date:String(item?.formalState?.date||item?.date||""),finalizedThrough:String(item?.formalState?.date||item?.date||"")};
  }
  function normalizeRadarSymbol({symbol,radarItem,radarDecision,now=new Date()}={}){
    const code=symbolOf(symbol),source=radarSource(radarItem,radarDecision),decision=source.decision;
    const reasons=[];
    if(!decision||typeof decision!=="object")reasons.push("RADAR_DECISION_MISSING");
    const score=finite(decision?.score),coverage=finite(decision?.coverage),scoreStatus=String(decision?.scoreStatus||"");
    if(score===null)reasons.push("RADAR_SCORE_UNAVAILABLE");
    // Existing long-term decisions declare complete at >=80% coverage. Provisional decisions are not capital-safe.
    if(scoreStatus!=="complete"||coverage===null||coverage<80)reasons.push("RADAR_COVERAGE_INSUFFICIENT");
    let freshness;
    if(source.mode==="INTRADAY")freshness=intradayFreshness(source.date,source.asOf,now);
    else freshness=formalFreshness(source.date,source.asOf?`${source.asOf}T13:30:00+08:00`:"",now);
    if(!freshness.valid)reasons.push(freshness.status==="STALE"||freshness.status==="EXPIRED"?"RADAR_STALE":freshness.status==="MISSING"?"RADAR_ASOF_MISSING":"RADAR_ASOF_INVALID");
    return{symbol:code,score,stage:decision?.stage||null,scoreStatus,coverage,metrics:decision?.metrics||{},breakdown:Array.isArray(decision?.breakdown)?decision.breakdown:[],scoreMode:source.mode==="INTRADAY"?"intraday":"formal",decisionMode:source.mode,radarAsOf:source.asOf,finalizedThrough:source.finalizedThrough,radarDate:source.date,radarStatus:freshness.status,valid:!reasons.length,reasons};
  }
  function normalizeSymbol(input={}){
    const symbol=symbolOf(input.symbol||input.radarItem?.id);
    if(!ELIGIBLE_SYMBOLS.includes(symbol))return{version:VERSION,symbol,eligibility:"DATA_UNAVAILABLE",reasons:["SYMBOL_OUT_OF_SCOPE"],portfolio:null,radar:null,freshness:{portfolio:"MISSING",radar:"MISSING",sourceConflict:false},asOf:{portfolioDate:"",radarDate:"",decisionMode:"FORMAL",aligned:false}};
    const now=input.now instanceof Date?input.now:new Date(input.now||Date.now());
    const portfolio=normalizePortfolioSymbol({...input,symbol,now});
    const radar=normalizeRadarSymbol({...input,symbol,now});
    const aligned=portfolio.quoteMode===radar.decisionMode&&portfolio.quoteDate===radar.radarDate;
    const reasons=unique([...portfolio.reasons,...radar.reasons,...(aligned?[]:["ASOF_MISMATCH"])]);
    return{version:VERSION,symbol,eligibility:reasons.length?"DATA_UNAVAILABLE":"READY",reasons,portfolio,radar,freshness:{portfolio:portfolio.quoteStatus,radar:radar.radarStatus,sourceConflict:portfolio.quoteStatus==="SOURCE_CONFLICT"},asOf:{portfolioDate:portfolio.quoteDate,radarDate:radar.radarDate,decisionMode:radar.decisionMode,aligned}};
  }
  function normalizePortfolio(input={}){
    const holdings=Array.isArray(input.holdings)?input.holdings:[];
    const collective=portfolioCore?.validateTargetAllocations?portfolioCore.validateTargetAllocations(holdings):{ok:false,complete:false,total:null};
    return{version:VERSION,targetAllocation:collective,symbols:holdings.map(holding=>normalizeSymbol({...input,symbol:holding?.code}))};
  }
  return Object.freeze({VERSION,ELIGIBLE_SYMBOLS,EXCLUDED_SYMBOLS,MAX_FORMAL_TRADING_DAY_AGE,MAX_INTRADAY_AGE_MINUTES,SOURCE_CONFLICT_PCT,quoteFreshness,normalizePortfolioSymbol,normalizeRadarSymbol,normalizeSymbol,normalizePortfolio});
});
