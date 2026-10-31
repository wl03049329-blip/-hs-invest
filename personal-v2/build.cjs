'use strict';
// A private browser bundle: verbatim, previously sealed LOCAL_ONLY contracts.
// No shared HS global or original portfolio storage key is replaced.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),REF='31394246f406134f0dc0fe9df2d25ee541c6efeb';
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const inputPath=path.join(__dirname,'sealed-inputs.json'),inputs=fs.existsSync(inputPath)?JSON.parse(fs.readFileSync(inputPath,'utf8')):{source_commit:REF,files:{}};if(inputs.source_commit!==REF)throw Error('SEALED_SOURCE_VERSION_CHANGED');
const source=p=>{const item=inputs.files[p];if(item){if(sha(item.content)!==item.sha256)throw Error('SEALED_SOURCE_SHA_MISMATCH:'+p);return item.content;}const content=cp.execFileSync('git',['show',REF+':'+p],{cwd:root,maxBuffer:16*1024*1024}).toString('utf8');inputs.files[p]={sha256:sha(content),content};return content;};
// The old portfolio UI also owned this homepage-only renderer. Retain its
// exact function body without starting any old financial writer.
const legacy=fs.readFileSync(path.join(root,'portfolio-v6.js'),'utf8'),homeStart=legacy.indexOf('  function renderHomeSentiment()'),homeEnd=legacy.indexOf('\n  function applySharedQuotes(',homeStart),home=legacy.slice(homeStart,homeEnd);
if(homeStart<0||homeEnd<0)throw Error('HOME_VIEW_BOUNDARY_CHANGED');
const homeView=`/* Verbatim homepage renderer from the deployed portfolio-v6.js; no financial writes. */\n(function(){'use strict';const $v6=s=>document.querySelector(s),number=(v,d=2)=>Number.isFinite(v)?new Intl.NumberFormat('zh-TW',{maximumFractionDigits:d}).format(v):'—',escapeHtml=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));\n${home}\nconst observer=new MutationObserver(renderHomeSentiment);for(const id of ['fomoContent','cnnFearGreedContent']){const node=document.getElementById(id);if(node)observer.observe(node,{childList:true});}document.getElementById('homeSentimentCards')?.addEventListener('click',event=>{const card=event.target.closest('[data-home-chip]');if(!card||card.id==='homeCnnCard')return;switchTab('sentiment');if(typeof switchChipTab==='function')switchChipTab(card.dataset.homeChip,{scroll:false});});renderHomeSentiment();})();\n`;
fs.writeFileSync(path.join(__dirname,'legacy-home-view.js'),homeView);
const original=source('local-first/index.html');
// Reuse the original site's legal instrument names, never its cached prices.
const quoteBytes=fs.readFileSync(path.join(root,'market-quotes.json')),marketNames=JSON.parse(quoteBytes),etfNames=JSON.parse(fs.readFileSync(path.join(root,'etf-universe.json'))),names=new Map();
for(const r of [...(marketNames.items||[]),...(etfNames.items||[])])if(/^\d{4,6}[A-Z]?$/.test(r.code)&&typeof r.name==='string'&&r.name.trim())names.set(r.code,{code:r.code,name:r.name.trim()});
fs.writeFileSync(path.join(__dirname,'instrument-names.json'),JSON.stringify({schema:'HS_PERSONAL_NAMES_V1',source_files:['market-quotes.json','etf-universe.json'],market_source_sha256:sha(quoteBytes),items:[...names.values()].sort((a,b)=>a.code.localeCompare(b.code))})+'\n');
const modules=[...original.matchAll(/<script src="\/(.+?\.js)"/g)].map(m=>m[1]).filter(p=>!['portfolio-local-site-runtime.js','site-config.js','app.js','integration.js'].includes(p));
const records=modules.map(p=>({path:p,sha256:sha(source(p))}));
let bundle=`/* HS personal V2 — LOCAL_ONLY; production financial writer OFF. */\n(function(host){'use strict';\nconst module=undefined,window={crypto:host.crypto},globalThis=window;\n`;
for(const p of modules)bundle+=`\n/* sealed source: ${p} */\n${source(p)}\n;`;
bundle+=fs.readFileSync(path.join(__dirname,'namespace.js'),'utf8')+'\n';
bundle+=`const {${[...new Set(bundle.match(/(?:HSPortfolio|HSCanonicalScoreResolver)[A-Za-z0-9_]*/g))].join(',')}}=window;\n`;
bundle+=`const scope=document.getElementById('hpv2'),localStorage=window.HSPersonalNamespace.create(host.localStorage),base=new URL('../',document.currentScript.src);\n`;
bundle+=`const HSLocalSiteConfig={quote_endpoint:'hpv2:quotes'},HSLocalSiteRuntime={allowed:l=>(l.hostname==='wl03049329-blip.github.io'&&l.pathname.startsWith('/-hs-invest/'))||['127.0.0.1','localhost'].includes(l.hostname),quoteURL:(c,symbols)=> 'hpv2:quotes?symbols='+symbols.join(',')};\n`;
bundle+=`const addEventListener=(type,fn)=>host.addEventListener(type,type==='storage'?e=>{if(window.HSPersonalNamespace.isOwnKey(e.key))fn(e);}:fn);\n`;
bundle+=fs.readFileSync(path.join(__dirname,'quotes.js'),'utf8').replace('__PUSH_SW_SHA__',sha(fs.readFileSync(path.join(root,'push-service-worker.js'))))+'\n';
let app=source('local-first/app.js'),integration=source('local-first/integration.js');
const transform=s=>s.replaceAll('document.getElementById(id)',"document.getElementById('hpv2-'+id)").replaceAll('document.querySelectorAll','scope.querySelectorAll').replaceAll('#holdings','#hpv2-holdings').replaceAll("fetch('/etf-universe.json')","fetch(new URL('personal-v2/instrument-names.json',base))").replaceAll("fetch('/finalized-core-score-snapshots-v1.json'","fetch(new URL('finalized-core-score-snapshots-v1.json',base)").replaceAll('hs-local-changed','hs-personal-v2-changed').replaceAll('hs-local-market-updated','hs-personal-v2-market-updated');
app=transform(app).replace('navigator.serviceWorker?.controller','false').replace('if(navigator.serviceWorker&&(await navigator.serviceWorker.getRegistrations()).length)',"if(!(await safeWorker()))");
app=app.replace("data=await cryptoBackup.encrypt(payload,p)","data=await cryptoBackup.encrypt({schema:'HS_PERSONAL_V2_EXPORT_V1',payload},p)");
app=app.replace('restoreTicket=api.previewRestore(payload);',"if(payload.schema!=='HS_PERSONAL_V2_EXPORT_V1')throw Error('請選擇新版個人持股備份；不會自動搬移舊帳本。');payload=payload.payload;restoreTicket=api.previewRestore(payload);");
app=app.replace('舊成本與交易紀錄完整保留。不會用舊成本猜測券商損益平衡價。','舊版資料未變更；新版使用獨立記錄，不讀取或搬移舊帳本。');
app=app.replace("card.append(edit);const protectedPosition", "card.append(edit);card.tabIndex=0;card.setAttribute('role','group');card.addEventListener('click',e=>{if(!busy&&!e.target.closest('button')&&!card.closest('.revealed')&&Math.abs(parseFloat(card.style.transform?.match(/-?\\d+/)?.[0]||'0'))<10)openHolding(h);});card.addEventListener('keydown',e=>{if(!busy&&e.key==='Enter'&&e.target===card)openHolding(h);});const protectedPosition");
integration=transform(integration).replace('navigator.serviceWorker?.controller','false').replace('if(navigator.serviceWorker&&(await navigator.serviceWorker.getRegistrations()).length)return;',"if(!(await safeWorker()))return;").replaceAll('HSLocalUXError(e)','window.HSLocalUXError(e)');
integration=integration.replace("return`${symbol}：C4 ${row.score.toFixed(1)}", "return`${symbol}：C4 ${row.score.toFixed(1)}｜${host.HSFinalCoreProduction?.labelFor(row.score)?.label||'資料需要確認'}");
integration=integration.replaceAll('row.score.toFixed(1)','(host.HSC4Display?.score(row.score)??String(row.score))');
// Export a read-only private view, never the financial write API.
integration=integration.replace('globalThis.HSLocalPortfolio=Object.freeze({read});','host.HSPersonalV2=Object.freeze({read,mode:\'LOCAL_ONLY\',productionWriter:false});');
bundle+=app+'\n'+integration+'\n'+fs.readFileSync(path.join(__dirname,'enhance.js'),'utf8')+'\n})(self);\n';
fs.writeFileSync(path.join(__dirname,'personal-v2.js'),bundle);
fs.writeFileSync(path.join(__dirname,'sealed-sources.json'),JSON.stringify({source_commit:REF,modules:records,bundle_sha256:sha(bundle)},null,2)+'\n');
// Reuse the tested forms and safe controls, with private IDs and no second page.
let body=original.slice(original.indexOf('<main>')+6,original.indexOf('<script src="/portfolio-core.js"'));
body=body.replace(/<\/main>/g,'').replace(/<header>[\s\S]*?<\/header>/,'<header class="pvHeading"><p>HS · 個人持股</p><h2 id="portfolioTitle">我的投資組合</h2><p>持股與現金一眼掌握，資料只保存在這台裝置。</p></header>');
body=body.replace('這是獨立網站，不會讀取或搬動舊 HS 網站持股。','新版採獨立記錄，不會讀取或搬動舊版持股與帳本。');
const settings=original.match(/<dialog id="localSettingsDialog">[\s\S]*?<\/dialog>/)[0];
body+=settings;
const overview=body.match(/<section class="hsCpDashboard" aria-labelledby="overviewTitle">[\s\S]*?<\/section>/)[0];
body=body.replace(overview,`<section class="hsCpDashboard" aria-labelledby="overviewTitle"><h3 id="overviewTitle">投資組合摘要</h3><div class="pvSummary"><div>總資產<strong id="totalAssets">暫不可計算</strong></div><div>股票市值<strong id="equityValue">暫不可計算</strong></div><div>可用現金<strong id="availableCash">尚未設定</strong></div><div>未實現損益（估算）<strong id="estimatedTotalPnl">暫不可計算</strong></div></div><p class="pvRatios">股票 <span id="equityWeight">—</span> · 現金 <span id="cashWeight">—</span></p><p id="allocationStatus"></p><p id="localExposureNote"></p></section>`);
const c4=body.match(/<section class="hsCpDashboard" aria-labelledby="c4Title">[\s\S]*?<\/section>/)[0];body=body.replace(c4,'');
const planStart=body.indexOf('<section class="hsCpDashboard">\n<h2>我的建倉計畫</h2>');
const planStartCR=body.indexOf('<section class="hsCpDashboard">\r\n<h2>我的建倉計畫</h2>');
const at=planStart>=0?planStart:planStartCR;if(at<0)throw Error('PLAN_SECTION_NOT_FOUND');
body=body.slice(0,at)+`<section class="hsCpDashboard pvDonutPanel"><h2>持股占比</h2><p>以股票與ETF參考市值計算，不包含現金。</p><div class="pvDonutLayout"><div id="donut"></div><div id="donutLegend"></div></div><p id="donutStatus"></p></section>`+c4+body.slice(at);
body=body.replace('<h2>我的建倉計畫</h2>','<h2>建倉計畫</h2><div class="pvMonths" aria-label="建倉期程"><button type="button" data-month="3">3個月</button><button type="button" data-month="6">6個月</button><button type="button" data-month="12">12個月</button></div><p>計畫參考投入：<b id="planReferenceTotal">暫不可計算</b></p><p>目前進度：尚未記錄實際投入；登記持股不等於買進。</p><p>剩餘參考額度：尚無實際投入紀錄，暫不可計算。</p>');
body=body.replace('<h2>備份與還原</h2>','<h2>加密備份</h2>');
body=body.replace(/id="(?!portfolioTitle")([^"]+)"/g,(_,id)=>`id="hpv2-${id}"`).replace(/aria-labelledby="([^"]+)"/g,(_,id)=>`aria-labelledby="hpv2-${id}"`);
body='<div id="hpv2" class="hpv2">'+body+'</div>';
const htmlPath=path.join(root,'index.html');let html=fs.readFileSync(htmlPath,'utf8');
const start=html.indexOf('<section id="portfolio"');if(start<0||html.indexOf('<section id="portfolio"',start+1)>=0)throw Error('ORIGINAL_PORTFOLIO_MISSING');
const openEnd=html.indexOf('>',start)+1,tags=/<\/?section\b[^>]*>/g;tags.lastIndex=openEnd;let depth=1,end=-1,m;while((m=tags.exec(html))){depth+=m[0].startsWith('</')?-1:1;if(depth===0){end=m.index;break;}}if(end<0)throw Error('PORTFOLIO_BOUNDARY_INVALID');
html=html.slice(0,openEnd)+body+html.slice(end);
html=html.replace(/<script defer src="personal-v2\/legacy-home-view\.js[^>]*><\/script>\n?/,'');
html=html.replace(/<script(?: defer)? src="(?:portfolio-v6\.js|personal-v2\/personal-v2\.js)[^>]+><\/script>/,'<script defer src="personal-v2/legacy-home-view.js?v='+sha(homeView).slice(0,16)+'"></script>\n<script defer src="personal-v2/personal-v2.js?v='+sha(bundle).slice(0,16)+'"></script>');
html=html.replace(/<link rel="stylesheet" href="personal-v2\/personal-v2\.css[^>]*>\n?/g,'');
html=html.replace('</head>','<link rel="stylesheet" href="personal-v2/personal-v2.css?v='+sha(fs.readFileSync(path.join(__dirname,'personal-v2.css'))).slice(0,16)+'">\n</head>');
fs.writeFileSync(htmlPath,html);fs.writeFileSync(inputPath,JSON.stringify(inputs)+'\n');console.log(JSON.stringify({modules:records.length,bundle_sha256:sha(bundle),portfolio_only:true}));
