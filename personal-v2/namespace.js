(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.HSPersonalNamespace=api;})(globalThis,function(){
 'use strict';
 const PREFIX='hsPersonalV2.v1.';
 function encode(key){return [...new TextEncoder().encode(String(key))].map(x=>x.toString(16).padStart(2,'0')).join('');}
 function decode(key){const x=key.slice(PREFIX.length);if(!/^(?:[a-f0-9]{2})+$/.test(x))throw Error('PERSONAL_STORAGE_KEY_INVALID');return new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(x.match(/../g),h=>parseInt(h,16)));}
 function create(storage){const keys=()=>{const a=[];for(let i=0;i<storage.length;i++){const k=storage.key(i);if(k?.startsWith(PREFIX))a.push(k);}return a;};return Object.freeze({get length(){return keys().length;},key(i){const k=keys()[i];return k===undefined?null:decode(k);},getItem(k){return storage.getItem(PREFIX+encode(k));},setItem(k,v){storage.setItem(PREFIX+encode(k),String(v));},removeItem(k){storage.removeItem(PREFIX+encode(k));}});}
 return Object.freeze({PREFIX,create,isOwnKey:key=>typeof key==='string'&&key.startsWith(PREFIX)});
});
