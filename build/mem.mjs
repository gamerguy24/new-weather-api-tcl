import { bunzip } from '../site/vendor/bz2.js';
import { decodeLevel2 } from '../site/js/decoder.js';
import { render } from '../site/js/render.js';
const BASE='https://unidata-nexrad-level2.s3.amazonaws.com';
const pad=n=>String(n).padStart(2,'0');
const now=new Date(); let key=null;
for(let b=0;b<2&&!key;b++){const d=new Date(now-b*864e5);const day=`${d.getUTCFullYear()}/${pad(d.getUTCMonth()+1)}/${pad(d.getUTCDate())}/`;const xml=await(await fetch(`${BASE}/?list-type=2&prefix=${day}KTLX/`)).text();const ks=[...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map(m=>m[1]).filter(k=>!k.endsWith('_MDM'));if(ks.length)key=ks.sort().pop();}
const ab=await(await fetch(`${BASE}/${key}`)).arrayBuffer();
const rss0=process.memoryUsage().rss;
const t0=Date.now();
const dec=decodeLevel2(ab, bunzip, {firstSweepOnly:true});
const img=render(dec,{size:1200});
const t1=Date.now();
const mu=process.memoryUsage();
let mn=1/0,mx=-1/0,n=0;for(const v of dec.ref){if(Number.isFinite(v)){if(v<mn)mn=v;if(v>mx)mx=v;n++;}}
console.log(`decode+render ${t1-t0}ms  radials=${dec.nRadials} min/max=${mn}/${mx} valid=${n}`);
console.log(`rss=${(mu.rss/1048576).toFixed(0)}MB heapUsed=${(mu.heapUsed/1048576).toFixed(0)}MB external=${(mu.external/1048576).toFixed(0)}MB`);
console.log(`rss delta since before decode: ${((mu.rss-rss0)/1048576).toFixed(0)}MB`);
