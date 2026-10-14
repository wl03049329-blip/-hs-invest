'use strict';
const assert=require('node:assert/strict');

// Read-only browser audit. Run this on the actual page after wheel/touch scrolling,
// then validate the result and click #closeHsStory through normal browser input.
function measureStoryViewport(){
  const modal=document.querySelector('#hsStoryModal'),sheet=modal.querySelector('.hsStorySheet'),scroller=document.querySelector('#hsStoryScroll'),button=document.querySelector('#closeHsStory');
  const rect=button.getBoundingClientRect(),frame=sheet.getBoundingClientRect(),content=scroller.getBoundingClientRect();
  const vv=window.visualViewport,hit=document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2);
  return {open:modal.classList.contains('show'),width:innerWidth,height:innerHeight,
    visualTop:vv?.offsetTop||0,visualLeft:vv?.offsetLeft||0,visualWidth:vv?.width||innerWidth,visualHeight:vv?.height||innerHeight,
    parentId:button.parentElement.id,modalParent:modal.parentElement.tagName,text:button.textContent,
    left:rect.left,right:rect.right,localTop:parseFloat(getComputedStyle(button).top),
    modalLayer:Number(getComputedStyle(modal).zIndex),sheetLayer:Number(getComputedStyle(sheet).zIndex),closeLayer:Number(getComputedStyle(button).zIndex),
    top:rect.top,bottom:rect.bottom,buttonWidth:rect.width,buttonHeight:rect.height,
    hit:hit===button||button.contains(hit),
    sheetTop:frame.top,sheetBottom:frame.bottom,contentTop:content.top,
    scrollTop:scroller.scrollTop,maxScroll:scroller.scrollHeight-scroller.clientHeight,
    modalScrollTop:modal.scrollTop,sheetScrollTop:sheet.scrollTop,
    overflow:scroller.scrollWidth>scroller.clientWidth,
    active:modal.querySelector('.hsStoryNav [aria-current="true"]')?.dataset.storyTarget};
}
function assertStoryViewport(m,{bottom=false}={}){
  assert.equal(m.open,true);assert.equal(m.parentId,'hsStoryModal');assert.equal(m.modalParent,'BODY');assert.match(m.text,/✕\s*關閉/);
  assert.ok(m.top>=m.visualTop&&m.bottom<=m.visualTop+m.visualHeight,'close stays inside visual viewport');
  assert.ok(m.left>=m.visualLeft&&m.right<=m.visualLeft+m.visualWidth,'close stays inside visual viewport horizontally');
  assert.ok(m.top>=m.visualTop+m.localTop-1,'close clears the configured safe area');
  assert.ok(m.modalLayer>120&&m.closeLayer>m.sheetLayer,'root modal and direct close layers are above page and sheet');
  assert.ok(m.buttonWidth>=48&&m.buttonHeight>=48,'48px touch target');
  assert.equal(m.hit,true,'close is the actual hit target');assert.equal(m.overflow,false);
  assert.equal(m.modalScrollTop,0);assert.equal(m.sheetScrollTop,0);
  if(bottom)assert.ok(Math.abs(m.scrollTop-m.maxScroll)<=2,'test reached actual story bottom');
}
module.exports={measureStoryViewport,assertStoryViewport};

if(require.main===module){
  const fs=require('node:fs'),vm=require('node:vm'),html=fs.readFileSync('index.html','utf8'),css=fs.readFileSync('formal-black-gold.css','utf8');
  const classes=()=>({values:new Set(),add(v){this.values.add(v)},remove(v){this.values.delete(v)},contains(v){return this.values.has(v)},toggle(v,on){on?this.add(v):this.remove(v)}});
  const node=(id,top=0)=>({id,classList:classes(),events:{},attrs:{},scrollTop:0,dataset:{},style:{values:{},getPropertyValue(k){return this.values[k]},setProperty(k,v){this.values[k]=v}},getBoundingClientRect(){return {top,height:60}},addEventListener(type,fn){this.events[type]=fn},setAttribute(k,v){this.attrs[k]=v},removeAttribute(k){delete this.attrs[k]},focus(options){this.focused=options},scrollTo(options){this.lastScroll=options;this.scrollTop=options.top}});
  const ids=['intention','etfs','birth','research','leverage','future'].map(id=>'hs-story-'+id),chapters=ids.map((id,i)=>node(id,240+i*400)),buttons=ids.map(id=>({...node(id),dataset:{storyTarget:id}}));
  const nav=node('nav'),scroller=node('hsStoryScroll',80),modal=node('hsStoryModal'),trigger=node('openHsStory'),close=node('closeHsStory'),top=node('hsStoryTop'),guide=node('hsCanonicalScoreGuide');
  scroller.querySelectorAll=()=>chapters;scroller.querySelector=()=>nav;scroller.contains=n=>chapters.includes(n);
  modal.contains=n=>buttons.includes(n);const nodes=Object.fromEntries([modal,trigger,close,scroller,top,guide,node('hsMethodologyLink')].map(n=>['#'+n.id,n]));
  const document={documentElement:{classList:classes()},querySelectorAll:()=>buttons,getElementById:id=>chapters.find(n=>n.id===id),events:{},addEventListener(type,fn){this.events[type]=fn}};
  const viewport={offsetTop:0,offsetLeft:0,width:390,height:844,events:{},addEventListener(type,fn){this.events[type]=fn}},window={innerWidth:390,innerHeight:844,visualViewport:viewport,events:{},addEventListener(type,fn){this.events[type]=fn}};
  const context={$:id=>nodes[id],document,window,HSFinalCoreProduction:{LABELS:[]},esc:String,setTimeout:fn=>fn(),switchTab(){}};
  const start=html.indexOf('let lastHsStoryTrigger='),end=html.indexOf('function drawdownReferenceHigh',start);
  vm.runInNewContext(html.slice(start,end),context);
  scroller.scrollTop=500;context.openHsStory({currentTarget:trigger});assert.equal(scroller.scrollTop,0);assert.equal(modal.attrs['aria-hidden'],'false');assert.equal(document.documentElement.classList.contains('hsStoryOpen'),true);assert.equal(close.focused.preventScroll,true);
  assert.equal(modal.style.values['--hs-story-view-height'],'844px');viewport.offsetTop=60;viewport.height=600;viewport.events.scroll();assert.equal(modal.style.values['--hs-story-view-top'],'60px');assert.equal(modal.style.values['--hs-story-view-height'],'600px');
  viewport.offsetLeft=20;viewport.width=195;viewport.events.resize();assert.equal(modal.style.values['--hs-story-view-left'],'20px');assert.equal(modal.style.values['--hs-story-view-width'],'195px');
  window.visualViewport=null;window.events.resize();assert.equal(modal.style.values['--hs-story-view-top'],'0px');assert.equal(modal.style.values['--hs-story-view-height'],'844px');
  assert.equal(scroller.events.scroll,context.syncHsStoryActive);assert.equal(modal.events.scroll,undefined);
  for(const chapter of chapters){scroller.scrollTop=20;context.scrollHsStoryChapter(chapter.id);assert.equal(scroller.lastScroll.top,20+chapter.getBoundingClientRect().top-80-60-12);assert.equal(scroller.lastScroll.behavior,'smooth');assert.equal(buttons.find(b=>b.dataset.storyTarget===chapter.id).attrs['aria-current'],'true');}
  const last=scroller.lastScroll;context.scrollHsStoryChapter('not-a-story-chapter');assert.equal(scroller.lastScroll,last);
  chapters[3].getBoundingClientRect=()=>({top:140,height:200});scroller.events.scroll();assert.equal(buttons[3].attrs['aria-current'],'true');
  top.events.click();assert.equal(scroller.lastScroll.top,0);
  close.events.click();assert.equal(modal.classList.contains('show'),false);assert.equal(document.documentElement.classList.contains('hsStoryOpen'),false);assert.equal(trigger.focused.preventScroll,true);
  context.openHsStory();document.events.keydown({key:'Escape'});assert.equal(modal.attrs['aria-hidden'],'true');
  context.openHsStory();modal.events.click({target:close});assert.equal(modal.classList.contains('show'),true);modal.events.click({target:modal});assert.equal(modal.classList.contains('show'),false);
  assert.match(css,/\.hsStorySheet\{[^}]*display:flex[^}]*flex-direction:column[^}]*min-height:0[^}]*overflow:hidden/);
  assert.match(css,/\.hsStoryScroll\{[^}]*min-height:0[^}]*overflow:auto/);assert.match(css,/\.hsStoryHeader\{[^}]*flex:0 0 auto/);assert.match(css,/100dvh/);
  assert.match(css,/#hsStoryModal>#closeHsStory\{[^}]*position:absolute[^}]*min-height:48px/);assert.equal((html.match(/id="closeHsStory"/g)||[]).length,1);assert.ok(html.indexOf('id="closeHsStory"')<html.indexOf('<article class="sheet hsStorySheet">'));
  assert.doesNotMatch(html.slice(start,end),/modal\.scrollTop|#hsStoryModal"\)\.scrollTo|target\.scrollIntoView/);
  // Positive visibility / hit / tap assertions run only against actual WebKit DOM
  // in hs_story_webkit_acceptance.cjs, never a prefilled success object.
  console.log('PASS HS Story scroller/reset, visual viewport updates, direct close structure, six chapter jumps, close/Escape/backdrop and body unlock');
}
