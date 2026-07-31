import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  validateAgainstSchema,
  checkSourcePolicy,
  checkForbiddenInIssuers,
  FORBIDDEN_SOURCE_PATTERNS,
} from '../scripts/validate.mjs';
import { computePickingRate, pickingCaveat, formatKrw, PICKING_STATUS } from '../site/picking.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFile(path.join(ROOT, p), 'utf8').then(JSON.parse);

const ISSUERS = {
  issuers: [{ key: 'woori', name: '우리카드', allowed_domains: ['pc.wooricard.com'] }],
};

const okCard = () => ({
  id: 'woori-test-card',
  issuer: 'woori',
  name: '테스트 카드',
  product_url: 'https://pc.wooricard.com/a',
  card_type: 'credit',
  benefits: [{ category: 'shopping', title: '쇼핑 할인', rate_pct: 5, monthly_cap_krw: 10000 }],
  confidence: 'medium',
  review_status: 'machine_extracted',
  updated_at: '2026-07-31',
  source: { kind: 'issuer_machine_readable_feed', url: 'https://pc.wooricard.com/ai-data/card_1.html', retrieved_at: '2026-07-31' },
});

// ------------------------------------------------------------- schema engine

test('validateAgainstSchema: 정상 문서는 오류가 없다', async () => {
  const schema = await read('data/cards.schema.json');
  const doc = { schema_version: 1, generated_at: '2026-07-31', cards: [okCard()] };
  assert.deepEqual(validateAgainstSchema(doc, schema), []);
});

test('validateAgainstSchema: 필수 필드 누락을 잡는다', async () => {
  const schema = await read('data/cards.schema.json');
  const card = okCard();
  delete card.source;
  const errors = validateAgainstSchema({ schema_version: 1, generated_at: '2026-07-31', cards: [card] }, schema);
  assert.ok(errors.some((e) => e.includes("'source' 누락")), errors.join('\n'));
});

test('validateAgainstSchema: 정의되지 않은 필드를 잡는다', async () => {
  const schema = await read('data/cards.schema.json');
  const card = { ...okCard(), corp: 12, key_benefit: 'x' };
  const errors = validateAgainstSchema({ schema_version: 1, generated_at: '2026-07-31', cards: [card] }, schema);
  assert.ok(errors.some((e) => e.includes("'corp'")));
  assert.ok(errors.some((e) => e.includes("'key_benefit'")));
});

test('validateAgainstSchema: enum / pattern / 범위를 검사한다', async () => {
  const schema = await read('data/cards.schema.json');
  const card = {
    ...okCard(),
    id: 'Woori_Bad_ID',
    card_type: 'prepaid',
    benefits: [{ category: 'shopping', title: '과한 요율', rate_pct: 500 }],
  };
  const errors = validateAgainstSchema({ schema_version: 1, generated_at: '2026-07-31', cards: [card] }, schema);
  assert.ok(errors.some((e) => e.includes('패턴')));
  assert.ok(errors.some((e) => e.includes('허용값')));
  assert.ok(errors.some((e) => e.includes('이하여야 함')));
});

test('validateAgainstSchema: 타입 불일치를 잡는다', async () => {
  const schema = await read('data/cards.schema.json');
  const card = { ...okCard(), annual_fee_krw: '10000' };
  const errors = validateAgainstSchema({ schema_version: 1, generated_at: '2026-07-31', cards: [card] }, schema);
  assert.ok(errors.some((e) => e.includes('integer')));
});

// ------------------------------------------------------------- source policy

test('checkSourcePolicy: 정상 카드는 통과', () => {
  assert.deepEqual(checkSourcePolicy([okCard()], ISSUERS), []);
});

test('checkSourcePolicy: allowlist 밖 도메인을 거부한다', () => {
  const card = { ...okCard(), source: { ...okCard().source, url: 'https://example.com/x' } };
  const errors = checkSourcePolicy([card], ISSUERS);
  assert.ok(errors.some((e) => e.includes('allowlist')));
});

test('checkSourcePolicy: 금지 출처 흔적을 잡는다', () => {
  const card = { ...okCard(), tagline: 'via api.card-gorilla.com:8080/v1' };
  const errors = checkSourcePolicy([card], ISSUERS);
  assert.ok(errors.some((e) => e.includes('금지 출처')));
});

test('checkSourcePolicy: id 접두어와 중복을 검사한다', () => {
  const bad = { ...okCard(), id: 'shinhan-test-card' };
  assert.ok(checkSourcePolicy([bad], ISSUERS).some((e) => e.includes("'woori-' 로 시작")));
  const dup = checkSourcePolicy([okCard(), okCard()], ISSUERS);
  assert.ok(dup.some((e) => e.includes('id 중복')));
});

test('checkSourcePolicy: 실적 조건 모순을 잡는다', () => {
  const card = { ...okCard(), no_prev_month_spend_condition: true, prev_month_spend_tiers_krw: [300000] };
  assert.ok(checkSourcePolicy([card], ISSUERS).some((e) => e.includes('모순') || e.includes('채워져')));
});

test('checkSourcePolicy: 빈 혜택 목록을 잡는다', () => {
  const card = { ...okCard(), benefits: [] };
  assert.ok(checkSourcePolicy([card], ISSUERS).some((e) => e.includes('benefits')));
});

test('checkForbiddenInIssuers: allowed_domains 누락을 잡는다', () => {
  const errors = checkForbiddenInIssuers({ issuers: [{ key: 'x', allowed_domains: [] }] });
  assert.ok(errors.some((e) => e.includes('allowed_domains')));
});

test('FORBIDDEN_SOURCE_PATTERNS 는 알려진 표기 변형을 모두 잡는다', () => {
  const samples = ['CardGorilla', 'card-gorilla', 'card_gorilla', 'https://x:8080/v1/a', 'd1c5n4ri2guedi'];
  for (const s of samples) {
    assert.ok(FORBIDDEN_SOURCE_PATTERNS.some((re) => re.test(s)), `잡지 못함: ${s}`);
  }
});

// ------------------------------------------------------------- picking rate

test('computePickingRate: 알려진 한도 합을 실적으로 나눈다', () => {
  const card = {
    prev_month_spend_tiers_krw: [300000, 600000],
    benefits: [
      { monthly_cap_krw: 4000 },
      { monthly_cap_krw: 3000 },
      { monthly_cap_krw: 3000 },
    ],
  };
  const r = computePickingRate(card);
  assert.equal(r.status, PICKING_STATUS.OK);
  assert.equal(r.estimatedKrw, 10000);
  assert.equal(r.tierKrw, 300000);
  assert.equal(r.pct, 3.3);
});

test('computePickingRate: 한도 미상 혜택은 0 으로 계산하고 개수를 알린다', () => {
  const card = {
    prev_month_spend_tiers_krw: [300000],
    benefits: [{ monthly_cap_krw: 30000 }, { rate_pct: 5 }, { rate_pct: 3 }],
  };
  const r = computePickingRate(card);
  assert.equal(r.pct, 10);
  assert.equal(r.uncappedCount, 2);
  assert.match(pickingCaveat(r), /2건/);
});

test('computePickingRate: 통합 월 한도가 있으면 개별 한도 합보다 우선한다', () => {
  const card = {
    prev_month_spend_tiers_krw: [300000],
    integrated_monthly_cap_krw: 15000,
    benefits: [{ monthly_cap_krw: 10000 }, { monthly_cap_krw: 10000 }, { monthly_cap_krw: 10000 }],
  };
  const r = computePickingRate(card);
  assert.equal(r.basis, 'integrated_cap');
  assert.equal(r.estimatedKrw, 15000, '개별 합 30000 이 아니라 통합 한도 15000 을 써야 한다');
  assert.equal(r.pct, 5);
  assert.match(pickingCaveat(r), /통합 월 한도/);
});

test('computePickingRate: 통합 한도만 있고 개별 한도가 없어도 계산한다', () => {
  const r = computePickingRate({
    prev_month_spend_tiers_krw: [300000],
    integrated_monthly_cap_krw: 30000,
    benefits: [{ rate_pct: 5 }],
  });
  assert.equal(r.status, PICKING_STATUS.OK);
  assert.equal(r.pct, 10);
});

test('computePickingRate: 실적 조건이 없으면 정의하지 않는다', () => {
  const r = computePickingRate({ no_prev_month_spend_condition: true, benefits: [{ monthly_cap_krw: 5000 }] });
  assert.equal(r.status, PICKING_STATUS.NO_SPEND_CONDITION);
  assert.equal(r.pct, null);
  assert.match(pickingCaveat(r), /정의할 수 없/);
});

test('computePickingRate: 한도를 하나도 모르면 계산하지 않는다', () => {
  const r = computePickingRate({ prev_month_spend_tiers_krw: [300000], benefits: [{ rate_pct: 5 }] });
  assert.equal(r.status, PICKING_STATUS.INSUFFICIENT_DATA);
  assert.equal(r.pct, null);
});

test('computePickingRate: 특정 실적 구간을 지정할 수 있다', () => {
  const card = { prev_month_spend_tiers_krw: [300000, 600000], benefits: [{ monthly_cap_krw: 30000 }] };
  assert.equal(computePickingRate(card, { tierKrw: 600000 }).pct, 5);
});

test('computePickingRate: 빈 입력에도 죽지 않는다', () => {
  const r = computePickingRate({});
  assert.equal(r.status, PICKING_STATUS.INSUFFICIENT_DATA);
  assert.equal(r.pct, null);
});

test('formatKrw', () => {
  assert.equal(formatKrw(0), '없음');
  assert.equal(formatKrw(300000), '30만원');
  assert.equal(formatKrw(4000), '4,000원');
  assert.equal(formatKrw(null), '-');
});

// ------------------------------------------------------------- 실제 데이터

test('실제 data/cards.json 이 스키마와 출처 정책을 만족한다', async () => {
  const [schema, doc, issuers] = await Promise.all([
    read('data/cards.schema.json'),
    read('data/cards.json'),
    read('data/issuers.json'),
  ]);
  assert.deepEqual(validateAgainstSchema(doc, schema), []);
  assert.deepEqual(checkSourcePolicy(doc.cards, issuers), []);
  assert.deepEqual(checkForbiddenInIssuers(issuers), []);
  assert.ok(doc.cards.length > 0);
});

test('실제 데이터의 모든 카드에 공식 출처 URL 이 있다', async () => {
  const doc = await read('data/cards.json');
  for (const card of doc.cards) {
    assert.match(card.source.url, /^https:\/\//, card.id);
    assert.match(card.product_url, /^https:\/\//, card.id);
  }
});

test('cards.json 이 과도하게 크지 않다 (5MB 이하)', async () => {
  const raw = await readFile(path.join(ROOT, 'data/cards.json'), 'utf8');
  assert.ok(Buffer.byteLength(raw) < 5 * 1024 * 1024, `${Buffer.byteLength(raw)} bytes`);
});
