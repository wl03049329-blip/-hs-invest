(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.HSPersonalNamespace=api;})(globalThis,function(){
 'use strict';
 const PREFIX='hsPersonalV3.v1.',LEGACY_PREFIX='hsPersonalV2.v1.';
 function encode(key){return [...new TextEncoder().encode(String(key))].map(x=>x.toString(16).padStart(2,'0')).join('');}
 function decode(key,prefix){const x=key.slice(prefix.length);if(!/^(?:[a-f0-9]{2})+$/.test(x))throw Error('PERSONAL_STORAGE_KEY_INVALID');return new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(x.match(/../g),h=>parseInt(h,16)));}
 function scoped(storage,prefix,readonly){const keys=()=>{const a=[];for(let i=0;i<storage.length;i++){const k=storage.key(i);if(k?.startsWith(prefix))a.push(k);}return a;};return Object.freeze({namespace:prefix,get length(){return keys().length;},key(i){const k=keys()[i];return k===undefined?null:decode(k,prefix);},getItem(k){return storage.getItem(prefix+encode(k));},setItem(k,v){if(readonly)throw Error('LEGACY_STORAGE_IS_READ_ONLY');storage.setItem(prefix+encode(k),String(v));},removeItem(k){if(readonly)throw Error('LEGACY_STORAGE_IS_READ_ONLY');storage.removeItem(prefix+encode(k));}});}
 const create=storage=>scoped(storage,PREFIX,false),legacy=storage=>scoped(storage,LEGACY_PREFIX,true);
 return Object.freeze({PREFIX,LEGACY_PREFIX,create,legacy,isOwnKey:key=>key===null||typeof key==='string'&&key.startsWith(PREFIX)});
});
