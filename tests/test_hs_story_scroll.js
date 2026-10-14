'use strict';
const assert=require('node:assert/strict');

// Read-only browser audit. Run this on the actual page after wheel/touch scrolling,
// then validate the result and click #closeHsStory through normal browser input.
function measureStoryViewport(){
  const modal=document.querySelector('#hsStoryModal'),sheet=modal.querySelector('.hsStorySheet'),scroller=document.querySelector('#hsStoryScroll'),button=document.querySelector('#closeHsStory');
  const rect=button.getBoundingClientRect(),frame=sheet.getBoundingClientRect(),content=scroller.getBoundingClientRect();
  return {open:modal.classList.contains('show'),width:innerWidth,height:innerHeight,
    top:rect.top,bottom:rect.bottom,buttonWidth:rect.width,buttonHeight:rect.height,
    hit:document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2)===button,
    sheetTop:frame.top,sheetBottom:frame.bottom,contentTop:content.top,
    scrollTop:scroller.scrollTop,maxScroll:scroller.scrollHeight-scroller.clientHeight,
    modalScrollTop:modal.scrollTop,sheetScrollTop:sheet.scrollTop,
    overflow:scroller.scrollWidth>scroller.clientWidth,
    active:modal.querySelector('.hsStoryNav [aria-current="true"]')?.dataset.storyTarget};
}
function assertStoryViewport(m,{bottom=false}={}){
  assert.equal(m.open,true);assert.ok(m.top>=0&&m.bottom<=m.height,'close stays inside viewport');
  assert.ok(m.buttonWidth>=44&&m.buttonHeight>=44,'44px touch target');
  assert.equal(m.hit,true,'close is the actual hit target');assert.equal(m.overflow,false);
  assert.ok(m.contentTop>=m.bottom,'story starts below header');
  assert.equal(m.modalScrollTop,0);assert.equal(m.sheetScrollTop,0);
  if(bottom)assert.ok(Math.abs(m.scrollTop-m.maxScroll)<=2,'test reached actual story bottom');
}
module.exports={measureStoryViewport,assertStoryViewport};

if(require.main===module){
  const fs=require('node:fs'),vm=require('node:vm'),html=fs.readFileSync('index.html','utf8'),css=fs.readFileSync('formal-black-gold.css','utf8');
  const classes=()=>({values:new Set(),add(v){this.values.add(v)},remove(v){this.values.delete(v)},contains(v){return this.values.has(v)},toggle(v,on){on?this.add(v):this.remove(v)}});
  const node=(id,top=0)=>({id,classList:classes(),events:{},attrs:{},scrollTop:0,dataset:{},getBoundingClientRect(){return {top,height:60}},addEventListener(type,fn){this.events[type]=fn},setAttribute(k,v){this.attrs[k]=v},removeAttribute(k){delete this.attrs[k]},focus(options){this.focused=options},scrollTo(options){this.lastScroll=options;this.scrollTop=options.top}});
  const ids=['intention','etfs','birth','research','leverage','future'].map(id=>'hs-story-'+id),chapters=ids.map((id,i)=>node(id,240+i*400)),buttons=ids.map(id=>({...node(id),dataset:{storyTarget:id}}));
  const nav=node('nav'),scroller=node('hsStoryScroll',80),modal=node('hsStoryModal'),trigger=node('openHsStory'),close=node('closeHsStory'),top=node('hsStoryTop'),guide=node('hsCanonicalScoreGuide');
  scroller.querySelectorAll=()=>chapters;scroller.querySelector=()=>nav;scroller.contains=n=>chapters.includes(n);
  modal.contains=n=>buttons.includes(n);const nodes=Object.fromEntries([modal,trigger,close,scroller,top,guide,node('hsMethodologyLink')].map(n=>['#'+n.id,n]));
  const document={documentElement:{classList:classes()},querySelectorAll:()=>buttons,getElementById:id=>chapters.find(n=>n.id===id),events:{},addEventListener(type,fn){this.events[type]=fn}};
  const context={$:id=>nodes[id],document,HSFinalCoreProduction:{LABELS:[]},esc:String,setTimeout:fn=>fn(),switchTab(){}};
  const start=html.indexOf('let lastHsStoryTrigger='),end=html.indexOf('function drawdownReferenceHigh',start);
  vm.runInNewContext(html.slice(start,end),context);
  scroller.scrollTop=500;context.openHsStory({currentTarget:trigger});assert.equal(scroller.scrollTop,0);assert.equal(modal.attrs['aria-hidden'],'false');assert.equal(document.documentElement.classList.contains('hsStoryOpen'),true);assert.equal(close.focused.preventScroll,true);
  assert.equal(scroller.events.scroll,context.syncHsStoryActive);assert.equal(modal.events.scroll,undefined);
  for(const chapter of chapters){scroller.scrollTop=20;context.scrollHsStoryChapter(chapter.id);assert.equal(scroller.lastScroll.top,20+chapter.getBoundingClientRect().top-80-60-12);assert.equal(scroller.lastScroll.behavior,'smooth');assert.equal(buttons.find(b=>b.dataset.storyTarget===chapter.id).attrs['aria-current'],'true');}
  const last=scroller.lastScroll;context.scrollHsStoryChapter('not-a-story-chapter');assert.equal(scroller.lastScroll,last);
  chapters[3].getBoundingClientRect=()=>({top:140,height:200});scroller.events.scroll();assert.equal(buttons[3].attrs['aria-current'],'true');
  top.events.click();assert.equal(scroller.lastScroll.top,0);
  close.events.click();assert.equal(modal.classList.contains('show'),false);assert.equal(document.documentElement.classList.contains('hsStoryOpen'),false);assert.equal(trigger.focused.preventScroll,true);
  context.openHsStory();document.events.keydown({key:'Escape'});assert.equal(modal.attrs['aria-hidden'],'true');
  context.openHsStory();modal.events.click({target:close});assert.equal(modal.classList.contains('show'),true);modal.events.click({target:modal});assert.equal(modal.classList.contains('show'),false);
  assert.match(css,/\.hsStorySheet\{[^}]*display:flex[^}]*flex-direction:column[^}]*min-height:0[^}]*overflow:hidden/);
  assert.match(css,/\.hsStoryScroll\{[^}]*min-height:0[^}]*overflow:auto/);assert.match(css,/\.hsStoryHeader\{[^}]*flex:0 0 auto/);assert.match(css,/height:100dvh/);
  assert.doesNotMatch(html.slice(start,end),/modal\.scrollTop|#hsStoryModal"\)\.scrollTo|target\.scrollIntoView/);
  const visible={open:true,top:10,bottom:54,height:844,buttonWidth:56,buttonHeight:44,hit:true,overflow:false,contentTop:70,scrollTop:500,maxScroll:500,modalScrollTop:0,sheetScrollTop:0};assertStoryViewport(visible,{bottom:true});
  assert.throws(()=>assertStoryViewport({...visible,top:-500,bottom:-456},{bottom:true}),/inside viewport/);assert.throws(()=>assertStoryViewport({...visible,hit:false}),/hit target/);
  console.log('PASS HS Story scroller/reset, six chapter jumps, active chapter, close/Escape/backdrop, body unlock and bottom hit-test audit');
}
