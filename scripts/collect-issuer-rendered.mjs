#!/usr/bin/env node
/**
 * 스크립트 렌더링이 필요한 카드사 공식 페이지에서 카드 데이터를 수집한다.
 *
 * 우리카드처럼 기계판독 피드를 제공하는 곳은 collect-issuer-feed.mjs 를 쓴다.
 * 이 스크립트는 공식 페이지가 브라우저에서만 완성되는 카드사를 위한 것이다.
 *
 * 지키는 것
 *  1. robots.txt 를 먼저 읽고 대상 경로가 차단되면 중단한다.
 *  2. 설치된 Chrome 을 헤드리스로 그대로 쓴다. UA 를 위장하지 않는다
 *     (기본 UA 가 HeadlessChrome 으로 스스로를 밝힌다).
 *  3. 스텔스 플러그인, 세션 쿠키 재사용, CAPTCHA 우회를 쓰지 않는다.
 *  4. 로그인 뒤 자원에 접근하지 않는다. 공개 상품 페이지만 본다.
 *  5. 요청 사이에 간격을 둔다. CI 에서 돌리지 않는다 (로컬 수동 실행 전용).
 *  6. 값이 온전히 파싱되지 않으면 필드를 비운다.
 *
 * 사용법:
 *   node scripts/collect-issuer-rendered.mjs --issuer hyundai
 *   node scripts/collect-issuer-rendered.mjs --issuer hyundai --limit 2 --dry-run
 */

import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  stripTags,
  decodeEntities,
  parseKrw,
  parseKrwLoose,
  parseTierThreshold,
  parseTierCapRows,
  extractMonthlyCapPoints,
  extractMaxRatePct,
  extractSpendTiers,
  detectNoSpendCondition,
  inferCategory,
  makeSlug,
  robotsVerdict,
} from './collect-issuer-feed.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DELAY_MS = 2500;

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

function findChrome() {
  const hit = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!hit) {
    throw new Error(
      'Chrome 을 찾지 못했다. CHROME_PATH 환경변수로 실행 파일 경로를 지정하라.',
    );
  }
  return hit;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 헤드리스 Chrome 으로 페이지를 렌더링해 최종 DOM 을 가져온다.
 *
 * 기본 프로필을 쓰면 다른 Chrome 인스턴스와 충돌해 실행이 실패한다.
 * 호출마다 임시 프로필 디렉터리를 만들어 격리하고, 일시적 실패는 한 번 재시도한다.
 */
async function renderPage(chrome, url, { budgetMs = 15000, retries = 1 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const profile = await mkdtemp(path.join(tmpdir(), 'krcbl-chrome-'));
    try {
      const { stdout } = await execFileAsync(
        chrome,
        [
          '--headless',
          '--disable-gpu',
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-extensions',
          `--user-data-dir=${profile}`,
          `--virtual-time-budget=${budgetMs}`,
          '--window-size=1400,3000',
          '--dump-dom',
          url,
        ],
        { maxBuffer: 64 * 1024 * 1024, timeout: budgetMs + 30000 },
      );
      return stdout;
    } catch (err) {
      lastError = err;
      if (attempt < retries) await sleep(3000);
    } finally {
      await rm(profile, { recursive: true, force: true }).catch(() => {});
    }
  }
  throw lastError;
}

/**
 * robots.txt 를 읽는다. 일반 fetch 가 보호 계층에 막히는 카드사가 있어,
 * 실패하면 같은 브라우저로 다시 읽는다. 우회가 아니라 동일 자원을 브라우저로 읽는 것이다.
 */
async function fetchRobots(chrome, origin) {
  const url = `${origin}/robots.txt`;
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent':
          'kr-card-benefits-lab/0.1 (card benefit research dataset; +https://github.com/minwoo19930301/kr-card-benefits-lab)',
      },
    });
    if (res.ok) return await res.text();
  } catch {
    /* 브라우저로 재시도 */
  }
  const dom = await renderPage(chrome, url, { budgetMs: 8000 });
  // Chrome 은 텍스트 파일을 <pre> 로 감싼다
  const pre = /<pre[^>]*>([\s\S]*?)<\/pre>/i.exec(dom);
  return decodeEntities(pre ? pre[1] : stripTags(dom));
}

// --------------------------------------------------------------- 현대카드

/**
 * 현대카드 연회비 파서.
 *
 * 페이지에는 '국내외겸용 80,000원 (기본연회비 20,000원 + 제휴연회비 60,000원)
 * 가족카드 20,000원' 처럼 여러 금액이 함께 나온다. 본인 카드의 총 연회비만 취해야 하므로
 * 브랜드 구분(국내외겸용 / 국내전용) 바로 뒤의 금액만 본다.
 *
 * '무료 주차' 같은 혜택 문구의 '무료' 를 연회비 면제로 오독하지 않기 위해,
 * 0 원은 '연회비 없음' / '연회비 면제' 문구가 실제로 있을 때만 인정한다.
 */
export function parseHyundaiAnnualFee(text) {
  const t = String(text).replace(/\s+/g, ' ');
  const amounts = [];
  for (const m of t.matchAll(/(국내외겸용|국내전용)\s*(?:\([^)]*\))?\s*([\d,]+)\s*원/g)) {
    // 가족카드 금액이 바로 앞에 오는 경우를 배제한다
    const before = t.slice(Math.max(0, m.index - 12), m.index);
    if (/가족카드\s*$/.test(before)) continue;
    const v = parseKrw(`${m[2]}원`);
    if (v !== null && v > 0) amounts.push(v);
  }
  if (amounts.length) return Math.min(...amounts);
  if (/연회비\s*(없음|면제)/.test(t)) return 0;
  return null;
}

/**
 * 현대카드 상세 페이지 구조
 *   .cate_tit p            혜택 구분 (기본 혜택 / 추가 혜택 / 연간 보너스 / 우대 서비스)
 *   .item_tit em           적용 대상 (국내외 가맹점)
 *   .item_tit p            요율·내용 (1.5% M포인트 적립)
 *   .item_cont .sub_txt p  조건 (전월 이용 금액 50만원 이상 시)
 */
export function parseHyundaiDetail(html, { pageUrl, retrievedAt, cardType = 'credit' }) {
  const warnings = [];
  const titleMatch = /<title>([\s\S]*?)<\/title>/i.exec(html);
  const rawTitle = titleMatch ? stripTags(decodeEntities(titleMatch[1])) : '';
  // "현대카드 Summit-현대카드" 형태에서 상품명만 취한다
  const name = rawTitle.replace(/\s*-\s*현대카드\s*$/, '').trim();
  if (!name || /^현대카드$/.test(name)) {
    return { card: null, warnings: ['카드명을 확인할 수 없음 — 건너뜀'] };
  }

  const bodyHtml = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');

  const annualFee = parseHyundaiAnnualFee(stripTags(bodyHtml));
  if (annualFee === null) warnings.push('연회비 파싱 불가 — 필드 생략');

  // 혜택 블록. 레이아웃 변형이 여러 개라 item_cont/img_area 존재를 전제하지 않는다.
  // item_tit 를 구분자로 나누고, 뒤따르는 일정 범위에서 대상·요율·조건을 찾는다.
  const benefits = [];
  for (const raw of bodyHtml.split(/<div class="item_tit">/).slice(1)) {
    const region = raw.slice(0, 1500);
    const scope = stripTags(/<em[^>]*>([\s\S]*?)<\/em>/i.exec(region)?.[1] ?? '');
    const headline = stripTags(/<p[^>]*>([\s\S]*?)<\/p>/i.exec(region)?.[1] ?? '');
    if (!scope && !headline) continue;
    const condition = stripTags(
      /<div class="sub_txt">[\s\S]{0,200}?<p[^>]*>([\s\S]*?)<\/p>/i.exec(region)?.[1] ?? '',
    );

    const title = [scope, headline].filter(Boolean).join(' ').trim();
    const benefit = { category: inferCategory(title), title: title.slice(0, 200) };
    const rate = extractMaxRatePct(headline);
    if (rate !== null) benefit.rate_pct = rate;
    if (condition) benefit.summary = condition.slice(0, 600);

    // '월 2만 M포인트 한도' 는 포인트 단위라 원화 한도로 쓰지 않는다.
    const capMatch = /월\s*([\d,]+\s*만?\s*원)\s*한도/.exec(headline);
    if (capMatch) {
      const cap = parseKrw(capMatch[1]);
      if (cap !== null) benefit.monthly_cap_krw = cap;
    }
    // '월 1만 M포인트 한도' 는 원화가 아니라 포인트 단위 한도다.
    if (!Number.isFinite(benefit.monthly_cap_krw)) {
      const pts = extractMonthlyCapPoints(headline);
      if (pts !== null) benefit.monthly_cap_points = pts;
    }
    // '누적 이용 금액' / '전년도 이용 금액' 은 전월 실적이 아니다. 전월 조건만 인정한다.
    if (/전월/.test(condition)) {
      const req = parseTierThreshold(condition);
      if (req !== null) benefit.requires_prev_month_spend_krw = req;
    }
    benefits.push(benefit);
  }
  if (!benefits.length) return { card: null, warnings: [...warnings, '혜택 블록 없음 — 건너뜀'] };

  const pageText = stripTags(bodyHtml);
  const tiers = extractSpendTiers(pageText);
  const noSpendCondition = !tiers.length && detectNoSpendCondition(pageText);

  const signals = [
    annualFee !== null,
    benefits.length > 0,
    tiers.length > 0 || noSpendCondition,
    benefits.some((b) => Number.isFinite(b.rate_pct)),
    benefits.some((b) => Number.isFinite(b.monthly_cap_krw) || Number.isFinite(b.monthly_cap_points)),
  ];
  const score = signals.filter(Boolean).length;

  const card = {
    id: `hyundai-${makeSlug(name, pageUrl)}`,
    issuer: 'hyundai',
    name,
    product_url: pageUrl,
    // 어느 카탈로그(신용/체크)에서 발견했는지를 기본값으로 쓰고,
    // 상품명에 '체크' 가 있으면 그쪽을 신뢰한다.
    card_type: /체크/.test(name) ? 'check' : cardType,
    benefits,
    confidence: score >= 5 ? 'high' : score >= 3 ? 'medium' : 'low',
    review_status: 'machine_extracted',
    updated_at: retrievedAt,
    source: {
      kind: 'issuer_official_page',
      url: pageUrl,
      retrieved_at: retrievedAt,
      note: '카드사 공식 상품 상세 페이지 (브라우저 렌더링 후 추출)',
    },
  };
  if (annualFee !== null) card.annual_fee_krw = annualFee;
  if (tiers.length) card.prev_month_spend_tiers_krw = tiers;
  else if (noSpendCondition) card.no_prev_month_spend_condition = true;

  return { card, warnings };
}

// --------------------------------------------------------------- 신한카드

/**
 * 신한카드 상세 페이지 구조
 *   <title>                           신한카드 Mr.Life | 카드 | 신한카드
 *   '연회비' 뒤 텍스트                브랜드별 연회비 (예: Visa 1만8천원 (기본) S& 1만5천원 (기본))
 *   ul.benefit-list > li              혜택 항목
 *     p.item--text-title              혜택 이름
 *     ul.item--text-desc > li         한 줄 요약 / 유의사항
 */
export function parseShinhanDetail(html, { pageUrl, retrievedAt, cardType = 'credit' }) {
  const warnings = [];
  const titleMatch = /<title>([\s\S]*?)<\/title>/i.exec(html);
  const name = titleMatch ? stripTags(decodeEntities(titleMatch[1])).split('|')[0].trim() : '';
  if (!name || /^신한카드$/.test(name)) {
    return { card: null, warnings: ['카드명을 확인할 수 없음 — 건너뜀'] };
  }

  const bodyHtml = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
  const pageText = stripTags(bodyHtml);

  // 연회비: '연회비' 이후 200자 안의 금액 표기 중 최저값.
  // '연회비 100% 캐시백' 같은 이벤트 문구가 뒤따르므로 범위를 좁게 잡는다.
  let annualFee = null;
  const feeRegion = /연회비\s*([\s\S]{0,200}?)(?:신규|이벤트|주요\s*혜택|유의사항)/.exec(pageText);
  if (feeRegion) {
    const amounts = [];
    for (const m of feeRegion[1].matchAll(/[\d,]+\s*만?\s*[\d,]*\s*천?\s*원/g)) {
      const v = parseKrwLoose(m[0]);
      if (v !== null && v > 0) amounts.push(v);
    }
    if (amounts.length) annualFee = Math.min(...amounts);
    // Page-wide fee-waiver boilerplate is not this product's annual fee.
    else if (/^\s*(없음|면제)(?:\s|$)/.test(feeRegion[1])) annualFee = 0;
  }
  if (annualFee === null) warnings.push('연회비 파싱 불가 — 필드 생략');

  const benefits = [];
  // 항목 자체가 <li> 이고 내부에도 <ul>/<li> 가 중첩되어 닫는 태그로 경계를 잡을 수 없다.
  // 항목 구분자로 나눈 뒤, 텍스트 영역이 끝나는 item--image 앞까지만 본다.
  const chunks = bodyHtml.split(/<li class="benefit-list__item">/).slice(1);
  for (const raw of chunks) {
    const item = raw.split('item--image')[0];
    const title = stripTags(/<p class="item--text-title">([\s\S]*?)<\/p>/i.exec(item)?.[1] ?? '');
    if (!title) continue;
    const descs = [...item.matchAll(/<li>([\s\S]*?)<\/li>/gi)].map((d) => stripTags(d[1])).filter(Boolean);
    const summary = descs.join(' / ').slice(0, 600);

    const benefit = { category: inferCategory(`${title} ${summary}`), title: title.slice(0, 200) };
    if (summary) benefit.summary = summary;
    const rate = extractMaxRatePct(`${title} ${summary}`);
    if (rate !== null) benefit.rate_pct = rate;
    const capMatch = /월\s*(?:최대\s*)?([\d,]+\s*만?\s*[\d,]*\s*천?\s*원)\s*(?:한도|까지)/.exec(summary);
    if (capMatch) {
      const cap = parseKrwLoose(capMatch[1]);
      if (cap !== null) benefit.monthly_cap_krw = cap;
    }
    if (!Number.isFinite(benefit.monthly_cap_krw)) {
      const pts = extractMonthlyCapPoints(`${title} ${summary}`);
      if (pts !== null) benefit.monthly_cap_points = pts;
    }
    if (/전월/.test(summary)) {
      const req = parseTierThreshold(summary);
      if (req !== null) benefit.requires_prev_month_spend_krw = req;
    }
    benefits.push(benefit);
  }
  if (!benefits.length) return { card: null, warnings: [...warnings, '혜택 목록 없음 — 건너뜀'] };

  // 혜택별 상세는 클릭으로 열리는 시트에 있지만 DOM 에는 이미 들어 있다.
  // 각 슬라이드의 <h3> 제목으로 위 혜택 목록과 짝지어 '전월 이용금액 / 할인한도' 표를 읽는다.
  const detailTiers = new Set();
  for (const slide of bodyHtml.split(/<div class="swiper-slide">/).slice(1)) {
    const heading = stripTags(/<h3[^>]*>([\s\S]*?)<\/h3>/i.exec(slide)?.[1] ?? '');
    if (!heading) continue;
    const rows = parseTierCapRows(slide);
    if (!rows.length) continue;
    for (const r of rows) detailTiers.add(r.tier);
    const target = benefits.find((b) => b.title === heading);
    if (!target) continue;
    const lowest = rows[0];
    if (!Number.isFinite(target.monthly_cap_krw)) target.monthly_cap_krw = lowest.cap;
    if (!Number.isFinite(target.requires_prev_month_spend_krw)) {
      target.requires_prev_month_spend_krw = lowest.tier;
    }
  }

  const tiers = [...new Set([...extractSpendTiers(pageText), ...detailTiers])]
    .filter((t) => t > 0)
    .sort((a, b) => a - b);
  const noSpendCondition = !tiers.length && detectNoSpendCondition(pageText);
  const signals = [
    annualFee !== null,
    benefits.length > 0,
    tiers.length > 0 || noSpendCondition,
    benefits.some((b) => Number.isFinite(b.rate_pct)),
    benefits.some((b) => Number.isFinite(b.monthly_cap_krw) || Number.isFinite(b.monthly_cap_points)),
  ];
  const score = signals.filter(Boolean).length;

  const card = {
    id: `shinhan-${makeSlug(name.replace(/^신한카드\s*/, ''), pageUrl)}`,
    issuer: 'shinhan',
    name,
    product_url: pageUrl,
    card_type: /체크/.test(name) ? 'check' : cardType,
    benefits,
    confidence: score >= 5 ? 'high' : score >= 3 ? 'medium' : 'low',
    review_status: 'machine_extracted',
    updated_at: retrievedAt,
    source: {
      kind: 'issuer_official_page',
      url: pageUrl,
      retrieved_at: retrievedAt,
      note: '카드사 공식 상품 상세 페이지 (브라우저 렌더링 후 추출)',
    },
  };
  if (annualFee !== null) card.annual_fee_krw = annualFee;
  if (tiers.length) card.prev_month_spend_tiers_krw = tiers;
  else if (noSpendCondition) card.no_prev_month_spend_condition = true;

  return { card, warnings };
}

const SHINHAN_LIST_PAGES = [
  { path: 'credit/CONFM70002/CONFM70002R01', cardType: 'credit' },
  { path: 'check/CONFM70015/CONFM70015R01', cardType: 'check' },
  { path: 'premium/CONFM70004/CONFM70004R01', cardType: 'credit' },
  { path: 'premium/CONFM70004/CONFM70004R02', cardType: 'credit' },
  { path: 'premium/CONFM70004/CONFM70004R03', cardType: 'credit' },
  { path: 'premium/CONFM70004/CONFM70004R04', cardType: 'credit' },
];

const ISSUER_HANDLERS = {
  hyundai: {
    // 공식 카탈로그 페이지. 카드 이미지 파일명(card_{코드}_*.png)에 상품 코드가 들어 있다.
    listUrls: [
      { url: 'https://www.hyundaicard.com/cpc/ma/CPCMA0101_01.hc', cardType: 'credit' },
      { url: 'https://www.hyundaicard.com/cpc/cr/CPCCR0621_11.hc?cardflag=C', cardType: 'check' },
    ],
    robotsPath: '/cpc/',
    listBudgetMs: 22000,
    discover(listHtml, cardType) {
      const codes = new Set([
        ...[...listHtml.matchAll(/card_([A-Z0-9]+)_[a-z]*\.png/g)].map((m) => m[1]),
        ...[...listHtml.matchAll(/cardWcd=([A-Z0-9]+)/g)].map((m) => m[1]),
      ]);
      return [...codes].sort().map((code) => ({
        url: `https://www.hyundaicard.com/cpc/cr/CPCCR0201_01.hc?cardWcd=${code}`,
        cardType,
      }));
    },
    parse: parseHyundaiDetail,
    detailBudgetMs: 16000,
  },

  shinhan: {
    // 공식 카드 목록 페이지. 상세는 정적 .html 이지만 연회비가 클라이언트 템플릿이라 렌더링이 필요하다.
    listUrls: SHINHAN_LIST_PAGES.map(({ path, cardType }) => ({
      url: `https://www.shinhancard.com/pconts/html/card/${path}.html`,
      cardType,
    })),
    robotsPath: '/pconts/html/card/',
    listBudgetMs: 18000,
    discover(listHtml, cardType) {
      const paths = new Set(
        [...listHtml.matchAll(/\/pconts\/html\/card\/apply\/(?:credit|check|premium)\/\d+_\d+\.html/g)].map(
          (m) => m[0],
        ),
      );
      return [...paths].sort().map((p) => ({
        url: `https://www.shinhancard.com${p}`,
        cardType: p.includes('/check/') ? 'check' : cardType,
      }));
    },
    parse: parseShinhanDetail,
    detailBudgetMs: 15000,
  },
};

// --------------------------------------------------------------- main

function parseArgs(argv) {
  const args = { issuer: null, limit: Infinity, delay: DEFAULT_DELAY_MS, dryRun: false, merge: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--issuer') args.issuer = argv[++i];
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--delay') args.delay = Number(argv[++i]);
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--no-merge') args.merge = false;
    else throw new Error(`알 수 없는 인자: ${a}`);
  }
  if (!args.issuer) throw new Error('--issuer 를 지정하라');
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const handler = ISSUER_HANDLERS[args.issuer];
  if (!handler) {
    throw new Error(
      `'${args.issuer}' 핸들러가 없다. 지원: ${Object.keys(ISSUER_HANDLERS).join(', ')}`,
    );
  }
  const chrome = findChrome();
  console.log(`Chrome: ${chrome}`);

  const origin = new URL(handler.listUrls[0].url).origin;
  console.log(`[1/4] robots.txt 확인: ${origin}/robots.txt`);
  const robots = await fetchRobots(chrome, origin);
  const verdict = robotsVerdict(robots, handler.robotsPath);
  console.log(`      ${handler.robotsPath} → ${verdict.allowed ? 'ALLOWED' : 'BLOCKED'} (${verdict.reason})`);
  if (!verdict.allowed) throw new Error('robots.txt 가 대상 경로를 차단한다. 중단.');

  console.log('[2/4] 공식 카탈로그에서 상세 URL 수집');
  const byUrl = new Map();
  for (const entry of handler.listUrls) {
    const html = await renderPage(chrome, entry.url, { budgetMs: handler.listBudgetMs ?? 16000 });
    const found = handler.discover(html, entry.cardType);
    for (const t of found) if (!byUrl.has(t.url)) byUrl.set(t.url, t);
    console.log(`      ${entry.cardType}: ${found.length}건 (${entry.url})`);
    await sleep(args.delay);
  }
  const all = [...byUrl.values()];
  const targets = all.slice(0, args.limit === Infinity ? all.length : args.limit);
  console.log(`      상세 URL ${targets.length}건 (중복 제거 후 ${all.length}건)`);

  const retrievedAt = new Date().toISOString().slice(0, 10);
  const cards = [];
  console.log(`[3/4] 상세 페이지 렌더링 (간격 ${args.delay}ms)`);
  for (const [i, target] of targets.entries()) {
    const { url, cardType } = target;
    try {
      const html = await renderPage(chrome, url, { budgetMs: handler.detailBudgetMs });
      const { card, warnings } = handler.parse(html, { pageUrl: url, retrievedAt, cardType });
      if (card) {
        cards.push(card);
        console.log(`      ${i + 1}/${targets.length} ok   ${card.name}`);
      } else {
        console.log(`      ${i + 1}/${targets.length} skip ${warnings.join('; ')}`);
      }
    } catch (err) {
      console.log(`      ${i + 1}/${targets.length} err  ${err.message.slice(0, 120)}`);
    }
    if (i < targets.length - 1) await sleep(args.delay);
  }

  if (args.dryRun) {
    console.log(JSON.stringify(cards.slice(0, 2), null, 2));
    return;
  }

  // 기존 데이터와 병합한다. 같은 카드사의 이전 수집분은 대체한다.
  const outPath = path.join(ROOT, 'data/cards.json');
  let existing = { schema_version: 1, generated_at: retrievedAt, cards: [] };
  try {
    existing = JSON.parse(await readFile(outPath, 'utf8'));
  } catch {
    /* 최초 실행 */
  }
  const kept = args.merge ? existing.cards.filter((c) => c.issuer !== args.issuer) : [];
  const byId = new Map();
  for (const c of [...kept, ...cards]) byId.set(c.id, c);
  const merged = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));

  await writeFile(
    outPath,
    `${JSON.stringify({ schema_version: 1, generated_at: retrievedAt, cards: merged }, null, 2)}\n`,
    'utf8',
  );
  console.log(`[4/4] ${args.issuer} ${cards.length}건 수집, 전체 ${merged.length}건 기록`);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`실패: ${err.message}`);
    process.exit(1);
  });
}
