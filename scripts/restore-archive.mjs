#!/usr/bin/env node
/** Import a user-owned historical snapshot; never treat it as current issuer evidence. */
import {readFile,writeFile,mkdir,readdir,copyFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {stripTags,inferCategory} from './collect-issuer-feed.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const input=path.resolve(process.argv[2]||path.join(root,'../card-kit-recovery/card-data.json'));
const snapshot=JSON.parse(await readFile(input));
const known={'삼성카드':'samsung','신한카드':'shinhan','현대카드':'hyundai','KB국민카드':'kb','롯데카드':'lotte','우리카드':'woori','하나카드':'hana','NH농협카드':'nh','BC 바로카드':'bc','IBK기업은행':'ibk','카카오뱅크':'kakao','케이뱅크':'kbank','토스뱅크':'toss'};
const clean=s=>stripTags(String(s??'').replace(/<\/(p|li|div)>/gi,'\n').replace(/<br\s*\/?\s*>/gi,'\n')).replace(/https?:\/\/\S+/g,'').replace(/card[-_]?gorilla/gi,'이전 자료').trim();
const files=await readdir(path.join(path.dirname(input),'card-images'));
const byId=new Map(files.map(f=>[path.parse(f).name,f]));
const out=path.join(root,'site/images/archive');await mkdir(out,{recursive:true});
const cards=[],issuers=[],images={};
const details=path.join(root,'site/archive-details');await mkdir(details,{recursive:true});
for(const group of snapshot.groups){
 const issuer=known[group.issuer.name]||`archive-issuer-${group.issuer.id}`;
 issuers.push({key:issuer,name:group.issuer.name});
 for(const c of group.cards){
  const id=`archive-${c.idx}`;
  const benefits=(c.top_benefit??[]).map(b=>({category:inferCategory(`${b.title} ${(b.tags??[]).join(' ')}`),title:clean((b.tags??[]).join(' '))||clean(b.title)}));
  const record={id,issuer,issuer_name:group.issuer.name,name:clean(c.name),card_type:c.cate==='CHK'?'check':'credit',benefits,confidence:'low',review_status:'archived_unverified',updated_at:snapshot.checkedAt,source:{kind:'legacy_snapshot',retrieved_at:null,note:`사용자 기존 저장 파일 · 파일 기준일 ${snapshot.checkedAt}. 공식 원문 재확인 전이며 현재 조건/발급 가능 여부를 보증하지 않습니다.`},archive:{legacy_id:c.idx,snapshot_date:snapshot.checkedAt,discontinued_in_snapshot:c.is_discon===true,annual_fee_text:clean(c.annual_fee_detail||c.annual_fee_basic),previous_spend_text:Number.isFinite(c.pre_month_money)?`${c.pre_month_money.toLocaleString('ko-KR')}원`:'미기재',benefits:(c.key_benefit??[]).map(b=>({title:clean(b.comment||b.title),text:clean(b.info)})).filter(b=>b.title||b.text)}};
  await writeFile(path.join(details,id+'.json'),JSON.stringify({id,benefits:record.archive.benefits})+'\n');
  record.archive.detail_src='archive-details/'+id+'.json';
  record.archive.benefit_count=record.archive.benefits.length;
  delete record.archive.benefits;
  cards.push(record);
  const f=byId.get(String(c.idx));if(f){const buf=await readFile(path.join(path.dirname(input),'card-images',f));const hash=createHash('sha256').update(buf).digest('hex');let ext=path.extname(f).toLowerCase();if(ext==='.jpeg')ext='.jpg';if(!['.png','.jpg','.gif','.webp'].includes(ext))throw Error('Unsupported snapshot image '+f);const name=hash.slice(0,20)+ext;await copyFile(path.join(path.dirname(input),'card-images',f),path.join(out,name));images[id]={src:'images/archive/'+name,sha256:hash,bytes:buf.length,provenance:'legacy_snapshot',snapshot_date:snapshot.checkedAt};}
 }
}
if(cards.length!==1563||new Set(cards.map(c=>c.id)).size!==1563)throw Error('Snapshot identity/count mismatch');
await writeFile(path.join(root,'data/archive-catalog.json'),JSON.stringify({snapshot_date:snapshot.checkedAt,source_label:'사용자 기존 저장 파일',issuers,cards,images},null,2)+'\n');
console.log(JSON.stringify({restored:cards.length,images:Object.keys(images).length,issuers:issuers.length}));
