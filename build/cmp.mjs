import { bunzip } from '../site/vendor/bz2.js';
import { decodeLevel2 } from '../site/js/decoder.js';
const BASE='https://unidata-nexrad-level2.s3.amazonaws.com';
const pad=n=>String(n).padStart(2,'0');
const now=new Date(); let key=null;
for(let b=0;b<2&&!key;b++){const d=new Date(now-b*864e5);const day=`${d.getUTCFullYear()}/${pad(d.getUTCMonth()+1)}/${pad(d.getUTCDate())}/`;const xml=await(await fetch(`${BASE}/?list-type=2&prefix=${day}KTLX/`)).text();const ks=[...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map(m=>m[1]).filter(k=>!k.endsWith('_MDM'));if(ks.length)key=ks.sort().pop();}
const ab=await(await fetch(`${BASE}/${key}`)).arrayBuffer();
console.log('file bytes:', ab.byteLength, 'key:', key);
const t0=Date.now(); const full=decodeLevel2(ab.slice(0), bunzip); const t1=Date.now();
const fast=decodeLevel2(ab.slice(0), bunzip, {firstSweepOnly:true}); const t2=Date.now();
function sig(d){let mn=1/0,mx=-1/0,n=0,s=0;for(const v of d.ref){if(Number.isFinite(v)){if(v<mn)mn=v;if(v>mx)mx=v;n++;s+=v;}}return `nR=${d.nRadials} nG=${d.numGates} site=${d.siteLat.toFixed(4)},${d.siteLon.toFixed(4)} min=${mn} max=${mx} n=${n} mean=${(s/n).toFixed(4)}`;}
console.log('FULL ('+(t1-t0)+'ms):', sig(full));
console.log('FAST ('+(t2-t1)+'ms):', sig(fast));
// exact array equality
let eq = full.nRadials===fast.nRadials && full.ref.length===fast.ref.length;
if(eq) for(let i=0;i<full.ref.length;i++){const a=full.ref[i],b=fast.ref[i];if(!((Number.isNaN(a)&&Number.isNaN(b))||a===b)){eq=false;break;}}
let azeq = full.az.length===fast.az.length; if(azeq) for(let i=0;i<full.az.length;i++) if(full.az[i]!==fast.az[i]){azeq=false;break;}
console.log('ref arrays identical:', eq, '| az identical:', azeq);
