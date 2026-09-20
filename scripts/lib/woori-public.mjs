import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { decodeEntities, stripTags, parsePercent, parseKrw, makeSlug, inferCategory, extractSpendTiers, detectNoSpendCondition, parseCapTable, parseTierCapRows, matchCapRow } from '../collect-issuer-feed.mjs';

export const WOORI_PUBLIC_ENDPOINT = 'https://pc.wooricard.com/dcpc/yh1/crd/crd01/searchCrdDtl.pwkjson';
const hash = value => createHash('sha256').update(value).digest('hex');
const clean = value => stripTags(decodeEntities(String(value ?? ''))).trim();
const normalize = value => clean(value).normalize('NFKC').replace(/\s+/g, '').toLowerCase();
const dateKst = value => new Date(new Date(value).getTime() + 9 * 3600000).toISOString().slice(0, 10);
function identity(job) {
  const input = job.product_url ?? job.productUrl ?? job.url;
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.hostname !== 'pc.wooricard.com') throw new Error('woori_invalid_source');
  const productId = url.searchParams.get('cdPrdCd') ?? /\/card_(\d+)\.html$/.exec(url.pathname)?.[1];
  if (!/^\d{6}$/.test(productId ?? '')) throw new Error('woori_invalid_product_id');
  return { productId, productUrl: `https://pc.wooricard.com/dcpc/yh1/crd/crd01/H1CRD101S02.do?cdPrdCd=${productId}` };
}

export function parseWooriPublic(resultVo, job, retrievedAt) {
  const { productId, productUrl } = identity(job);
  const meta = resultVo?.crd01DtlVo;
  if (!meta || String(meta.cdPrdCd) !== productId) throw new Error('woori_product_mismatch');
  const name = clean(meta.cdPrdNm);
  if (!name || (job.name && normalize(name) !== normalize(job.name))) throw new Error('woori_name_mismatch');
  const cardType = ({ '1': 'credit', '2': 'check' })[String(meta.cdPrdCfcd)];
  if (!cardType || (job.card_type && cardType !== job.card_type)) throw new Error('woori_type_mismatch');
  const html = decodeEntities(String(resultVo.bdtCntnts ?? ''));
  const pageText = clean(html);
  const sections = [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>([\s\S]*?)(?=<h2\b|$)/gi)].map(m => ({heading:clean(m[1]),text:clean(m[2])}));
  const capTable = parseCapTable(html);
  const tierRows = parseTierCapRows(html);
  const tiers = [...new Set([...extractSpendTiers(pageText), ...capTable.tiers, ...tierRows.map(r => r.tier)])].filter(v => v > 0).sort((a,b) => a-b);
  const benefits = (resultVo.crd01DtlBnfVoList ?? []).map(item => {
    const headline = clean(item.cdPrdBnfTxt);
    const detail = clean(item.cdPrdBnfDtlTxt);
    const numericHeadline = parsePercent(headline) !== null || parseKrw(headline) !== null;
    const title = (numericHeadline && detail ? detail.replace(/\d+(?:\.\d+)?\s*%/g,'').replace(/\s+/g,' ').trim() : headline).slice(0,200);
    const summary = (numericHeadline ? '' : detail).slice(0,600);
    if (!title) return null;
    const benefit = { category: inferCategory(`${title} ${summary}`), title };
    if (summary) benefit.summary = summary;
    // Only a single explicit percentage in the official headline/summary is numeric evidence.
    const rates = [...new Set([...`${headline} ${detail}`.matchAll(/(\d+(?:\.\d+)?)\s*%/g)].map(m => Number(m[1])).filter(n => n > 0 && n <= 100))];
    if (rates.length === 1) benefit.rate_pct = rates[0];
    const section = sections.find(s => normalize(s.heading) === normalize(title)) ?? sections.find(s => normalize(s.heading).includes(normalize(title)) || normalize(title).includes(normalize(s.heading)));
    const localTiers = extractSpendTiers(`${detail} ${section?.text ?? ''}`);
    const eligible = /(?:결제\s*)?건당\s*(?:최대\s*)?할인\s*대상\s*금액\s*([\d,]+\s*만?\s*원)/.exec(section?.text ?? '');
    if (eligible) benefit.per_txn_eligible_spend_cap_krw = parseKrw(eligible[1]);
    const matched = matchCapRow(capTable, title) ?? matchCapRow(capTable, summary);
    if (matched?.tier != null) benefit.requires_prev_month_spend_krw = matched.tier;
    else if (localTiers.length === 1) benefit.requires_prev_month_spend_krw = localTiers[0];
    else if (tiers.length === 1) benefit.requires_prev_month_spend_krw = tiers[0];
    if (matched?.cap != null && (!benefit.requires_prev_month_spend_krw || matched.cap < benefit.requires_prev_month_spend_krw)) benefit.monthly_cap_krw = matched.cap;
    return benefit;
  }).filter(Boolean);
  if (!benefits.length) throw new Error('woori_no_benefits');
  const card = { id: job.existingId ?? `woori-${makeSlug(name, productUrl)}`, issuer:'woori', name, product_url:productUrl, card_type:cardType, benefits, confidence:'medium', review_status:'machine_extracted', updated_at:retrievedAt, source:{kind:'issuer_official_page',url:productUrl,retrieved_at:retrievedAt,note:'우리카드 공식 상품 페이지의 공개 상세조회 API로 보완 수집. 자동 추출값이며 상세 조건은 공식 원문 확인 필요.'} };
  const fees = (resultVo.crd01DtlAmfeeVoList ?? []).map(v => String(v.amfeeAm ?? '')).filter(v => /^\d+$/.test(v)).map(Number);
  if (fees.length) { card.annual_fee_krw = Math.min(...fees); card.annual_fee_note = `공식 연회비 항목 중 최저 ${card.annual_fee_krw.toLocaleString('ko-KR')}원. 브랜드·실물·모바일 구분에 따라 다를 수 있음.`; }
  else if (/연회비/.test(clean(meta.amfeeAdvSbjTxt)) && /없음|면제/.test(clean(meta.amfeeAdvSbjTxt)) && !/\d[\d,]*\s*원/.test(clean(meta.amfeeAdvSbjTxt))) { card.annual_fee_krw=0; card.annual_fee_note=clean(meta.amfeeAdvSbjTxt).slice(0,300); }
  if (tiers.length) card.prev_month_spend_tiers_krw=tiers;
  else if (!benefits.some(b => b.requires_prev_month_spend_krw !== undefined) && detectNoSpendCondition(pageText)) card.no_prev_month_spend_condition=true;
  let integrated = tierRows.find(r => r.tier === tiers[0])?.cap ?? capTable.totalCaps.find(Number.isFinite);
  if (Number.isFinite(integrated) && (tiers[0] == null || integrated < tiers[0])) card.integrated_monthly_cap_krw=integrated;
  return {card,warnings:['공개 API의 명시적 항목만 추출; 미확인 조건은 생략']};
}

export async function fetchWooriPublic(job, {cacheDir, fetchImpl=fetch, cacheMaxAgeMs=86400000}={}) {
  const {productId,productUrl}=identity(job);
  const cacheFile=cacheDir ? path.join(cacheDir,`woori-public-${productId}.json`) : null;
  let record, cacheHit=false;
  if (cacheFile) try {
    const cached=JSON.parse(await readFile(cacheFile,'utf8'));
    const age=Date.now()-Date.parse(cached.retrievedAt);
    if (cached.productId===productId && age>=0 && age<=cacheMaxAgeMs && cached.sha256===hash(JSON.stringify(cached.resultVo))) {record=cached;cacheHit=true;}
  } catch {}
  if (!record) {
    const response=await fetchImpl(WOORI_PUBLIC_ENDPOINT,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8','Proworks-Body':'Y','Proworks-Lang':'ko','User-Agent':'kr-card-benefits-lab/0.1','Referer':productUrl},body:JSON.stringify({crd01DtlVo:{cdPrdCd:productId}}),signal:AbortSignal.timeout(45000)});
    if (!response.ok) throw new Error(`woori_http_${response.status}`);
    const envelope=await response.json();
    if (envelope.elHeader?.resSuc!==true || !envelope.resultVo) throw new Error('woori_api_unsuccessful');
    const resultVo=envelope.resultVo;
    record={productId,retrievedAt:new Date().toISOString(),sha256:hash(JSON.stringify(resultVo)),resultVo};
    // Validate identity before writing; never persist envelope/client IP/session metadata.
    parseWooriPublic(resultVo,job,dateKst(record.retrievedAt));
    if (cacheFile) {await mkdir(cacheDir,{recursive:true});await writeFile(cacheFile,JSON.stringify(record));}
  }
  const parsed=parseWooriPublic(record.resultVo,job,dateKst(record.retrievedAt));
  return {...parsed,responseEvidence:{endpoint:WOORI_PUBLIC_ENDPOINT,request_product_id:productId,url:productUrl,transport:'direct_official_api',retrievedAt:record.retrievedAt,fetched_at:record.retrievedAt,sha256:record.sha256,bytes:Buffer.byteLength(JSON.stringify(record.resultVo)),hash_scope:'resultVo',cacheHit,cache_hit:cacheHit,status:200,http_status:200}};
}

/** Narrow correction for legacy D4 discount-cap/eligible-spend-cap confusion.
 * This never supplies a replacement monetary value and never mutates either input.
 */
export function correctVerifiedWooriLegacy(previous, candidate, resultVo) {
  const comparison=structuredClone(previous);
  const corrections=[];
  const expectedName='D4카드의정석Ⅱ';
  const meta=resultVo?.crd01DtlVo;
  if (previous?.issuer!=='woori' || candidate?.issuer!=='woori'
      || normalize(previous.name)!==normalize(expectedName) || normalize(candidate.name)!==normalize(expectedName)
      || meta?.cdPrdCd!=='103305' || normalize(meta.cdPrdNm)!==normalize(expectedName)
      || new URL(candidate.product_url).searchParams.get('cdPrdCd')!=='103305') return {comparison,corrections};
  for (const [index,benefit] of comparison.benefits.entries()) {
    const oldValue=benefit.per_txn_eligible_spend_cap_krw;
    if (!Number.isFinite(oldValue)) continue;
    const matches=(resultVo.crd01DtlBnfVoList??[]).filter(row=>normalize(row.cdPrdBnfTxt)===normalize(benefit.title));
    const next=candidate.benefits.find(row=>normalize(row.title)===normalize(benefit.title));
    if (matches.length!==1 || !next || next.per_txn_eligible_spend_cap_krw!==undefined) continue;
    const evidence=clean(matches[0].cdPrdBnfDtlTxt);
    if (clean(next.summary)!==evidence || /대상\s*금액|이용\s*금액|결제\s*금액/.test(evidence)) continue;
    // Two exact syntactic forms occurring in this product's official API.
    const amounts=[...evidence.matchAll(/건당\s*(?:최대\s*([\d,]+)원\s*청구할인|할인한도\s*([\d,]+)원)(?=\s|$|[.,·])/g)];
    if (amounts.length!==1 || Number((amounts[0][1]??amounts[0][2]).replace(/,/g,''))!==oldValue) continue;
    delete benefit.per_txn_eligible_spend_cap_krw;
    corrections.push({fieldpath:`benefits[${index}].per_txn_eligible_spend_cap_krw`,old_value:oldValue,reason:'공식 원문은 건당 할인액 한도이며 할인 대상 결제금액 한도가 아님',exact_evidence:evidence});
  }
  return {comparison,corrections};
}
