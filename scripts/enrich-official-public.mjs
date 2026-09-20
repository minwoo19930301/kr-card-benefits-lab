#!/usr/bin/env node
import {readFile,writeFile,readdir,rename} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {fetchWooriPublic,correctVerifiedWooriLegacy} from './lib/woori-public.mjs';
import {fetchHyundaiPublic} from './lib/hyundai-public.mjs';
import {enrichShinhanFee} from './lib/shinhan-fee.mjs';
import {parseShinhanDetail} from './collect-issuer-rendered.mjs';
import {assessCandidate} from './collect-official-bd.mjs';
import {validateAgainstSchema,checkSourcePolicy} from './validate.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const cacheDir=path.resolve(root,'../bd-card-cache');
const read=async n=>JSON.parse(await readFile(path.join(root,'data',n),'utf8'));
const [corpus,report,evidence,schema,issuers]=await Promise.all(['cards.json','collection-report.json','collection-evidence.json','cards.schema.json','issuers.json'].map(read));
const cards=new Map(corpus.cards.map(c=>[c.id,c]));
// Optional staged direct collection fills only primary collection failures.
if(process.argv[2]){
 const stage=path.resolve(process.argv[2]);
 const [fallback,fallbackEvidence,fallbackReport]=await Promise.all(['cards.json','collection-evidence.json','collection-report.json'].map(async n=>JSON.parse(await readFile(path.join(stage,n),'utf8'))));
 if(fallbackReport.transport!=='direct_official_http'||fallbackReport.run_id!==fallbackEvidence.run_id||fallbackReport.corpus_sha256!==createHash('sha256').update(JSON.stringify(fallback)).digest('hex'))throw new Error('Invalid fallback provenance');
 const byId=new Map(fallback.cards.map(c=>[c.id,c]));
 for(const record of evidence.records.filter(r=>r.status!=='accepted')){
  const hit=fallbackEvidence.records.find(r=>r.issuer===record.issuer&&r.url===record.url);
  if(!hit)continue;
  if(hit.status==='accepted'){
   const candidate=byId.get(hit.card_id),previous=cards.get(record.existingId);
   if(assessCandidate(candidate,previous,schema,issuers).length)continue;
   if(!previous&&cards.has(candidate.id)&&cards.get(candidate.id).source.url!==candidate.source.url)continue;
   cards.set(candidate.id,candidate);
  }
  record.primary_attempt??={url:record.url,status:record.status,reason:record.reason,fetched_at:record.fetched_at,sha256:record.sha256,transport:record.transport??report.transport};
  Object.assign(record,hit);if(hit.status==='accepted')delete record.reason;
 }
 report.fallback_run_id=fallbackReport.run_id;report.fallback_request_count=fallbackReport.request_count;
}

const htmlByHash=new Map();
for(const name of await readdir(cacheDir)) if(name.endsWith('.json')) {
  try { const m=JSON.parse(await readFile(path.join(cacheDir,name),'utf8')); if(['brightdata_web_unlocker','direct_official_http'].includes(m.transport)&&m.sha256) htmlByHash.set(m.sha256,path.join(cacheDir,name.replace(/\.json$/,'.html'))); } catch {}
}
let requests=0,updated=0,cursor=0;
const fetchImpl=(...args)=>{if(requests>=400)throw new Error('supplement_budget_exhausted');requests++;return fetch(...args);};
const jobs=evidence.records.filter(r=>['woori','shinhan','hyundai'].includes(r.issuer)&&r.existingId);
async function worker(){while(cursor<jobs.length){const record=jobs[cursor++],previous=cards.get(record.existingId);if(!previous||record.issuer==='hyundai'&&record.status==='accepted')continue;
 try {
  let candidate,supplement,comparison=previous,corrections=[];
  if(record.issuer==='woori'){
   const result=await fetchWooriPublic({...record,product_url:previous.product_url},{cacheDir,fetchImpl});
   candidate=result.card;supplement=result.responseEvidence;
   if(candidate.product_url!==previous.product_url)throw new Error('alternate_product_identity_mismatch');
   const cached=JSON.parse(await readFile(path.join(cacheDir,`woori-public-${supplement.request_product_id}.json`),'utf8'));
   if(createHash('sha256').update(JSON.stringify(cached.resultVo)).digest('hex')!==supplement.sha256)throw new Error('cache_hash_mismatch');
   ({comparison,corrections}=correctVerifiedWooriLegacy(previous,candidate,cached.resultVo));
  }else if(record.issuer==='hyundai'){
   const result=await fetchHyundaiPublic({...record,product_url:previous.product_url},{cacheDir,fetchImpl});
   candidate=result.card;supplement=result.responseEvidence;
  }else{
   if(!record.sha256||!htmlByHash.has(record.sha256))continue;
   const html=await readFile(htmlByHash.get(record.sha256),'utf8');
   if(createHash('sha256').update(html).digest('hex')!==record.sha256)throw new Error('cache_hash_mismatch');
   const parsed=parseShinhanDetail(html,{pageUrl:record.url,retrievedAt:new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul'}).format(new Date(record.fetched_at)),cardType:previous.card_type});
   if(!parsed.card)continue;
   const result=await enrichShinhanFee(parsed.card,html,{cacheDir,fetchImpl});
   record.supplemental_evidence=result.evidence??{reason:result.reason};
   if(!result.enriched)continue;
   candidate=result.card;supplement=result.evidence;
  }
  const errors=assessCandidate(candidate,comparison,schema,issuers);
  if(errors.length){record.supplemental_evidence={...supplement,validation_errors:errors};console.log(`${record.issuer} retained ${previous.name}: ${errors.join(';')}`);continue;}
  candidate.id=previous.id;
  if(['woori','hyundai'].includes(record.issuer)){
   record.primary_attempt??={url:record.url,status:record.status,reason:record.reason,fetched_at:record.fetched_at,sha256:record.sha256,transport:record.transport};
   Object.assign(record,{url:candidate.source.url,fetched_at:supplement.fetched_at,sha256:supplement.sha256,bytes:supplement.bytes,cache_hit:supplement.cache_hit,http_status:200,transport:supplement.transport});
  }else candidate.source.note=`신한카드 공식 페이지를 ${record.transport==='brightdata_web_unlocker'?'Bright Data':'직접 HTTP'}로 수집하고 공식 공개 상품 API로 본인 연회비를 보완. 상세 조건은 원문 확인 필요.`;
  record.supplemental_evidence=supplement;if(corrections.length)record.verified_corrections=corrections;record.status='accepted';record.card_id=candidate.id;delete record.reason;cards.set(candidate.id,candidate);updated++;
  console.log(`${record.issuer} enriched ${candidate.name}`);
 }catch(error){record.supplemental_evidence={reason:/^woori_|^alternate_|^cache_|^supplement_/.test(error.message)?error.message:'official_api_failed'};console.log(`${record.issuer} retained ${previous.name}: supplement failed`);}
}}
await Promise.all(Array.from({length:5},worker));
corpus.cards=[...cards.values()].sort((a,b)=>a.id.localeCompare(b.id));
const errors=[...validateAgainstSchema(corpus,schema),...checkSourcePolicy(corpus.cards,issuers)];if(errors.length)throw new Error(errors.slice(0,5).join(';'));
report.enriched_at=new Date().toISOString();report.supplemental_request_count=requests;report.supplemental_updated_cards=updated;
report.transports=[...new Set(evidence.records.filter(r=>r.status==='accepted').flatMap(r=>[r.transport,r.supplemental_evidence?.transport]).filter(Boolean))];
report.transport_note='Bright Data를 우선 사용하고 실패한 원문은 직접 공식 HTTP 및 우리·신한 공개 API와 현대 공식 상세 HTML로 보완. 직접 수집·API 요청 수는 fallback_request_count와 supplemental_request_count로 별도 기록.';
report.accepted_count=evidence.records.filter(r=>r.status==='accepted').length;
report.corpus_sha256=createHash('sha256').update(JSON.stringify(corpus)).digest('hex');
for(const row of report.issuer_reports){const rs=evidence.records.filter(r=>r.issuer===row.issuer);row.succeeded=rs.filter(r=>r.status==='accepted').length;row.failed=rs.filter(r=>['failed','rejected'].includes(r.status)).length;row.skipped=rs.filter(r=>r.status==='skipped').length;row.attempted=row.succeeded+row.failed;row.updated_cards=row.succeeded;row.retained_cards=corpus.cards.filter(c=>c.issuer===row.issuer&&!rs.some(r=>r.status==='accepted'&&r.card_id===c.id)).length;row.status=row.succeeded?(row.failed||row.skipped?'partial':'collected'):(row.failed?'failed':'not_collected');row.note=`발견된 공식 URL ${rs.length}개 중 검증 통과 ${row.succeeded}개. 공식 API 보완 포함. 전체 발급 상품 완전성은 미보증.`;}
for(const [name,data] of [['cards.json',corpus],['collection-evidence.json',evidence],['collection-report.json',report]]){const dest=path.join(root,'data',name);await writeFile(dest+'.tmp',JSON.stringify(data,null,2)+'\n');await rename(dest+'.tmp',dest);}
console.log(JSON.stringify({requests,updated,total:corpus.cards.length,accepted:report.accepted_count}));
