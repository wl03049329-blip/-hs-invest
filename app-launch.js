(function(){
 'use strict';
 var script=document.currentScript,base=new URL('./',script.src),path=location.pathname.slice(base.pathname.length),tabs=['today','signals','portfolio','sentiment','more'];
 var aliases=['portfolio-v3/','portfolio-v3/index.html','personal-v2/','personal-v2/index.html','index 2.html'],query=new URLSearchParams(location.search),tab=query.get('tab');
 if(aliases.indexOf(decodeURI(path))>=0){var url=new URL(base);url.searchParams.set('tab','portfolio');if(/^\d{4,6}$/.test(query.get('radarEtf')||''))url.searchParams.set('radarEtf',query.get('radarEtf'));location.replace(url.href);return;}
 if(!tab&&tabs.indexOf(location.hash.slice(1))>=0)tab=location.hash.slice(1);
 if(tabs.indexOf(tab)>=0)try{sessionStorage.setItem('hsRadar.activeTab',tab);}catch(_){}
})();
