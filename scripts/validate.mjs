#!/usr/bin/env node
/**
 * data/cards.json 을 data/cards.schema.json 과 프로젝트 출처 정책에 대해 검증한다.
 *
 * 검사 항목
 *  - 스키마 (타입 / required / enum / pattern / 범위 / additionalProperties)
 *  - id 규칙: {issuer}-{slug}, 중복 없음
 *  - issuer 가 issuers.json 에 등록되어 있는지
 *  - product_url / source.url 이 해당 카드사 도메인 allowlist 안에 있는지
 *  - 금지 출처 문자열이 데이터에 섞여 들어오지 않았는지
 *  - 수치 정합성 (월 한도가 요율만 있고 실적 조건이 모순되는 경우 등)
 *
 * 사용법:
 *   node scripts/validate.mjs
 *   node scripts/validate.mjs --check-urls   # 공식 URL 도달성까지 확인 (네트워크 사용)
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 데이터에 절대 들어오면 안 되는 출처 흔적.
 * 이 프로젝트는 제3자 카드 비교 서비스의 비공개 API 를 사용하지 않는다.
 */
export const FORBIDDEN_SOURCE_PATTERNS = [
  /card[-_ ]?gorilla/i,
  /cardgorilla/i,
  /banksalad/i,
  /뱅크샐러드/,
  /:8080\/v1/,
  /d1c5n4ri2guedi/i,
];

// ------------------------------------------------------- JSON Schema (subset)

/**
 * 이 프로젝트가 실제로 사용하는 JSON Schema 키워드만 해석한다.
 * 외부 의존성을 두지 않기 위한 의도적 축소 구현이며, 미지원 키워드를 만나면 에러로 알린다.
 */
const SUPPORTED = new Set([
  '$schema', '$id', '$ref', '$defs', 'title', 'description',
  'type', 'required', 'properties', 'additionalProperties', 'items',
  'enum', 'pattern', 'minimum', 'maximum', 'minLength', 'maxLength',
]);

export function validateAgainstSchema(data, schema, root = schema) {
  const errors = [];

  const walk = (value, node, at) => {
    for (const key of Object.keys(node)) {
      if (!SUPPORTED.has(key)) errors.push(`${at}: 스키마에 미지원 키워드 '${key}' 사용됨`);
    }
    if (node.$ref) {
      const target = node.$ref.replace(/^#\//, '').split('/').reduce((o, k) => o?.[k], root);
      if (!target) {
        errors.push(`${at}: $ref 해석 실패 (${node.$ref})`);
        return;
      }
      walk(value, target, at);
      return;
    }

    const t = node.type;
    if (t) {
      const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
      const ok =
        (t === 'integer' && Number.isInteger(value)) ||
        (t === 'number' && typeof value === 'number') ||
        (t === 'object' && actual === 'object') ||
        (t === 'array' && actual === 'array') ||
        (t === 'string' && actual === 'string') ||
        (t === 'boolean' && actual === 'boolean');
      if (!ok) {
        errors.push(`${at}: 타입이 ${t} 여야 하는데 ${actual} (${JSON.stringify(value)?.slice(0, 60)})`);
        return;
      }
    }

    if (node.enum && !node.enum.includes(value)) {
      errors.push(`${at}: 허용값 [${node.enum.join(', ')}] 중 하나여야 함 (받은 값: ${value})`);
    }
    if (typeof value === 'string') {
      if (node.pattern && !new RegExp(node.pattern).test(value)) {
        errors.push(`${at}: 패턴 ${node.pattern} 불일치 (${value.slice(0, 60)})`);
      }
      if (node.minLength != null && value.length < node.minLength) {
        errors.push(`${at}: 최소 길이 ${node.minLength} 미달`);
      }
      if (node.maxLength != null && value.length > node.maxLength) {
        errors.push(`${at}: 최대 길이 ${node.maxLength} 초과 (${value.length})`);
      }
    }
    if (typeof value === 'number') {
      if (node.minimum != null && value < node.minimum) errors.push(`${at}: ${node.minimum} 이상이어야 함`);
      if (node.maximum != null && value > node.maximum) errors.push(`${at}: ${node.maximum} 이하여야 함`);
    }

    if (node.type === 'object' || node.properties) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
      for (const req of node.required ?? []) {
        if (!(req in value)) errors.push(`${at}: 필수 필드 '${req}' 누락`);
      }
      const known = new Set(Object.keys(node.properties ?? {}));
      if (node.additionalProperties === false) {
        for (const k of Object.keys(value)) {
          if (!known.has(k)) errors.push(`${at}: 정의되지 않은 필드 '${k}'`);
        }
      }
      for (const [k, sub] of Object.entries(node.properties ?? {})) {
        if (k in value) walk(value[k], sub, `${at}.${k}`);
      }
    }

    if (node.items && Array.isArray(value)) {
      value.forEach((v, i) => walk(v, node.items, `${at}[${i}]`));
    }
  };

  walk(data, schema, '$');
  return errors;
}

// ------------------------------------------------------- project rules

export function checkSourcePolicy(cards, issuersDoc) {
  const errors = [];
  const byKey = new Map(issuersDoc.issuers.map((i) => [i.key, i]));
  const seenIds = new Set();

  for (const card of cards) {
    const at = card.id ?? '(id 없음)';

    if (seenIds.has(card.id)) errors.push(`${at}: id 중복`);
    seenIds.add(card.id);

    const issuer = byKey.get(card.issuer);
    if (!issuer) {
      errors.push(`${at}: issuer '${card.issuer}' 가 issuers.json 에 없음`);
      continue;
    }
    if (!card.id.startsWith(`${card.issuer}-`)) {
      errors.push(`${at}: id 는 '${card.issuer}-' 로 시작해야 함`);
    }

    const allowed = new Set(issuer.allowed_domains ?? []);
    for (const [field, url] of [
      ['product_url', card.product_url],
      ['source.url', card.source?.url],
    ]) {
      if (!url) continue;
      let host;
      try {
        host = new URL(url).hostname;
      } catch {
        errors.push(`${at}: ${field} 가 올바른 URL 이 아님 (${url})`);
        continue;
      }
      if (!allowed.has(host)) {
        errors.push(`${at}: ${field} 호스트 '${host}' 가 ${card.issuer} allowlist 에 없음`);
      }
    }

    const blob = JSON.stringify(card);
    for (const re of FORBIDDEN_SOURCE_PATTERNS) {
      if (re.test(blob)) errors.push(`${at}: 금지 출처 흔적 발견 (${re})`);
    }

    if (card.no_prev_month_spend_condition === true && card.prev_month_spend_tiers_krw?.length) {
      errors.push(`${at}: 실적 조건 없음으로 표시했는데 실적 구간이 채워져 있음`);
    }
    for (const [i, b] of (card.benefits ?? []).entries()) {
      if (b.requires_prev_month_spend_krw != null && card.no_prev_month_spend_condition === true) {
        errors.push(`${at}: benefits[${i}] 가 실적을 요구하는데 카드는 실적 조건 없음으로 표시됨`);
      }
      // 실적 금액을 월 한도로 잘못 읽는 파싱 오류를 데이터 단계에서 차단한다.
      // 국내 카드 상품에서 "월 한도 >= 필요 전월실적" 조합은 성립하지 않는다.
      if (
        Number.isFinite(b.monthly_cap_krw) &&
        Number.isFinite(b.requires_prev_month_spend_krw) &&
        b.monthly_cap_krw >= b.requires_prev_month_spend_krw
      ) {
        errors.push(
          `${at}: benefits[${i}] 월 한도 ${b.monthly_cap_krw} 가 필요 실적 ${b.requires_prev_month_spend_krw} 이상 — 파싱 오류로 의심됨`,
        );
      }
    }
    if (!card.benefits?.length) errors.push(`${at}: benefits 가 비어 있음`);
  }
  return errors;
}

export function checkForbiddenInIssuers(issuersDoc) {
  const errors = [];
  const blob = JSON.stringify(issuersDoc);
  for (const re of FORBIDDEN_SOURCE_PATTERNS) {
    if (re.test(blob)) errors.push(`issuers.json: 금지 출처 흔적 발견 (${re})`);
  }
  for (const issuer of issuersDoc.issuers) {
    if (!issuer.allowed_domains?.length) errors.push(`issuers.json: '${issuer.key}' allowed_domains 없음`);
  }
  return errors;
}

async function checkUrlsReachable(cards, concurrency = 4) {
  const errors = [];
  const queue = cards.map((c) => ({ id: c.id, url: c.source.url }));
  const workers = Array.from({ length: concurrency }, async () => {
    for (;;) {
      const job = queue.shift();
      if (!job) return;
      try {
        const res = await fetch(job.url, {
          method: 'GET',
          headers: { 'user-agent': 'kr-card-benefits-lab/0.1 (link check)' },
          redirect: 'follow',
        });
        if (!res.ok) errors.push(`${job.id}: source.url HTTP ${res.status}`);
      } catch (err) {
        errors.push(`${job.id}: source.url 요청 실패 (${err.message})`);
      }
    }
  });
  await Promise.all(workers);
  return errors;
}

// ------------------------------------------------------- main

async function main() {
  const checkUrls = process.argv.includes('--check-urls');
  const [schema, cardsDoc, issuersDoc] = await Promise.all([
    readFile(path.join(ROOT, 'data/cards.schema.json'), 'utf8').then(JSON.parse),
    readFile(path.join(ROOT, 'data/cards.json'), 'utf8').then(JSON.parse),
    readFile(path.join(ROOT, 'data/issuers.json'), 'utf8').then(JSON.parse),
  ]);

  const errors = [
    ...validateAgainstSchema(cardsDoc, schema),
    ...checkSourcePolicy(cardsDoc.cards, issuersDoc),
    ...checkForbiddenInIssuers(issuersDoc),
  ];

  if (checkUrls) {
    console.log(`공식 URL 도달성 확인 중 (${cardsDoc.cards.length}건)...`);
    errors.push(...(await checkUrlsReachable(cardsDoc.cards)));
  }

  const bytes = Buffer.byteLength(JSON.stringify(cardsDoc));
  const stats = {
    카드: cardsDoc.cards.length,
    카드사: new Set(cardsDoc.cards.map((c) => c.issuer)).size,
    혜택항목: cardsDoc.cards.reduce((n, c) => n + c.benefits.length, 0),
    'cards.json': `${(bytes / 1024).toFixed(0)} KB`,
  };
  console.log(Object.entries(stats).map(([k, v]) => `${k}: ${v}`).join('  |  '));

  if (errors.length) {
    console.error(`\n검증 실패 — ${errors.length}건`);
    for (const e of errors.slice(0, 50)) console.error(`  · ${e}`);
    if (errors.length > 50) console.error(`  ... 외 ${errors.length - 50}건`);
    process.exit(1);
  }
  console.log('검증 통과');
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`실패: ${err.message}`);
    process.exit(1);
  });
}
