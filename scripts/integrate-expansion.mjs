#!/usr/bin/env node
import{readFile,writeFile,copyFile,mkdir}from'node:fs/promises';import{createHash}from'node:crypto';import path from'node:path';import{fileURLToPath}from'node:url';
import{assessCandidate}from'./collect-official-bd.mjs';import{validateAgainstSchema,checkSourcePolicy}from'./validate.mjs';import{mergeCatalog}from'../site/catalog.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),dir=path.resolve(process.argv[2]||path.join(root,'../expansion'));
const read=async p=>JSON.parse(await readFile(p,'utf8'));
const optional=async p=>read(p).catch(e=>{if(e.code==='ENOENT')return null;throw e});
const baseFile=path.join(dir,'base-cards.json');await mkdir(dir,{recursive:true});try{await copyFile(path.join(root,'data/cards.json'),baseFile,1)}catch(e){if(e.code!=='EEXIST')throw e}
const base=await read(baseFile),issuers=await read(path.join(root,'data/issuers.json')),schema=await read(path.join(root,'data/cards.schema.json'));
const extra=await optional(path.join(dir,'nh-banks-issuers.json'));
for(const i of (Array.isArray(extra)?extra:extra?.issuers)||[]){const old=issuers.issuers.find(x=>x.key===i.key);if(old)old.allowed_domains=[...new Set([...old.allowed_domains,...i.allowed_domains])];else issuers.issuers.push(i)}
const canonical=u=>{const x=new URL(u);x.hash='';x.searchParams.sort();return x.href};
const cards=new Map(base.cards.map(c=>[c.id,c])),byUrl=new Map(base.cards.map(c=>[canonical(c.product_url),c]));const added=[],updated=[],retained=[],rejected=[],idMap={};
for(const name of ['other-issuers','samsung-shinhan','nh-banks']){
 const list=await optional(path.join(dir,name+'-cards.json'));if(!list)continue;
 for(const input of list){let c=structuredClone(input);c.id=c.id.replace(/_/g,'-');const prev=byUrl.get(canonical(c.product_url));const errors=assessCandidate(c,prev,schema,issuers);if(errors.length){if(prev){retained.push({id:prev.id,incoming_id:c.id,reasons:errors});idMap[input.id]=prev.id}else rejected.push({id:c.id,reasons:errors});continue}
 if(prev){c.id=prev.id;cards.set(c.id,c);updated.push(c.id)}else{if(cards.has(c.id))c.id+='-'+createHash('sha256').update(c.product_url).digest('hex').slice(0,8);cards.set(c.id,c);added.push(c.id)}byUrl.set(canonical(c.product_url),c);idMap[input.id]=c.id;
 }
}
const doc={...base,generated_at:new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul'}).format(new Date()),cards:[...cards.values()].sort((a,b)=>a.id.localeCompare(b.id))};
const errors=[...validateAgainstSchema(doc,schema),...checkSourcePolicy(doc.cards,issuers)];if(errors.length)throw Error(JSON.stringify(errors));
const archive=await read(path.join(root,'data/archive-catalog.json'));const combined=mergeCatalog(doc.cards,archive.cards);
const report={checked_at:doc.generated_at,baseline_official:base.cards.length,official_total:doc.cards.length,added_official:added.length,updated_official:updated.length,retained_official:retained.length,rejected_new:rejected.length,archive_total:archive.cards.length,archive_matched:combined.matched.length,archive_unmatched:combined.archive_unmatched,display_total:combined.cards.length,added_ids:added,updated_ids:updated,retained,rejected,matches:combined.matched,id_map:idMap,official_by_issuer:Object.fromEntries(issuers.issuers.map(i=>[i.key,doc.cards.filter(c=>c.issuer===i.key).length]))};
await writeFile(path.join(root,'data/cards.json'),JSON.stringify(doc,null,2)+'\n');await writeFile(path.join(root,'data/issuers.json'),JSON.stringify(issuers,null,2)+'\n');await writeFile(path.join(root,'data/catalog-expansion-report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({...report,added_ids:undefined,updated_ids:undefined,retained:undefined,rejected:undefined,matches:undefined,id_map:undefined}));
