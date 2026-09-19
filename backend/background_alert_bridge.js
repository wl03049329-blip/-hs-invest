"use strict";
const fs=require("node:fs"),crypto=require("node:crypto"),path=require("node:path");
const rules=require(path.resolve(__dirname,"..","radar-alert-rules-v1.js"));
const contract=require(path.resolve(__dirname,"..","hs-decision-layer-v1.js"));
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==="object"?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
const sha=value=>crypto.createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
function percentile(file,score){
  if(!file||!Number.isFinite(Number(score)))return null;
  const artifact=JSON.parse(fs.readFileSync(file,"utf8")),{metadata,records,artifact_sha256}=artifact;
  if(metadata?.data_status!=="RESEARCH_HISTORICAL"||metadata?.score_level_version!=="HS_C4_LEVELS_V2"||metadata?.formula_version!=="FINAL_CORE_WEIGHT_V1"||metadata?.record_count!==records?.length||metadata?.records_sha256!==sha(records)||artifact_sha256!==sha({metadata,records}))return null;
  const values=records.map(row=>Number(row.display_score)).filter(Number.isFinite);
  return values.length?Math.round(values.filter(value=>value<=Number(score)).length/values.length*100):null;
}
function run(input){
  let state=rules.normalizeState(input.state),alerts=[];
  for(const item of input.symbols){
    const currentScore=rules.displayScore(item.current),previousScore=rules.displayScore(item.previous),result=rules.evaluateRadarAlerts({symbol:item.symbol,current:item.current,previous:item.previous,percentileCurrent:percentile(item.research_path,currentScore),percentilePrevious:percentile(item.research_path,previousScore),resolvedRules:rules.resolveRules(input.preferences,item.symbol),existingAlertState:state,contract});
    state=result.next_alert_state;alerts.push(...result.candidate_alerts);
  }
  return{engine_version:"HS_BACKGROUND_ALERT_ENGINE_V1",rule_version:rules.RULES_VERSION,state,alerts,bundles:rules.bundleRadarAlerts(alerts)};
}
let raw="";process.stdin.setEncoding("utf8");process.stdin.on("data",chunk=>raw+=chunk);process.stdin.on("end",()=>{try{process.stdout.write(JSON.stringify(run(JSON.parse(raw))))}catch(error){process.stderr.write(String(error?.name||"AlertBridgeError"));process.exitCode=1}});
