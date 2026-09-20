/**
 * Offline parsers for additional issuers' public product HTML.
 * Never fetches, evaluates page JavaScript, or fills unknown tax/cap/spend values.
 * Selectors were checked against public HTML retrieved on 2026-09-21.
 */
import { stripTags, decodeEntities, parseKrw, inferCategory, makeSlug } from './collect-issuer-feed.mjs';

const HOSTS = {
  kb: ['card.kbcard.com'], hana: ['www.hanacard.co.kr'],
  lotte: ['www.lottecard.co.kr'], nh: ['card.nonghyup.com'],
  bc: ['www.bccard.com'], samsung: ['www.samsungcard.com'],
};
const clean = (html) => String(html).replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
const text = (html) => stripTags(html ?? '');
function attr(tag, name) {
  return decodeEntities(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)?.slice(1).find((v) => v !== undefined) ?? '');
}

// Balance same-name tags so nested divs cannot leak adjacent products/fees.
function elements(html, tag, cls = null, id = null) {
  const re = new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi');
  const result = [];
  let m;
  while ((m = re.exec(html))) {
    if (m[0].startsWith('</')) continue;
    if (cls && !attr(m[0], 'class').split(/\s+/).includes(cls)) continue;
    if (id && attr(m[0], 'id') !== id) continue;
    const begin = re.lastIndex;
    let depth = 1, end;
    while ((end = re.exec(html))) {
      depth += end[0].startsWith('</') ? -1 : 1;
      if (!depth) { result.push(html.slice(begin, end.index)); break; }
    }
  }
  return result;
}
const first = (html, tag, cls, id) => elements(html, tag, cls, id)[0] ?? '';
const field = (html, tag, cls, id) => text(first(html, tag, cls, id));
function inputValue(html, namePattern) {
  for (const m of html.matchAll(/<input\b[^>]*>/gi)) {
    if (namePattern.test(attr(m[0], 'name')) || namePattern.test(attr(m[0], 'id'))) return attr(m[0], 'value');
  }
  return '';
}
function benefit(title, summary = '') {
  title = text(title); summary = text(summary);
  if (!title) return null;
  const b = {
    category: inferCategory(`${title} ${summary}`.replace(/멤버스/g, '멤버십')),
    title: title.slice(0, 200),
    notes: ['소개 요약만 수집. 가맹점·횟수·월 한도·전월실적과 제외 조건은 미확인.'],
  };
  if (summary) b.summary = summary.slice(0, 600);
  // Different percentages in one block usually describe different services.
  // Keep their words without pretending that the highest rate applies to all.
  const rates = [...new Set([...`${title} ${summary}`.matchAll(/(\d+(?:\.\d+)?)\s*%/g)].map((m) => Number(m[1])))];
  if (rates.length === 1 && rates[0] <= 100 && !/[~～–]\s*\d+(?:\.\d+)?\s*%/.test(`${title} ${summary}`)) b.rate_pct = rates[0];
  return b;
}
function amount(s) { return parseKrw(text(s)); }
function numericWon(s) {
  return [...text(s).matchAll(/(?:\d{1,3}(?:,\d{3})+|\d+)\s*원/g)].map((m) => amount(m[0])).filter(Number.isFinite);
}

function parseKb(html) {
  const title = first(html, 'div', 'cardTit');
  const region = first(html, 'div', 'benefitList1');
  const fees = first(html, 'div', 'cardAnnualFee');
  const domestic = elements(fees, 'li').find((s) => /alt=["']국내전용["']/.test(s));
  const sums = domestic ? numericWon(domestic) : [];
  const kind = field(html, 'ul', 'cardKind');
  return {
    name: field(title, 'h1', 'tit'), tagline: field(title, 'p', 'txt'),
    cardType: /체크/.test(kind) ? 'check' : /신용/.test(kind) ? 'credit' : null,
    benefits: elements(region, 'li').map((s) => benefit(`${field(s, 'strong', 'tit')} ${field(s, 'span', 'txt')}`)),
    annualFee: sums.length ? Math.min(...sums) : null,
    annualFeeNote: domestic ? `국내전용 ${text(domestic)}` : '',
  };
}
function parseHana(html, raw) {
  const title = first(html, 'div', 'card_title');
  const region = first(html, 'ul', 'card_info_list');
  const fees = first(html, 'dd', 's1');
  const domestic = elements(fees, 'li').filter((s) => /국내전용/.test(text(s)) && !/국내전용\s*가족/.test(text(s)));
  const candidates = domestic.map((s) => /국내전용(?:,\s*국내외겸용)?\s*(?:본인\s*)?((?:\d{1,3}(?:,\d{3})+|\d+)\s*원)/.exec(text(s))?.[1]).filter(Boolean).map(amount).filter(Number.isFinite);
  const variableFee = /맞춤혜택조합|선택\s*시\s*추가/.test(text(fees));
  const kind = /cardVirtualObj\.dimension29\s*=\s*['"]([^'"]+)/.exec(raw)?.[1];
  return {
    name: field(title, 'h3', 'tit'), tagline: field(title, 'p', 'txt'),
    cardType: kind === '신용카드' ? 'credit' : kind === '체크카드' ? 'check' : null,
    benefits: elements(region, 'li').map((s) => benefit(field(s, 'div', 'tit'), field(s, 'div', 'txt'))),
    annualFee: !variableFee && candidates.length ? Math.min(...candidates) : null,
    annualFeeNote: text(fees),
  };
}
function parseNh(html) {
  const name = inputValue(html, /^card_2_\d+$/);
  const region = first(html, 'ul', 'mf_card_ht_list');
  const table = first(first(html, 'div', 'cardview_table'), 'table');
  const domestic = elements(table, 'tr').find((s) => /alt=["']국내전용["']/.test(s));
  const cells = domestic ? elements(domestic, 'td') : [];
  const eligibilityRow = elements(html, 'tr').find((s) => /^발급대상$/.test(field(s, 'th')));
  const eligibility = eligibilityRow ? field(eligibilityRow, 'td') : '';
  // The first domestic fee table in 카드사용안내 belongs to the primary holder;
  // later tables can contain family fees, so do not minimize across all tables.
  const usage = first(html, 'div', null, 'tabInfoCont7');
  const detailedDomestic = elements(usage, 'table').find((s) => /^국내전용 연회비/.test(field(s, 'caption')));
  const totalRow = detailedDomestic && elements(detailedDomestic, 'tr').find((s) => /^총\s*연회비/.test(text(s)));
  const totals = totalRow ? numericWon(totalRow) : [];
  const detailedNote = totalRow ? `국내 본인: ${field(detailedDomestic, 'thead')} / ${text(totalRow)}` : '';
  return {
    name, cardType: /체크/.test(name) || /체크/.test(eligibility) ? 'check' : /신용/.test(name) || /개인\s*\(신용\)/.test(eligibility) ? 'credit' : null,
    benefits: elements(region, 'li').map((s) => benefit(field(s, 'div', 'cate'), field(s, 'div', 'txt'))),
    annualFee: totals.length ? Math.min(...totals) : cells.length === 5 ? amount(cells[4]) : null,
    annualFeeNote: detailedNote || (cells.length === 5 ? `국내전용 일반카드 총연회비 ${text(cells[4])}` : ''),
  };
}
function parseLotte(html) {
  const top = first(html, 'div', 'cardDtlTop');
  const kind = inputValue(html, /^crdOfrFc$/);
  const fee = field(top, 'div', 'annualFee');
  const sums = numericWon(fee);
  return {
    name: field(html, 'h1', 'titDep1'), tagline: field(top, 'p', 'pageGuide'),
    cardType: kind === '01' ? 'credit' : kind === '02' ? 'check' : null,
    benefits: elements(first(top, 'div', 'cdInfo'), 'dl').map((s) => benefit(`${field(s, 'dd')} ${field(s, 'dt')}`)),
    annualFee: sums.length === 1 ? sums[0] : null, annualFeeNote: fee,
    discontinued: /신규[\s\S]{0,30}발급이\s*중단|신규[\s\S]{0,30}발급\s*중단/.test(text(top)),
  };
}
function parseBc(html) {
  const region = first(html, 'div', 'onlineCardItem');
  const fees = first(html, 'div', 'annualFeeBox');
  const domestic = elements(fees, 'div', 'annual').find((s) => /국내전용/.test(field(s, 'div', 'type')));
  return {
    name: field(html, 'h2', 'card_title'),
    cardType: /<h2[^>]*>\s*<img[^>]*alt=["']신용카드["']/.test(html) ? 'credit' : null,
    benefits: elements(region, 'div', 'item').map((s) => {
      const title = first(s, 'div', 'tit');
      const main = field(title, 'div', 'main');
      return main ? benefit(`${field(title, 'p', 'sub')} ${main}`) : null;
    }),
    annualFee: domestic ? amount(first(domestic, 'div', 'fee')) : null,
    annualFeeNote: domestic ? `국내전용 ${field(domestic, 'div', 'fee')}` : '',
  };
}
// Resolve a scalar from Nuxt's compact positional payload without executing it.
function nuxtScalar(raw, key) {
  const expression = /<script>window\.__NUXT__=([\s\S]*?)<\/script>/.exec(raw)?.[1];
  if (!expression) return null;
  const params = /^\(function\(([^)]*)\)/.exec(expression)?.[1].split(',');
  const call = expression.lastIndexOf('}(');
  if (!params || call < 0) return null;
  const argumentsText = expression.slice(call + 2).replace(/\)\);?\s*$/, '');
  const tokens = []; let start = 0, depth = 0, quoted = false, escaped = false;
  for (let i = 0; i < argumentsText.length; i++) {
    const ch = argumentsText[i];
    if (quoted) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') quoted = false; continue; }
    if (ch === '"') quoted = true;
    else if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (ch === ',' && depth === 0) { tokens.push(argumentsText.slice(start, i).trim()); start = i + 1; }
  }
  tokens.push(argumentsText.slice(start).trim());
  const value = new RegExp(`\\b${key}:([^,}]+)`).exec(expression)?.[1];
  const token = params.includes(value) ? tokens[params.indexOf(value)] : value;
  try { return JSON.parse(token); } catch { return null; }
}
function parseSamsung(html, raw) {
  // Only the primary product's introduction: recommendations below it are excluded.
  const name = field(first(html, 'div', 'card-tx'), 'p', 'tt');
  const region = first(html, 'div', 'benefit-box-wrap');
  const fee = field(first(html, 'div', 'card-txt-wrap'), 'div', 'text0');
  const domestic = /\[국내\]\s*본인\s*((?:\d{1,3}(?:,\d{3})+|\d+)\s*원)/.exec(fee);
  return {
    name, cardType: nuxtScalar(raw, 'chkcdYn') === 'Y' ? 'check' : nuxtScalar(raw, 'chkcdYn') === 'N' ? 'credit' : /체크/.test(name) ? 'check' : null,
    benefits: elements(region, 'button', 'benefit-content').filter((s) => !/카드이용TIP|카드 디자인 소개/.test(text(s))).map((s) => benefit(s)),
    annualFee: domestic ? amount(domestic[1]) : null, annualFeeNote: fee,
  };
}

/** @returns {{card: object|null, warnings: string[]}} */
export function parseExtraDetail(raw, { issuerKey, pageUrl, retrievedAt, expectedName, cardType } = {}) {
  const warnings = [];
  let url;
  try { url = new URL(pageUrl); } catch { return { card: null, warnings: ['공식 상품 URL 없음'] }; }
  if (url.protocol !== 'https:' || !HOSTS[issuerKey]?.includes(url.hostname)) return { card: null, warnings: ['등록된 공식 카드사 도메인이 아님'] };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(retrievedAt ?? '')) return { card: null, warnings: ['조회일 형식 오류'] };
  const html = clean(raw);
  const parse = { kb: parseKb, hana: parseHana, nh: parseNh, lotte: parseLotte, bc: parseBc, samsung: parseSamsung }[issuerKey];
  const result = parse(html, String(raw));
  const name = result.name?.trim();
  if (!name) return { card: null, warnings: ['상품명 확인 불가; 오류/목록/미렌더링 페이지를 수록하지 않음'] };
  const normalize = (s) => String(s).replace(/^\[BC바로\]\s*/, '').replace(/\s+/g, '').toLowerCase();
  if (expectedName && normalize(expectedName) !== normalize(name)) return { card: null, warnings: [`상품명 불일치: ${name}`] };
  if (result.discontinued) return { card: null, warnings: ['공식 본문에 신규 발급 중단 명시'] };
  const type = result.cardType ?? cardType;
  if (!['credit', 'check'].includes(type)) return { card: null, warnings: ['신용/체크 구분 미확인; 기본값으로 신용을 지정하지 않음'] };
  if (result.cardType && cardType && result.cardType !== cardType) return { card: null, warnings: ['카탈로그와 상세 카드 유형 불일치'] };
  const benefits = result.benefits.filter(Boolean);
  if (!benefits.length) return { card: null, warnings: ['상품별 혜택 본문 확인 불가'] };
  const card = {
    id: `${issuerKey}-${makeSlug(name.replace(/\+/g, ' plus '), pageUrl)}`, issuer: issuerKey, name,
    product_url: pageUrl, card_type: type, benefits,
    confidence: 'low', review_status: 'machine_extracted', updated_at: retrievedAt,
    source: { kind: 'issuer_official_page', url: pageUrl, retrieved_at: retrievedAt,
      note: '공식 상품 HTML에서 소개 혜택을 추출. 세금·실적·통합/월 한도는 미확인 상태로 생략. 상세 약관 확인 필요.' },
  };
  if (result.tagline) card.tagline = result.tagline.slice(0, 400);
  if (Number.isInteger(result.annualFee) && result.annualFee >= 0) card.annual_fee_krw = result.annualFee;
  else warnings.push('국내 본인 총연회비를 단일 값으로 확인하지 못해 생략');
  if (result.annualFeeNote) card.annual_fee_note = result.annualFeeNote.slice(0, 300);
  warnings.push('혜택 요약만 구조화; 세금 취급·실적 기준·월 한도는 자동 추정하지 않음');
  return { card, warnings };
}
