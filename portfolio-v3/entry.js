'use strict';
// Deployment wiring only: open the already verified portfolio tab.
// No storage migration, financial write, simulated position, or API mutation.
const openPortfolioV3=()=>{if(typeof switchTab==='function')switchTab('portfolio',{scroll:false});};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',openPortfolioV3,{once:true});
else openPortfolioV3();
