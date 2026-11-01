'use strict';
// Keep every legacy assertion, but explicitly run retired DOM assertions against
// its frozen historical fixture. Independently exercise the CURRENT V3 engine.
const fs=require('fs'),cp=require('child_process'),path=require('path'),vm=require('vm'),assert=require('assert/strict');
const root=path.resolve(__dirname,'../..'),fixture='67972ca837af4cf74a9e94c2550c5303c6ec87eb';
function section(s){const start=s.indexOf('<section id="portfolio"');assert(start>=0);const re=/<\/?section\b[^>]*>/g;re.lastIndex=start;let depth=0,m;while(m=re.exec(s)){depth+=m[0].startsWith('</')?-1:1;if(!depth)return{start,end:re.lastIndex,text:s.slice(start,re.lastIndex)};}throw Error('PORTFOLIO_SECTION_MISSING');}
function current(){const html=fs.readFileSync(path.join(root,'index.html'),'utf8'),s=fs.readFileSync(path.join(root,'portfolio-v3/personal-v3.js'),'utf8');assert.match(html,/defer src="portfolio-v3\/personal-v3.js"/);assert.doesNotMatch(html,/src="portfolio-v6.js/);for(const id of ['pv3-total','pv3-daily','pv3-pnl','pv3-equity','pv3-cost','pv3-cash','pv3-donut','pv3-targets','pv3-plan','pv3-list'])assert(s.includes('id="'+id+'"'),id);const order=['pv3assets','pv3allocation','pv3rebalance','pv3positions'].map(c=>s.indexOf('class="'+c+'"'));assert(order.every((x,i)=>x>0&&(!i||x>order[i-1])));
 const end=s.indexOf("const scope=document.getElementById('hpv2')");assert(end>0);const box={crypto:require('crypto').webcrypto,TextEncoder,TextDecoder,console};vm.createContext(box);vm.runInContext(s.slice(0,end)+'host.contract=window;})(globalThis);',box);vm.runInContext(`
 const V=contract.HSPersonalV3Core,P=contract.HSPortfolioCapitalBuildPlanCore,A=contract.HSPortfolioPerformanceCore;
 const now='2026-11-01T04:00:00Z',prefs=V.preferences(null,{...V.defaults(),targets:{'0050':40,'00935':60},feeReserveMinor:100},now), holdings=[{symbol:'0050',shares:100,break_even_price:10},{symbol:'00935',shares:100,break_even_price:20}];
 const quotes=new Map(holdings.map(h=>[h.symbol,{date:'2026-10-30',price:30,latest:true}]));
 const opts={holdings,cashMinor:1000000,prefs,quotes,c4:{'0050':{score:72,latest:true},'00935':{score:50,latest:true}},now,positionValue:P.localPositionValue,allocate:A.buildCapitalAllocationPlan};
 const before=JSON.stringify([holdings,prefs]),v=V.view(opts);if(v.equity_minor!==600000||v.total_assets_minor!==1600000||v.pnl_minor!==300000||v.rows[0].weight!==50||v.rows[0].target!==40||v.production_writer!==false||v.executable_budget_minor!==null)throw Error('CURRENT_V3_CALCULATION_REGRESSION');
 if(v.rows[0].reference_budget_minor>0||v.rows.reduce((n,r)=>n+(r.reference_budget_minor||0),0)>opts.cashMinor||JSON.stringify([holdings,prefs])!==before)throw Error('CASH_CONSERVATION_OR_MUTATION');
 const missing=V.view({...opts,quotes:new Map()});if(missing.total_assets_minor!==null||missing.pnl_minor!==null||missing.period_reference_minor!==null)throw Error('MISSING_QUOTE_NOT_CLOSED');
 const partial=V.view({...opts,prefs:V.preferences(null,{...V.defaults(),targets:{'0050':40}},now)});if(partial.targets_complete||partial.period_reference_minor!==null)throw Error('INDIVIDUAL_TARGETS_NOT_COMPLETE');
 const noCash=V.view({...opts,cashMinor:null});if(noCash.total_assets_minor!==null||noCash.period_reference_minor!==null)throw Error('CASH_NOT_INITIALIZED');
`,box);
 // Real group contract remains independent: stock-only denominator; partial
 // targets allowed, unlike individual allocation's complete100% budget gate.
 const G=require('../../portfolio-v3/position-groups'),fp=require('crypto').createHash,g=G.create(null,{mode:'GROUPS',groups:[{id:'synthetic',name:'合成',symbols:['0050'],target_bps:3500}]},'2026-11-01T04:00:00Z',x=>fp('sha256').update(JSON.stringify(x)).digest('hex'));
 const groups=G.aggregate({complete:true,rows:[{symbol:'0050',market_value_minor:205000},{symbol:'00935',market_value_minor:795000}]},g);assert.equal(groups[0].weight,20.5);assert.equal(groups[0].gap,-14.5);assert.equal(groups[0].target_minor,350000);return html;}
function legacyPortfolioHTML(){const html=current(),old=cp.execFileSync('git',['show',fixture+':index.html'],{cwd:root,maxBuffer:8e6}).toString(),a=section(html),b=section(old);console.log('CURRENT V3 executable invariants PASS; retained legacy DOM fixture '+fixture);return html.slice(0,a.start)+b.text+html.slice(a.end);}
module.exports={legacyPortfolioHTML,current};
