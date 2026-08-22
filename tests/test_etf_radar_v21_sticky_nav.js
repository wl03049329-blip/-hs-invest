const fs=require('fs');
const html=fs.readFileSync('index.html','utf8');
const css=fs.readFileSync('formal-black-gold.css','utf8');
function assert(ok,message){if(!ok)throw new Error(message)}

assert(/id="radarDetailStickyNav"/.test(html),'sticky detail nav missing');
assert(/aria-label="ETF 詳情導覽"/.test(html),'sticky nav landmark missing');
assert(/id="radarDetailStickyBack"[^>]*>← ETF 雷達/.test(html),'compact return control missing');
assert(/id="radarDetailStickyCollapse"[^>]*aria-label="收合 ETF 詳情"/.test(html),'collapse accessible label missing');
assert(/id="radarDetailBack"[^>]*hidden/.test(html),'legacy large back control must stay hidden');
assert(/function syncRadarDetailStickyNav\(id,visible\)/.test(html),'sticky nav state helper missing');
assert(/syncRadarDetailStickyNav\(id,true\)/.test(html),'detail open must reveal sticky nav');
assert(/syncRadarDetailStickyNav\(null,false\)/.test(html),'detail close must hide sticky nav');
assert(/radarDetailStickyBack.*addEventListener\("click",closeRadarDetail\)/.test(html),'return control must reuse close behavior');
assert(/radarDetailStickyCollapse.*addEventListener\("click",closeRadarDetail\)/.test(html),'collapse control must reuse close behavior');
assert(/\.radarDetailStickyNav\{position:sticky/.test(css),'sticky positioning missing');
assert(/\.radarDetailStickyNav\[hidden\]\{display:none!important\}/.test(css),'hidden overview state missing');
assert(/@media\(max-width:430px\)[\s\S]*\.radarDetailStickyNav/.test(css),'mobile sticky nav rules missing');
console.log('ETF RADAR V2.1 sticky detail navigation: PASS');
