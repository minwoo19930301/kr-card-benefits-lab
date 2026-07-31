import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { emptyFilters, matches, sortCards, minTier } from '../site/filters.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const card = (over = {}) => ({
  id: 'woori-a',
  issuer: 'woori',
  name: '가 카드',
  card_type: 'credit',
  annual_fee_krw: 10000,
  prev_month_spend_tiers_krw: [300000],
  benefits: [{ category: 'shopping', title: '온라인 쇼핑 할인', monthly_cap_krw: 10000 }],
  ...over,
});

const f = (over = {}) => ({ ...emptyFilters(), ...over });

test('minTier: 최저 구간을 고르고 없으면 null', () => {
  assert.equal(minTier(card({ prev_month_spend_tiers_krw: [600000, 300000] })), 300000);
  assert.equal(minTier(card({ prev_month_spend_tiers_krw: [] })), null);
  assert.equal(minTier({}), null);
});

test('기본 필터는 모든 카드를 통과시킨다', () => {
  assert.equal(matches(card(), f()), true);
});

test('카드사 / 카드종류 필터', () => {
  assert.equal(matches(card(), f({ issuer: 'woori' })), true);
  assert.equal(matches(card(), f({ issuer: 'shinhan' })), false);
  assert.equal(matches(card(), f({ cardType: 'check' })), false);
  assert.equal(matches(card({ card_type: 'check' }), f({ cardType: 'check' })), true);
});

test('연회비 상한: 경계값 포함, 미확인 카드는 제외', () => {
  assert.equal(matches(card({ annual_fee_krw: 10000 }), f({ maxFee: '10000' })), true);
  assert.equal(matches(card({ annual_fee_krw: 10001 }), f({ maxFee: '10000' })), false);
  assert.equal(matches(card({ annual_fee_krw: 0 }), f({ maxFee: '0' })), true);

  const unknown = card();
  delete unknown.annual_fee_krw;
  assert.equal(matches(unknown, f({ maxFee: '0' })), false, '연회비 미확인 카드가 "연회비 없음"에 섞이면 안 된다');
  assert.equal(matches(unknown, f()), true, '필터가 없으면 미확인 카드도 보여야 한다');
});

test('전월실적 상한: 조건 없음 카드는 항상 통과, 미확인은 제외', () => {
  assert.equal(matches(card(), f({ maxSpend: '300000' })), true);
  assert.equal(matches(card({ prev_month_spend_tiers_krw: [500000] }), f({ maxSpend: '300000' })), false);

  const noCond = card({ prev_month_spend_tiers_krw: [], no_prev_month_spend_condition: true });
  assert.equal(matches(noCond, f({ maxSpend: '300000' })), true);

  const unknown = card({ prev_month_spend_tiers_krw: [] });
  assert.equal(matches(unknown, f({ maxSpend: '300000' })), false);
});

test('혜택 분야 필터는 OR 로 동작한다', () => {
  assert.equal(matches(card(), f({ categories: new Set(['shopping']) })), true);
  assert.equal(matches(card(), f({ categories: new Set(['tax']) })), false);
  assert.equal(matches(card(), f({ categories: new Set(['tax', 'shopping']) })), true);
});

test('검색은 카드명·소개문구·혜택 텍스트를 모두 본다', () => {
  assert.equal(matches(card(), f({ q: '가 카드' })), true);
  assert.equal(matches(card(), f({ q: '온라인' })), true);
  assert.equal(matches(card({ tagline: '해외여행에 좋은 카드' }), f({ q: '해외여행' })), true);
  assert.equal(matches(card(), f({ q: '존재하지않는키워드' })), false);
});

test('검색은 대소문자를 무시한다', () => {
  assert.equal(matches(card({ name: 'EVERY MILE' }), f({ q: 'every' })), true);
});

test('필터는 AND 로 결합된다', () => {
  const filters = f({ issuer: 'woori', cardType: 'credit', maxFee: '10000', q: '쇼핑' });
  assert.equal(matches(card(), filters), true);
  assert.equal(matches(card({ card_type: 'check' }), filters), false);
});

test('정렬: 연회비 오름차순은 미확인을 뒤로 보낸다', () => {
  const unknown = card({ id: 'woori-c', name: '다' });
  delete unknown.annual_fee_krw;
  const list = [unknown, card({ id: 'woori-b', name: '나', annual_fee_krw: 30000 }), card({ annual_fee_krw: 0 })];
  assert.deepEqual(sortCards(list, 'fee-asc').map((c) => c.id), ['woori-a', 'woori-b', 'woori-c']);
});

test('정렬: 연회비 내림차순 / 이름순 / 피킹률순', () => {
  const list = [
    card({ id: 'woori-a', name: '나 카드', annual_fee_krw: 0, benefits: [{ category: 'shopping', title: 'x', monthly_cap_krw: 1000 }] }),
    card({ id: 'woori-b', name: '가 카드', annual_fee_krw: 50000, benefits: [{ category: 'shopping', title: 'y', monthly_cap_krw: 30000 }] }),
  ];
  assert.deepEqual(sortCards(list, 'fee-desc').map((c) => c.id), ['woori-b', 'woori-a']);
  assert.deepEqual(sortCards(list, 'name').map((c) => c.id), ['woori-b', 'woori-a']);
  assert.deepEqual(sortCards(list, 'picking-desc').map((c) => c.id), ['woori-b', 'woori-a']);
});

test('정렬은 입력 배열을 변경하지 않는다', () => {
  const list = [card({ id: 'woori-b', name: '나' }), card({ id: 'woori-a', name: '가' })];
  const before = list.map((c) => c.id);
  sortCards(list, 'name');
  assert.deepEqual(list.map((c) => c.id), before);
});

test('실제 데이터로 필터가 동작한다', async () => {
  const doc = JSON.parse(await readFile(path.join(ROOT, 'data/cards.json'), 'utf8'));
  const all = doc.cards;

  const checks = all.filter((c) => matches(c, f({ cardType: 'check' })));
  assert.ok(checks.length > 0 && checks.length < all.length);
  assert.ok(checks.every((c) => c.card_type === 'check'));

  const free = all.filter((c) => matches(c, f({ maxFee: '0' })));
  assert.ok(free.every((c) => c.annual_fee_krw === 0));

  const shopping = all.filter((c) => matches(c, f({ categories: new Set(['shopping']) })));
  assert.ok(shopping.every((c) => c.benefits.some((b) => b.category === 'shopping')));

  assert.equal(sortCards(all, 'name').length, all.length);
});
