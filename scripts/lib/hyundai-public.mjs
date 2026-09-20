import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {parseHyundaiDetail} from '../collect-issuer-rendered.mjs';
import {decodeEntities} from '../collect-issuer-feed.mjs';
const ORIGIN='https://www.hyundaicard.com';
const hash=s=>createHash('sha256').update(s).digest('hex');
const norm=s=>String(s??'').normalize('NFKC').replace(/\s+/g,'').toLowerCase();
const kst=s=>new Date(Date.parse(s)+32400000).toISOString().slice(0,10);
async function get(url,{cacheDir,fetchImpl}) {
 const file=cacheDir&&path.join(cacheDir,`hyundai-public-${hash(url)}.json`);
 if(file)try{const c=JSON.parse(await readFile(file,'utf8'));const age=Date.now()-Date.parse(c.retrievedAt);if(c.url===url&&c.version===1&&age>=0&&age<86400000&&c.sha256===hash(c.html))return {...c,cacheHit:true};}catch{}
 const r=await fetchImpl(url,{redirect:'error',signal:AbortSignal.timeout(30000),headers:{Accept:'text/html'}});
 if(!r.ok)throw new Error(`hyundai_http_${r.status}`);
 const bytes=new Uint8Array(await r.arrayBuffer());if(bytes.length>4000000)throw new Error('hyundai_response_too_large');
 const html=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
 const c={version:1,url,html,retrievedAt:new Date().toISOString(),sha256:hash(html),bytes:Buffer.byteLength(html),transport:'direct_official_http'};
 if(file){await mkdir(cacheDir,{recursive:true});await writeFile(file,JSON.stringify(c));}return {...c,cacheHit:false};
}
/** Fetch official shell and only its explicitly linked product HTML fragment. */
export async function fetchHyundaiPublic(job,{cacheDir,fetchImpl=fetch}={}) {
 const url=new URL(job.product_url??job.productUrl??job.url);
 if(url.origin!==ORIGIN||url.username||url.password||url.pathname!=='/cpc/cr/CPCCR0201_01.hc')throw new Error('hyundai_invalid_source');
 const code=url.searchParams.get('cardWcd');if(!/^[A-Za-z0-9_]+$/.test(code??''))throw new Error('hyundai_invalid_product_id');
 const shell=await get(url.href,{cacheDir,fetchImpl});
 const meta=/<meta\b[^>]*name=["']title["'][^>]*content=["']([^"']+)["'][^>]*>/i.exec(shell.html)?.[1];
 const name=decodeEntities(meta??'').replace(/\s*-\s*카드\s*-\s*현대카드\s*$/,'').trim();
 if(!name||job.name&&norm(name)!==norm(job.name))throw new Error('hyundai_name_mismatch');
 const refs=[...shell.html.matchAll(/\$\(["']#cms_area["']\)\.load\(["']([^"']+)["']/g)].map(m=>m[1]);
 if(refs.length!==1)throw new Error('hyundai_fragment_missing');
 const fragmentUrl=new URL(refs[0],ORIGIN);
 if(fragmentUrl.origin!==ORIGIN||fragmentUrl.pathname!==`/docfiles/resources/pc/html/carDtl/${code}_PC.html`||fragmentUrl.search||fragmentUrl.hash)throw new Error('hyundai_fragment_identity_mismatch');
 const fragment=await get(fragmentUrl.href,{cacheDir,fetchImpl});
 const type=/체크/.test(name)?'check':'credit';
 if(job.card_type&&job.card_type!==type)throw new Error('hyundai_type_mismatch');
 // Product-specific official meta title supplies the absent raw-shell title.
 const derived=`<title>${name.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}-현대카드</title>\n${shell.html}\n${fragment.html}`;
 const retrievedAt=[shell.retrievedAt,fragment.retrievedAt].sort()[0];
 const result=parseHyundaiDetail(derived,{pageUrl:url.href,retrievedAt:kst(retrievedAt),cardType:type});
 if(!result.card)throw new Error('hyundai_no_product_benefits');
 result.card.source.note='현대카드 공식 상품 페이지와 해당 페이지에 명시된 공식 혜택 HTML 조각을 직접 수집하여 보완. 상품명은 공식 메타 정보로 확인. 상세 조건은 원문 확인 필요.';
 const evidence=c=>({url:c.url,retrievedAt:c.retrievedAt,sha256:c.sha256,bytes:c.bytes,transport:c.transport,cacheHit:c.cacheHit});
 return {...result,responseEvidence:{url:url.href,fetched_at:retrievedAt,retrievedAt,transport:'direct_official_http',sources:[evidence(shell),evidence(fragment)],derived:{operation:'official_meta_title_plus_shell_and_linked_fragment',sha256:hash(derived)},sha256:shell.sha256,bytes:shell.bytes,hash_scope:'shell',cache_hit:shell.cacheHit&&fragment.cacheHit,http_status:200,card_type_basis:type==='check'?'official_product_name':'legacy_credit_default'}};
}
