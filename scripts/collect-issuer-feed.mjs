#!/usr/bin/env node
/**
 * 카드사가 스스로 공개한 기계판독 피드에서 카드 데이터를 수집한다.
 *
 * 설계 원칙
 *  1. robots.txt 를 먼저 읽고, 대상 경로가 명시적으로 허용되지 않으면 즉시 중단한다.
 *  2. User-Agent 를 숨기지 않는다. 브라우저를 위장하거나 차단을 우회하지 않는다.
 *  3. 요청 간 간격을 둔다. 스케줄러로 상시 실행하지 않는다.
 *  4. 값이 온전하게 파싱되지 않으면 필드를 비운다. 추측해서 채우지 않는다.
 *
 * 사용법:
 *   node scripts/collect-issuer-feed.mjs --issuer woori
 *   node scripts/collect-issuer-feed.mjs --issuer woori --limit 5 --dry-run
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USER_AGENT =
  'kr-card-benefits-lab/0.1 (card benefit research dataset; +https://github.com/minwoo19930301/kr-card-benefits-lab)';
const DEFAULT_DELAY_MS = 1500;

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const args = { issuer: 'woori', limit: Infinity, delay: DEFAULT_DELAY_MS, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--issuer') args.issuer = argv[++i];
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--delay') args.delay = Number(argv[++i]);
    else if (a === '--dry-run') args.dryRun = true;
    else throw new Error(`알 수 없는 인자: ${a}`);
  }
  return args;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xml;q=0.9,*/*;q=0.8' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

// ---------------------------------------------------------------- robots

/**
 * User-agent: * 그룹의 Allow/Disallow 규칙 중 가장 긴 일치를 적용한다.
 * 동일 길이면 Allow 우선 (RFC 9309).
 */
export function robotsVerdict(robotsTxt, targetPath) {
  const lines = robotsTxt.split(/\r?\n/).map((l) => l.replace(/#.*$/, '').trim());
  let inStar = false;
  let sawAgent = false;
  const rules = [];
  for (const line of lines) {
    const m = /^(user-agent|allow|disallow)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === 'user-agent') {
      if (sawAgent && !inStar) sawAgent = false;
      inStar = value === '*';
      sawAgent = true;
      continue;
    }
    if (!inStar || value === '') continue;
    rules.push({ allow: field === 'allow', pathPrefix: value });
  }
  let best = null;
  for (const r of rules) {
    if (!targetPath.startsWith(r.pathPrefix)) continue;
    if (!best || r.pathPrefix.length > best.pathPrefix.length) best = r;
    else if (r.pathPrefix.length === best.pathPrefix.length && r.allow) best = r;
  }
  if (!best) return { allowed: true, rule: null, reason: '일치하는 규칙 없음 (기본 허용)' };
  return {
    allowed: best.allow,
    rule: `${best.allow ? 'Allow' : 'Disallow'}: ${best.pathPrefix}`,
    reason: best.allow ? '명시적 허용' : '명시적 차단',
  };
}

// ---------------------------------------------------------------- HTML helpers

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·',
};

export function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

export function stripTags(html) {
  return decodeEntities(String(html).replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function matchAll(html, re) {
  return [...html.matchAll(re)];
}

// ---------------------------------------------------------------- value parsing

/**
 * 완전한 원화 금액만 통과시킨다.
 * 소스 피드에 "16,0" 처럼 잘린 값이 존재하므로, 천단위 그룹이 3자리가 아니면 버린다.
 * "50만원 이상" 같은 임계값 표기는 금액이 아니므로 받지 않는다.
 * 임계값을 읽어야 하는 곳에서 '이상' 을 먼저 떼고 호출한다.
 */
export function parseKrw(text) {
  if (typeof text !== 'string') return null;
  const t = text.replace(/\s/g, '');
  const man = /^(\d+(?:\.\d+)?)만원$/.exec(t);
  if (man) return Math.round(Number(man[1]) * 10000);
  const won = /^(\d{1,3}(?:,\d{3})*|\d+)원$/.exec(t);
  if (won) return Number(won[1].replace(/,/g, ''));
  return null;
}

/**
 * parseKrw 가 받지 못하는 한글 단위 조합까지 읽는다. 예: '1만8천원', '8천원'.
 * 신한카드가 연회비를 이 형식으로 표기한다.
 * parseKrw 를 먼저 시도하므로 기존 동작은 그대로다.
 */
export function parseKrwLoose(text) {
  const exact = parseKrw(text);
  if (exact !== null) return exact;
  if (typeof text !== 'string') return null;
  const t = text.replace(/\s/g, '');
  const m = /^(?:(\d+)만)?(?:(\d+)천)?원$/.exec(t);
  if (!m || (!m[1] && !m[2])) return null;
  return Number(m[1] ?? 0) * 10000 + Number(m[2] ?? 0) * 1000;
}

export function parsePercent(text) {
  if (typeof text !== 'string') return null;
  const m = /^(\d{1,2}(?:\.\d)?)%$/.exec(text.trim());
  if (!m) return null;
  const v = Number(m[1]);
  return v >= 0 && v <= 100 ? v : null;
}

/** 연회비 표기에서 최저 금액을 뽑는다. 금액이 없고 '없음'만 있으면 0. */
export function parseAnnualFee(text) {
  if (!text) return null;
  const amounts = [];
  for (const m of String(text).matchAll(/[\d,]+\s*만?\s*원/g)) {
    const v = parseKrw(m[0]);
    if (v !== null) amounts.push(v);
  }
  if (amounts.length) return Math.min(...amounts);
  if (/없음|면제|무료/.test(text)) return 0;
  return null;
}

/** 혜택이 아닌 안내성 섹션 제목. 혜택 목록으로 승격하지 않는다. */
export const NON_BENEFIT_HEADING =
  /유의사항|안내|알림|주의|필수|약관|고지|신청|발급|이용\s*방법|문의|가입|한도$/;

/** 상세 혜택 섹션(제목 + 본문)을 분리한다. */
export function parseSections(html) {
  return matchAll(html, /<div class="acco-item">([\s\S]*?)(?=<div class="acco-item">|<h2|$)/gi)
    .map((m) => {
      const h3 = /<h3[^>]*>([\s\S]*?)<\/h3>/i.exec(m[1]);
      return { heading: h3 ? stripTags(h3[1]) : '', text: stripTags(m[1]) };
    })
    .filter((s) => s.heading);
}

/** 텍스트에 표기된 요율 중 최댓값. 마케팅 표기는 통상 '최대' 기준이므로 상한으로 본다. */
export function extractMaxRatePct(text) {
  const values = [...String(text).matchAll(/(\d{1,2}(?:\.\d)?)\s*%/g)]
    .map((m) => Number(m[1]))
    .filter((v) => v > 0 && v <= 100);
  return values.length ? Math.max(...values) : null;
}

/**
 * '월 1만 M포인트 한도' 처럼 포인트 단위로만 표기된 월 한도를 읽는다.
 * 원화가 아니므로 monthly_cap_krw 에 넣지 않는다. 환산 가정은 계산 레이어에서 명시적으로 다룬다.
 */
export function extractMonthlyCapPoints(text) {
  const m = /월\s*(\d[\d,]*)\s*(만)?\s*(?:M|엠)?\s*(?:포인트|점|마일)/.exec(String(text));
  if (!m) return null;
  const base = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(base) || base <= 0) return null;
  return m[2] ? base * 10000 : base;
}

/** '결제 건당 최대 할인 대상 금액 5만원' 형태의 건당 한도. */
export function extractPerTxnCap(text) {
  const m = /건당[^※]{0,40}?([\d,]+\s*만?\s*원)/.exec(String(text));
  return m ? parseKrw(m[1]) : null;
}

/** 문서 전체에서 언급된 전월 이용실적 구간을 모은다. */
export function extractSpendTiers(text) {
  const found = new Set();
  for (const m of String(text).matchAll(/전월[^※.]{0,40}?([\d,]+\s*만?\s*원)\s*이상/g)) {
    const v = parseKrw(m[1]);
    if (v !== null && v > 0) found.add(v);
  }
  return [...found].sort((a, b) => a - b);
}

export function detectNoSpendCondition(text) {
  return /전월\s*실적\s*(?:조건\s*)?(?:없|무관|미적용|상관\s*없)/.test(String(text));
}

/** 혜택 제목과 상세 섹션 제목을 토큰 겹침으로 대응시킨다. */
export function matchSection(sections, title) {
  const tokens = String(title)
    .split(/[^가-힣a-zA-Z0-9]+/)
    .filter((t) => t.length >= 2);
  if (!tokens.length) return null;
  let best = null;
  for (const s of sections) {
    const hits = tokens.filter((t) => s.heading.includes(t)).length;
    if (hits > 0 && (!best || hits > best.hits)) best = { hits, section: s };
  }
  return best?.section ?? null;
}

const CATEGORY_RULES = [
  ['ott', /넷플릭스|왓챠|웨이브|티빙|디즈니|유튜브|음원|멜론|지니|스트리밍|언택트|구독|ott/i],
  ['transit', /대중교통|지하철|버스|택시|철도|ktx|하이패스|통행료/i],
  ['fuel', /주유|충전|전기차|lpg|가스충전/i],
  ['telecom', /통신|이동통신|휴대폰|skt|\bkt\b|lg u\+|알뜰폰/i],
  ['utility', /공과금|도시가스|전기요금|수도|아파트관리비|관리비|자동납부|렌탈/i],
  ['tax', /국세|지방세|세금|4대보험|국민연금|건강보험료/i],
  ['overseas', /해외|외화|직구|글로벌|해외겸용|해외가맹점/i],
  ['travel', /여행|항공권|호텔|콘도|렌터카|라운지|면세|숙박|패키지/i],
  ['mileage', /마일리지|스카이패스|아시아나|skypass/i],
  ['medical', /병원|의원|약국|의료|임신|출산|치과|건강/i],
  ['education', /학원|교육|학습지|보육|어린이집|유치원|서점|도서/i],
  ['food', /음식점|외식|카페|커피|배달|편의점|베이커리|스타벅스|식음료/i],
  ['shopping', /쇼핑|백화점|마트|온라인쇼핑|이커머스|면세점|생활|할인점|아웃렛/i],
  ['point', /포인트|적립|캐시백|리워드/i],
];

export function inferCategory(text) {
  const s = String(text || '');
  let best = null;
  for (const [order, [cat, re]] of CATEGORY_RULES.entries()) {
    const m = re.exec(s);
    if (!m) continue;
    if (!best || m.index < best.index || (m.index === best.index && order < best.order)) {
      best = { cat, index: m.index, order };
    }
  }
  return best ? best.cat : 'other';
}

// 한글 → 라틴 음차. 사람이 읽을 수 있는 내부 slug 를 만드는 용도이며 언어학적 정확성을 목표로 하지 않는다.
const RR_INITIAL = ['g','kk','n','d','tt','r','m','b','pp','s','ss','','j','jj','ch','k','t','p','h'];
const RR_MEDIAL = ['a','ae','ya','yae','eo','e','yeo','ye','o','wa','wae','oe','yo','u','wo','we','wi','yu','eu','ui','i'];
const RR_FINAL = ['','k','k','k','n','n','n','t','l','k','m','l','l','l','p','l','m','p','p','t','t','ng','t','t','k','t','p','t'];

export function romanizeHangul(text) {
  let out = '';
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    if (code >= 0xac00 && code <= 0xd7a3) {
      const s = code - 0xac00;
      out += RR_INITIAL[Math.floor(s / 588)] + RR_MEDIAL[Math.floor((s % 588) / 28)] + RR_FINAL[s % 28];
    } else {
      out += ch;
    }
  }
  return out;
}

/** 카드명에서 사람이 읽을 수 있는 ASCII slug 를 만든다. 실패 시 공식 URL 기반 결정적 해시. */
export function makeSlug(name, canonicalUrl) {
  const slug = romanizeHangul(String(name))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .filter(Boolean)
    .slice(0, 6)
    .join('-');
  if (slug.length >= 3 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) return slug;
  let h = 2166136261;
  for (const ch of String(canonicalUrl)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return `card-${h.toString(36).padStart(7, '0').slice(0, 7)}`;
}

// ---------------------------------------------------------------- page parsing

export function parseCardPage(html, { issuerKey, pageUrl, retrievedAt }) {
  const warnings = [];

  // 1) schema.org JSON-LD (카드사가 직접 제공하는 구조화 데이터)
  let ld = null;
  for (const m of matchAll(html, /<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(decodeEntities(m[1]));
      if (parsed && /CreditCard|FinancialProduct|Product/i.test(parsed['@type'] ?? '')) ld = parsed;
    } catch {
      warnings.push('JSON-LD 파싱 실패');
    }
  }
  if (!ld?.name) return { card: null, warnings: [...warnings, 'JSON-LD name 없음 — 건너뜀'] };

  const name = stripTags(ld.name);
  const canonicalUrl = typeof ld.url === 'string' && ld.url.startsWith('https://') ? ld.url : pageUrl;

  // 2) label/value 메타 항목
  const meta = new Map();
  for (const m of matchAll(
    html,
    /<div class="label">([\s\S]*?)<\/div>\s*<div class="value">([\s\S]*?)<\/div>/gi,
  )) {
    meta.set(stripTags(m[1]), stripTags(m[2]));
  }

  const typeText = meta.get('카드 종류') ?? '';
  const cardType = /체크/.test(typeText) ? 'check' : /신용/.test(typeText) ? 'credit' : null;
  if (!cardType) warnings.push('카드 종류 확인 불가 — credit 로 가정하지 않고 건너뜀');
  if (!cardType) return { card: null, warnings };

  const annualFee = parseAnnualFee(meta.get('연회비'));
  if (annualFee === null) warnings.push('연회비 파싱 불가 — 필드 생략');

  // 3) 주요혜택 요약 (rate + 라벨). 소스에서 가장 신뢰도 높은 구간.
  const summaryItems = [];
  const summaryBlock = /<ul class="summary-list">([\s\S]*?)<\/ul>/i.exec(html);
  if (summaryBlock) {
    for (const li of matchAll(summaryBlock[1], /<li>([\s\S]*?)<\/li>/gi)) {
      const head = /<strong>([\s\S]*?)<\/strong>/i.exec(li[1]);
      const cond = /<span class="condition">([\s\S]*?)<\/span>/i.exec(li[1]);
      if (!cond) continue;
      const headline = head ? stripTags(head[1]) : '';
      summaryItems.push({ headline, label: stripTags(cond[1]) });
    }
  }

  // 4) 전월실적 구간: 통합 한도 표 헤더와 본문 언급을 합친다.
  const capTable = parseCapTable(html);
  const tierCapRows = parseTierCapRows(html);
  const pageText = stripTags(html);
  const sections = parseSections(html);
  const tierSet = new Set([
    ...capTable.tiers,
    ...tierCapRows.map((r) => r.tier),
    ...extractSpendTiers(pageText),
  ]);
  const tiers = [...tierSet].filter((t) => t > 0).sort((a, b) => a - b);
  if (!tiers.length) warnings.push('전월실적 구간 파싱 불가');

  // 요약 블록이 없는 카드가 있다. 그때는 상세 섹션 제목을 혜택 목록으로 쓴다.
  if (!summaryItems.length) {
    warnings.push('주요혜택 요약 없음 — 상세 섹션 제목으로 대체');
    for (const s of sections) {
      if (NON_BENEFIT_HEADING.test(s.heading)) continue;
      summaryItems.push({ headline: s.heading, label: '' });
    }
  }

  const benefits = summaryItems.map(({ headline, label }) => {
    // 소스 피드는 카드에 따라 <strong> 에 요율("5%")을 넣기도 하고 혜택명을 넣기도 한다.
    // 숫자로 파싱되는 쪽을 수치로, 나머지를 제목으로 쓴다.
    const headlineRate = parsePercent(headline);
    const headlineFlat = headlineRate === null ? parseKrw(headline) : null;
    const isNumericHeadline = headlineRate !== null || headlineFlat !== null;
    const title = isNumericHeadline ? label : headline;
    const detail = isNumericHeadline ? '' : label;

    const section = matchSection(sections, title) ?? matchSection(sections, detail || title);
    const searchText = `${title} ${detail} ${section?.text ?? ''}`;

    const benefit = { category: inferCategory(`${title} ${detail}`), title };

    const rate = headlineRate ?? extractMaxRatePct(`${title} ${detail}`) ?? (section ? extractMaxRatePct(section.text) : null);
    if (rate !== null) benefit.rate_pct = rate;
    if (detail && detail !== title) benefit.summary = detail;

    // 월 한도는 통합 한도 표를 1순위로 신뢰한다. 표에 없으면 채우지 않는다.
    const matched = matchCapRow(capTable, title) ?? matchCapRow(capTable, detail);
    if (headlineFlat !== null) benefit.monthly_cap_krw = headlineFlat;
    if (matched?.cap != null) benefit.monthly_cap_krw = matched.cap;
    if (matched?.tier != null) benefit.requires_prev_month_spend_krw = matched.tier;
    else if (tiers.length === 1) benefit.requires_prev_month_spend_krw = tiers[0];

    const perTxn = extractPerTxnCap(searchText);
    if (perTxn !== null) benefit.per_txn_eligible_spend_cap_krw = perTxn;

    // 월 한도가 필요 전월실적보다 크거나 같으면 파싱 오류로 본다.
    // 국내 카드 상품에서 "50만원 쓰면 월 50만원 할인" 같은 조합은 성립하지 않는다.
    if (
      Number.isFinite(benefit.monthly_cap_krw) &&
      Number.isFinite(benefit.requires_prev_month_spend_krw) &&
      benefit.monthly_cap_krw >= benefit.requires_prev_month_spend_krw
    ) {
      delete benefit.monthly_cap_krw;
    }

    return benefit;
  });

  if (!benefits.length) {
    return { card: null, warnings: [...warnings, '혜택 항목을 하나도 추출하지 못함 — 수록하지 않음'] };
  }

  const lowestTier = tiers.length ? tiers[0] : null;
  // 통합 월 한도: 최저 실적 구간에 해당하는 값. 두 종류의 표 중 읽힌 쪽을 쓴다.
  let integratedCap = tierCapRows.find((r) => r.tier === lowestTier)?.cap ?? null;
  if (integratedCap === null && capTable.totalCaps.length) {
    integratedCap = capTable.totalCaps.find((c) => Number.isFinite(c)) ?? null;
  }
  if (integratedCap !== null && lowestTier !== null && integratedCap >= lowestTier) integratedCap = null;

  const hasCaps = benefits.some((b) => Number.isFinite(b.monthly_cap_krw)) || integratedCap !== null;
  const hasRates = benefits.some((b) => Number.isFinite(b.rate_pct));
  const noSpendCondition = !tiers.length && detectNoSpendCondition(pageText);
  const signals = [annualFee !== null, benefits.length > 0, tiers.length > 0 || noSpendCondition, hasRates, hasCaps];
  const score = signals.filter(Boolean).length;
  const confidence = score >= 5 ? 'high' : score >= 3 ? 'medium' : 'low';

  const card = {
    id: `${issuerKey}-${makeSlug(name, canonicalUrl)}`,
    issuer: issuerKey,
    name,
    product_url: canonicalUrl,
    card_type: cardType,
    benefits,
    confidence,
    review_status: 'machine_extracted',
    updated_at: retrievedAt,
    source: {
      kind: 'issuer_machine_readable_feed',
      url: pageUrl,
      retrieved_at: retrievedAt,
      note: 'robots.txt 에서 명시 허용된 카드사 자체 기계판독 경로',
    },
  };

  const tagline = typeof ld.description === 'string' ? stripTags(ld.description).slice(0, 400) : '';
  if (tagline) card.tagline = tagline;
  if (annualFee !== null) card.annual_fee_krw = annualFee;
  const feeText = meta.get('연회비');
  if (feeText && annualFee !== null && /\d/.test(feeText)) {
    card.annual_fee_note = feeText.slice(0, 300);
  }
  if (tiers.length) card.prev_month_spend_tiers_krw = tiers;
  else if (noSpendCondition) card.no_prev_month_spend_condition = true;
  if (integratedCap !== null) card.integrated_monthly_cap_krw = integratedCap;

  return { card, warnings };
}

/** '30만원 이상 ~ 70만원 미만' 같은 구간 표기에서 하한 금액을 뽑는다. */
export function parseTierThreshold(text) {
  const m = /(\d[\d,]*\s*만?\s*[\d,]*\s*천?\s*원)\s*이상/.exec(String(text));
  return m ? parseKrwLoose(m[1]) : null;
}

/**
 * 행 방향 구간 표를 읽는다. 헤더에 '이용실적' 열과 '한도' 열이 모두 있어야 한다.
 *
 * 이 조건은 리터당 단가 표(헤더: 이용실적 / 주유소)나 포인트 한도 표를 금액 한도로
 * 오독하지 않기 위한 것이다. 여기서 얻는 값은 개별 혜택 한도가 아니라 카드 전체에
 * 걸리는 통합 월 한도다.
 */
export function parseTierCapRows(html) {
  for (const t of matchAll(html, /<table[\s\S]*?<\/table>/gi)) {
    const rows = matchAll(t[0], /<tr[^>]*>([\s\S]*?)<\/tr>/gi).map((r) =>
      matchAll(r[1], /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi).map((c) => stripTags(c[1])),
    );
    if (rows.length < 2) continue;
    const header = rows[0];
    // 카드사별 표기 차이: 우리카드는 '이용실적', 신한카드는 '이용금액'
    // 단, '월 이용금액 한도' 는 할인 금액 상한이 아니라 '할인 대상 이용금액' 상한이다.
    // 이를 할인 한도로 읽으면 요율만큼(최대 20배) 과대추정되므로 양쪽에서 배제한다.
    const isEligibleSpendCap = (c) => /이용금액\s*한도|이용금액한도|제공\s*횟수/.test(c);
    const iTier = header.findIndex((c) => /이용실적|이용금액/.test(c) && !isEligibleSpendCap(c));
    const iCap = header.findIndex((c) => /한도/.test(c) && !isEligibleSpendCap(c));
    if (iTier === -1 || iCap === -1) continue;

    const out = [];
    for (const row of rows.slice(1)) {
      const tier = parseTierThreshold(row[iTier] ?? '');
      const cap = parseKrwLoose(row[iCap] ?? '');
      if (tier === null || cap === null) continue;
      if (cap >= tier) continue; // 실적 금액을 한도로 읽은 경우
      out.push({ tier, cap });
    }
    if (out.length) return out.sort((a, b) => a.tier - b.tier);
  }
  return [];
}

/**
 * '통합 월 할인한도' 형태의 표(헤더에 전월실적 구간이 열로 나열된 표)를 찾는다.
 *
 * 주의: '전월 이용실적' 이 헤더의 한 '열'로 들어간 표도 존재한다. 그런 표는 구간 행렬이
 * 아니므로 한도 표로 쓰면 실적 금액을 한도로 잘못 읽는다. 헤더에서 실제로 구간 금액이
 * 파싱될 때만 한도 표로 인정한다.
 */
export function parseCapTable(html) {
  const empty = { tiers: [], rows: [], totalCaps: [] };
  for (const t of matchAll(html, /<table[\s\S]*?<\/table>/gi)) {
    const table = t[0];
    const rows = matchAll(table, /<tr[^>]*>([\s\S]*?)<\/tr>/gi).map((r) =>
      matchAll(r[1], /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi).map((c) => stripTags(c[1])),
    );
    if (rows.length < 2) continue;
    const header = rows[0];
    if (!header.some((c) => /이용실적|이용금액\s*구간/.test(c))) continue;

    // 헤더에서 '30만원 이상' 같은 구간만 채택한다. 손상된 값은 버린다.
    const tiers = [];
    for (const cell of header.slice(1)) {
      const v = parseKrw(cell.replace(/\s*이상\s*$/, ''));
      if (v !== null && v > 0) tiers.push(v);
    }
    if (!tiers.length) continue; // 구간 행렬이 아니다

    const dataRows = [];
    const totalCaps = [];
    for (const row of rows.slice(1)) {
      if (!row.length) continue;
      const label = row[0];
      const caps = row.slice(1).map((c) => parseKrw(c));
      if (/통합/.test(label)) totalCaps.push(...caps);
      else dataRows.push({ label, caps });
    }
    return { tiers, rows: dataRows, totalCaps };
  }
  return empty;
}

/** 혜택 라벨과 한도 표의 행 라벨을 느슨하게 대응시킨다. 확실하지 않으면 null. */
export function matchCapRow(capTable, benefitLabel) {
  if (!capTable.rows.length) return null;
  const tokens = String(benefitLabel)
    .split(/[^가-힣a-zA-Z]+/)
    .filter((t) => t.length >= 2);
  if (!tokens.length) return null;
  let best = null;
  for (const row of capTable.rows) {
    const hits = tokens.filter((t) => row.label.includes(t)).length;
    if (hits > 0 && (!best || hits > best.hits)) best = { hits, row };
  }
  if (!best) return null;
  const firstTierIdx = best.row.caps.findIndex((c) => c !== null);
  if (firstTierIdx === -1) return null;
  return {
    cap: best.row.caps[firstTierIdx],
    tier: capTable.tiers[firstTierIdx] ?? null,
  };
}

// ---------------------------------------------------------------- main

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const issuersDoc = JSON.parse(await readFile(path.join(ROOT, 'data/issuers.json'), 'utf8'));
  const issuer = issuersDoc.issuers.find((i) => i.key === args.issuer);
  if (!issuer) throw new Error(`issuers.json 에 '${args.issuer}' 없음`);
  const feed = issuer.machine_readable_feed;
  if (!feed) throw new Error(`'${args.issuer}' 는 기계판독 피드가 없다. 수동 PR 로 추가해야 한다.`);

  const sitemapUrl = new URL(feed.sitemap);
  const robotsUrl = new URL('/robots.txt', sitemapUrl.origin).href;

  console.log(`[1/4] robots.txt 확인: ${robotsUrl}`);
  const robots = await fetchText(robotsUrl);
  const verdict = robotsVerdict(robots, feed.path_prefix);
  console.log(`      ${feed.path_prefix} → ${verdict.allowed ? 'ALLOWED' : 'BLOCKED'} (${verdict.rule ?? '규칙 없음'})`);
  if (!verdict.allowed) throw new Error('robots.txt 가 대상 경로를 차단한다. 수집을 중단한다.');
  if (verdict.rule === null) {
    throw new Error('명시적 Allow 규칙이 없다. 이 프로젝트는 명시 허용된 경로만 수집한다.');
  }

  console.log(`[2/4] sitemap 로드: ${feed.sitemap}`);
  const sitemap = await fetchText(feed.sitemap);
  const locs = [...sitemap.matchAll(/<loc>([\s\S]*?)<\/loc>/gi)]
    .map((m) => decodeEntities(m[1].trim()))
    .filter((u) => {
      try {
        return new URL(u).pathname.startsWith(feed.path_prefix);
      } catch {
        return false;
      }
    });
  const targets = locs.slice(0, args.limit === Infinity ? locs.length : args.limit);
  console.log(`      대상 ${targets.length}건 (전체 ${locs.length}건)`);

  const retrievedAt = new Date().toISOString().slice(0, 10);
  const cards = [];
  const skipped = [];
  console.log(`[3/4] 수집 (요청 간격 ${args.delay}ms)`);
  for (const [i, url] of targets.entries()) {
    try {
      const html = await fetchText(url);
      const { card, warnings } = parseCardPage(html, {
        issuerKey: issuer.key,
        pageUrl: url,
        retrievedAt,
      });
      if (card) {
        cards.push(card);
        process.stdout.write(`      ${i + 1}/${targets.length} ok  ${card.name}\n`);
      } else {
        skipped.push({ url, warnings });
        process.stdout.write(`      ${i + 1}/${targets.length} skip ${warnings.join('; ')}\n`);
      }
    } catch (err) {
      skipped.push({ url, warnings: [err.message] });
      process.stdout.write(`      ${i + 1}/${targets.length} err  ${err.message}\n`);
    }
    if (i < targets.length - 1) await sleep(args.delay);
  }

  // id 중복 제거 (동일 카드가 여러 URL 로 노출될 수 있다)
  const byId = new Map();
  for (const c of cards) if (!byId.has(c.id)) byId.set(c.id, c);
  const unique = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));

  const doc = {
    schema_version: 1,
    generated_at: retrievedAt,
    cards: unique,
  };

  console.log(`[4/4] 수집 ${unique.length}건, 건너뜀 ${skipped.length}건`);
  if (args.dryRun) {
    console.log(JSON.stringify(doc.cards.slice(0, 2), null, 2));
    return;
  }
  const out = path.join(ROOT, 'data/cards.json');
  await writeFile(out, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  console.log(`      기록: ${path.relative(ROOT, out)}`);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`실패: ${err.message}`);
    process.exit(1);
  });
}
