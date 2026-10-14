/* Presentation only. Never feed formatted strings back into score calculations. */
(function(root){
  'use strict';
  const decimal=new Intl.NumberFormat('en-US',{useGrouping:false,minimumFractionDigits:1,maximumFractionDigits:1});
  function score(value){
    if(typeof value!=='number'||!Number.isFinite(value))return '—';
    const text=decimal.format(value);return text==='-0.0'?'0.0':text;
  }
  function signed(value){const text=score(value);return text==='—'||text==='0.0'?text:value>0?'+'+text:text;}
  const api=Object.freeze({score,signed});
  if(typeof module==='object'&&module.exports)module.exports=api;
  root.HSC4Display=api;
  root.formatC4Score=score;
  root.formatC4Signed=signed;
})(typeof window==='object'?window:globalThis);
