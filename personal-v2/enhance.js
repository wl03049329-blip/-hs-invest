(function(){
 const $=id=>document.getElementById('hpv2-'+id),colors=['#4bd7a0','#65a8f5','#ffb65d','#b96ef7','#ed708d','#77d7dd','#d6c170'];
 const color=i=>colors[i]||`hsl(${((i*137.508)%360).toFixed(3)} 65% 65%)`;
 const money=minor=>Number.isSafeInteger(minor)?'NT$ '+(minor/100).toLocaleString('zh-TW',{maximumFractionDigits:2}):'暫不可計算';
 const svgNode=(name,attributes)=>{const n=document.createElementNS('http://www.w3.org/2000/svg',name);for(const[k,v]of Object.entries(attributes))n.setAttribute(k,String(v));return n;};
 function update(){
  const read=host.HSPersonalV2?.read;if(!read)return;let v;try{v=read();}catch{v={status:'RECOVERY_REQUIRED',rows:[],cash_minor:null};}
  $('availableCash').textContent=money(v.cash_minor);const pnl=v.status==='REFERENCE_READY'&&v.rows.every(r=>Number.isFinite(r.estimatedPnl))?Math.round(v.rows.reduce((s,r)=>s+r.estimatedPnl,0)*100):null;$('estimatedTotalPnl').textContent=money(pnl);$('estimatedTotalPnl').className=pnl>0?'pvProfit':pnl<0?'pvLoss':'';
  $('planReferenceTotal').textContent=money(v.reference?.forecast_minor?.reduce((s,n)=>s+n,0));
  const cards=[...scope.querySelectorAll('#hpv2-holdings .holding')];cards.forEach((card,i)=>{card.style.setProperty('--holding-color',color(i));const cells=card.querySelectorAll('dd'),row=v.rows[i];if(row)for(const[index,value]of[[4,row.estimatedPnl],[5,row.estimatedReturn]])cells[index]?.classList.toggle('pvProfit',value>0),cells[index]?.classList.toggle('pvLoss',value<0);});
  $('donut').replaceChildren();$('donutLegend').replaceChildren();const svg=svgNode('svg',{viewBox:'0 0 240 240',role:'img','aria-label':'股票與ETF持股占比'}),track=svgNode('circle',{cx:120,cy:120,r:88,fill:'none',stroke:'#292929','stroke-width':26});svg.append(track);let offset=0;
  const complete=v.status==='REFERENCE_READY'&&v.rows.length>0&&v.equity_minor>0&&v.rows.every(r=>Number.isSafeInteger(r.market_value_minor));
  if(complete)v.rows.forEach((r,i)=>{const pct=r.market_value_minor/v.equity_minor*100,circle=svgNode('circle',{cx:120,cy:120,r:88,fill:'none',stroke:color(i),'stroke-width':26,pathLength:100,'stroke-dasharray':`${pct} ${100-pct}`,'stroke-dashoffset':-offset,transform:'rotate(-90 120 120)'});offset+=pct;svg.append(circle);const row=document.createElement('div');row.className='pvLegendRow';row.dataset.symbol=r.symbol;row.style.setProperty('--holding-color',color(i));const name=document.createElement('span'),amount=document.createElement('strong'),ratio=document.createElement('span');name.textContent=r.symbol+' '+r.name;amount.textContent=money(r.market_value_minor);ratio.textContent=pct.toFixed(1)+'%';row.append(name,amount,ratio);$('donutLegend').append(row);});
  for(const[y,text,size]of[[112,'股票總市值',13],[138,complete?money(v.equity_minor):'—',18]]){const n=svgNode('text',{x:120,y,'text-anchor':'middle',fill:'#f4d68b','font-size':size,'font-weight':600});n.textContent=text;svg.append(n);}$('donut').append(svg);
  $('donutStatus').textContent=v.status==='RECOVERY_REQUIRED'?'資料需要確認，暫時無法計算完整占比。':complete?'僅計股票與ETF持股，不含現金；比例與持股清單順序一致。':v.rows.length?'部分持股行情待更新，暫時無法計算完整占比。':'新增持股後，取得有效行情即可查看占比。';
  for(const b of scope.querySelectorAll('[data-month]')){const active=Number(b.dataset.month)===v.settings?.duration_months;b.setAttribute('aria-pressed',String(active));b.classList.toggle('selected',active);b.disabled=!v.snapshot;}
 }
 for(const button of scope.querySelectorAll('[data-month]'))button.onclick=()=>{$('localSettingsOpen').click();$('months').value=button.dataset.month;$('localSettingsForm').requestSubmit();};
 host.addEventListener('hs-personal-v2-changed',update);host.addEventListener('hs-personal-v2-market-updated',()=>setTimeout(update,0));addEventListener('storage',()=>setTimeout(update,0));setTimeout(update,0);
})();
