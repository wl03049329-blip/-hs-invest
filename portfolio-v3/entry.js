(function () {
 'use strict';
 // This bootstrap intentionally uses conservative syntax so an unsupported
 // browser can show a diagnosis even when the modern portfolio bundle cannot.
 // It never reads or writes a holding, Ledger, cash record, or backup.
 var html=document.documentElement,observer=null,timer=null,settled=false,runtimeError=false,resourceError='',started=Date.now();
 var state={version:'3.1',phase:'pending',code:'V3_STARTING',root:false,api:false,css:false,workerControlled:false,card_code:'NOT_CHECKED'};
 html.setAttribute('data-hs-v3-boot','pending');
 function status(){return{version:state.version,phase:state.phase,code:state.code,root:state.root,api:state.api,css:state.css,card_code:state.card_code,workerControlled:!!(navigator.serviceWorker&&navigator.serviceWorker.controller),elapsed_ms:Date.now()-started,features:{webLocks:!!navigator.locks,webCrypto:!!(window.crypto&&window.crypto.subtle),objectHasOwn:typeof Object.hasOwn==='function',structuredClone:typeof window.structuredClone==='function'}};}
 window.HSPersonalV3Boot={status:status};
 function text(id,value){var n=document.getElementById(id);if(n)n.textContent=value;}
 function notice(code){var title=document.getElementById('hs-v3-boot-title');if(state.phase==='error'&&state.code===code&&title&&title.getAttribute('data-error-code')===code)return;state.phase='error';state.code=code;html.setAttribute('data-hs-v3-boot','error');text('hs-v3-boot-title','V3 暫時無法啟動');if(title)title.setAttribute('data-error-code',code);text('hs-v3-boot-message','新版尚未完整載入，因此不顯示舊版畫面。您的持股、現金與帳本沒有被重設；不需要清除 Safari 網站資料。');text('hs-v3-boot-code',code);var n=document.getElementById('hs-v3-boot-detail');if(n)n.textContent=JSON.stringify(status(),null,2);}
 function portfolio(){if(typeof window.switchTab==='function')window.switchTab('portfolio',{scroll:false});}
 function finish(root){
  var container=document.getElementById('hpv2'),children=container.children,i,n;
  for(i=0;i<children.length;i++){n=children[i];if(n===root||n.id==='hpv2-welcome'||n.id==='hpv2-status'||n.tagName==='DIALOG'||n.classList.contains('pv3upgrade'))continue;if(/^(HEADER|SECTION|DETAILS|FOOTER)$/.test(n.tagName)){n.hidden=true;n.setAttribute('data-hs-v3-legacy','true');}}
  // Move explanatory text to the existing settings dialog, not the dashboard.
  var basis=document.getElementById('pv3-basis'),settings=document.querySelector('.pv3-settings-body');if(basis&&settings&&!basis.hasAttribute('data-v3-help')){basis.setAttribute('data-v3-help','true');settings.appendChild(basis);}
  var welcome=document.getElementById('hpv2-welcome'),positions=root.querySelector('.pv3positions'),list=document.getElementById('pv3-list');if(welcome&&positions&&list&&!positions.contains(welcome))positions.insertBefore(welcome,list);
  var upgrade=document.querySelector('#hpv2 > .pv3upgrade');if(upgrade&&settings)settings.appendChild(upgrade);
  var pnlLabel=root.querySelector('.pv3pnl > div:nth-child(2) > span');if(pnlLabel){pnlLabel.textContent='持股累積損益（估算）';pnlLabel.title='目前持股未實現損益，不包含已實現損益與股息收入。';}
  // Base renders may occur again after initialization. Never expose a raw V2
  // holding if a later V3 read/render fails; this is DOM-only, not a data retry.
  var holdings=document.getElementById('hpv2-holdings'),cardNotice=document.createElement('p');cardNotice.id='hs-v3-card-diagnostic';cardNotice.setAttribute('role','status');cardNotice.hidden=true;positions.insertBefore(cardNotice,list);
  function guardCards(){var rows=holdings.querySelectorAll('.holding'),invalid=false;for(var j=0;j<rows.length;j++){var valid=!!rows[j].querySelector(':scope > details.pv3row > summary');if(valid)rows[j].removeAttribute('data-hs-v3-legacy-card');else{rows[j].setAttribute('data-hs-v3-legacy-card','true');invalid=true;}}state.card_code=invalid?'V3_CARD_RENDER_INCOMPLETE':'V3_CARDS_READY';cardNotice.hidden=!invalid;if(invalid&&cardNotice.textContent==='')cardNotice.textContent='部分持股尚未完成新版呈現，請查看資料核對提示。不會顯示舊版卡片，也不會重設持股。診斷碼：V3_CARD_RENDER_INCOMPLETE';}
  guardCards();new MutationObserver(guardCards).observe(holdings,{childList:true,subtree:true});
  state.phase='ready';state.code='V3_READY';html.setAttribute('data-hs-v3-boot','ready');settled=true;if(observer)observer.disconnect();clearTimeout(timer);portfolio();
 }
 function check(){
  if(settled)return;
  var root=document.querySelector('#hpv2 > .pv3');state.root=!!root;state.api=!!(window.HSPersonalV3&&window.HSPersonalV3.mode==='LOCAL_ONLY_V3');state.css=!!(root&&window.getComputedStyle(root).getPropertyValue('--hs-v3-layout-version').replace(/\s/g,'')==='3.1');
  if(runtimeError){notice('V3_JS_RUNTIME_ERROR');return;}
  if(resourceError){notice(resourceError);return;}
  if(root&&state.api&&state.css){var sections=root.querySelectorAll(':scope > section'),expected=['pv3assets','pv3allocation','pv3rebalance','pv3positions'],valid=sections.length===4;for(var i=0;i<expected.length&&valid;i++)valid=sections[i].classList.contains(expected[i]);if(!valid||!root.querySelector('.pv3positions #hpv2-holdings')){notice('V3_DOM_LAYOUT_MISMATCH');return;}finish(root);}
 }
 window.addEventListener('error',function(e){
  if(settled)return;var target=e.target,src=target&&(target.src||target.href)||'';
  if(/\/portfolio-v3\/personal-v3\.js/.test(src))resourceError='V3_SCRIPT_LOAD_FAILED';
  else if(/\/portfolio-v3\/v3\.css/.test(src))resourceError='V3_CSS_LOAD_FAILED';
  else if(/\/portfolio-v3\/personal-v3\.js/.test(e.filename||''))runtimeError=true;
  check();
 },true);
 window.addEventListener('unhandledrejection',function(e){if(settled)return;var stack=e.reason&&e.reason.stack;if(typeof stack==='string'&&stack.indexOf('/portfolio-v3/personal-v3.js')>=0){runtimeError=true;check();}});
 function start(){portfolio();check();if(!settled){observer=new MutationObserver(check);observer.observe(document.documentElement,{childList:true,subtree:true});timer=setTimeout(function(){check();if(!settled)notice(!state.root?'V3_ROOT_NOT_CREATED':!state.api?'V3_INITIALIZATION_INCOMPLETE':'V3_CSS_VERSION_MISMATCH');},15000);}var retry=document.getElementById('hs-v3-retry');if(retry)retry.onclick=function(){var url=new URL(location.href);url.searchParams.set('ui','3.1');url.searchParams.set('reload',String(Date.now()));location.replace(url.href);};}
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
 window.addEventListener('pageshow',function(e){if(e.persisted&&settled){var r=document.querySelector('#hpv2 > .pv3');if(!r){settled=false;notice('V3_RESTORED_DOM_MISSING');}}});
})();
