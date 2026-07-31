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

import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  stripTags,
  decodeEntities,
  parseKrw,
  parseTierThreshold,
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

/** 헤드리스 Chrome 으로 페이지를 렌더링해 최종 DOM 을 가져온다. */
async function renderPage(chrome, url, { budgetMs = 15000 } = {}) {
  const { stdout } = await execFileAsync(
    chrome,
    [
      '--headless',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      `--virtual-time-budget=${budgetMs}`,
      '--window-size=1400,3000',
      '--dump-dom',
      url,
    ],
    { maxBuffer: 64 * 1024 * 1024, timeout: budgetMs + 25000 },
  );
  return stdout;
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
export function parseHyundaiDetail(html, { pageUrl, retrievedAt }) {
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

  // 혜택 블록
  const benefits = [];
  const itemRe =
    /<div class="item_tit">([\s\S]*?)<\/div>[\s\S]{0,200}?<div class="item_cont">([\s\S]*?)<div class="img_area/gi;
  for (const m of bodyHtml.matchAll(itemRe)) {
    const titleBlock = m[1];
    const scope = stripTags(/<em[^>]*>([\s\S]*?)<\/em>/i.exec(titleBlock)?.[1] ?? '');
    const headline = stripTags(/<p[^>]*>([\s\S]*?)<\/p>/i.exec(titleBlock)?.[1] ?? '');
    const condition = stripTags(/<div class="sub_txt">([\s\S]*?)<\/div>/i.exec(m[2])?.[1] ?? '');
    if (!scope && !headline) continue;

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
    benefits.some((b) => Number.isFinite(b.monthly_cap_krw)),
  ];
  const score = signals.filter(Boolean).length;

  const card = {
    id: `hyundai-${makeSlug(name, pageUrl)}`,
    issuer: 'hyundai',
    name,
    product_url: pageUrl,
    // 현대카드 상세 페이지는 신용/체크를 본문에서 단정하기 어렵다.
    // 체크카드 전용 경로(/cpc/ch/)에서 온 경우만 check 로 본다.
    card_type: /\/cpc\/ch\//.test(pageUrl) ? 'check' : 'credit',
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

const ISSUER_HANDLERS = {
  hyundai: {
    listUrls: ['https://www.hyundaicard.com/cpc/cr/CPCCR0101_01.hc'],
    robotsPath: '/cpc/',
    discover(listHtml) {
      const codes = new Set(
        [...listHtml.matchAll(/cardWcd=([A-Z0-9]+)/g)].map((m) => m[1]),
      );
      return [...codes]
        .sort()
        .map((c) => `https://www.hyundaicard.com/cpc/cr/CPCCR0201_01.hc?cardWcd=${c}`);
    },
    parse: parseHyundaiDetail,
    detailBudgetMs: 16000,
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

  const origin = new URL(handler.listUrls[0]).origin;
  console.log(`[1/4] robots.txt 확인: ${origin}/robots.txt`);
  const robots = await fetchRobots(chrome, origin);
  const verdict = robotsVerdict(robots, handler.robotsPath);
  console.log(`      ${handler.robotsPath} → ${verdict.allowed ? 'ALLOWED' : 'BLOCKED'} (${verdict.reason})`);
  if (!verdict.allowed) throw new Error('robots.txt 가 대상 경로를 차단한다. 중단.');

  console.log('[2/4] 상품 목록에서 상세 URL 수집');
  const urls = new Set();
  for (const listUrl of handler.listUrls) {
    const html = await renderPage(chrome, listUrl, { budgetMs: 14000 });
    for (const u of handler.discover(html)) urls.add(u);
    await sleep(args.delay);
  }
  const targets = [...urls].slice(0, args.limit === Infinity ? urls.size : args.limit);
  console.log(`      상세 URL ${targets.length}건`);

  const retrievedAt = new Date().toISOString().slice(0, 10);
  const cards = [];
  console.log(`[3/4] 상세 페이지 렌더링 (간격 ${args.delay}ms)`);
  for (const [i, url] of targets.entries()) {
    try {
      const html = await renderPage(chrome, url, { budgetMs: handler.detailBudgetMs });
      const { card, warnings } = handler.parse(html, { pageUrl: url, retrievedAt });
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
