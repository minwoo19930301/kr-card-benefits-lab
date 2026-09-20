import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assessCandidate, makeJobs, mergeAccepted } from '../scripts/collect-official-bd.mjs';

const schema = JSON.parse(await readFile(new URL('../data/cards.schema.json', import.meta.url), 'utf8'));
const issuers = JSON.parse(await readFile(new URL('../data/issuers.json', import.meta.url), 'utf8'));
const PAGE = 'https://www.shinhancard.com/pconts/html/card/apply/credit/1187937_2207.html';

function card(overrides = {}) {
  return {
    id: 'shinhan-recovery-fixture', issuer: 'shinhan', name: '신한카드 복구 테스트',
    product_url: PAGE, card_type: 'credit', annual_fee_krw: 18000,
    prev_month_spend_tiers_krw: [300000], integrated_monthly_cap_krw: 10000,
    benefits: [
      { category: 'utility', title: '생활요금 10% 할인', rate_pct: 10, monthly_cap_krw: 5000, requires_prev_month_spend_krw: 300000 },
      { category: 'food', title: '음식점 5% 할인', rate_pct: 5, monthly_cap_krw: 5000, requires_prev_month_spend_krw: 300000 },
    ],
    confidence: 'medium', review_status: 'machine_extracted', updated_at: '2026-07-31',
    source: { kind: 'issuer_official_page', url: PAGE, retrieved_at: '2026-07-31' },
    ...overrides,
  };
}

function fresh(previous = card()) {
  const candidate = structuredClone(previous);
  candidate.updated_at = '2026-09-21';
  candidate.source.retrieved_at = '2026-09-21';
  return candidate;
}

test('missing or benefit-free candidates are rejected and do not replace the previous card', () => {
  const original = { schema_version: 1, generated_at: '2026-07-31', cards: [card()] };
  const snapshot = structuredClone(original);
  for (const candidate of [null, {}, card({ benefits: [] })]) {
    assert.ok(assessCandidate(candidate, original.cards[0], schema, issuers).length);
  }
  const merged = mergeAccepted(original, [], '2026-09-21');
  assert.deepEqual(merged.cards, snapshot.cards);
  assert.equal(merged.cards[0].updated_at, '2026-07-31');
  assert.equal(merged.cards[0].source.retrieved_at, '2026-07-31');
  assert.deepEqual(original, snapshot, 'failed refresh must not mutate the original');
});

test('missing known annual fee, spend tiers or integrated limit rejects the whole candidate', () => {
  const previous = card();
  assert.deepEqual(assessCandidate(fresh(previous), previous, schema, issuers), []);
  for (const field of ['annual_fee_krw', 'prev_month_spend_tiers_krw', 'integrated_monthly_cap_krw']) {
    const candidate = fresh(previous);
    delete candidate[field];
    assert.ok(assessCandidate(candidate, previous, schema, issuers).length, field);
  }
});

test('accepted refresh keeps the existing ID and leaves uncollected records untouched', () => {
  const old = card();
  const other = card({ id: 'shinhan-another-fixture', name: '신한카드 다른 테스트', product_url: `${PAGE}?variant=other`, source: { kind: 'issuer_official_page', url: `${PAGE}?variant=other`, retrieved_at: '2026-07-30' } });
  const original = { schema_version: 1, generated_at: '2026-07-31', cards: [old, other] };
  const candidate = fresh(old);
  candidate.id = 'shinhan-parser-new-slug';
  const merged = mergeAccepted(original, [{ card: candidate, existingId: old.id }], '2026-09-21');
  assert.equal(merged.cards.length, 2);
  assert.equal(merged.cards.find(c => c.id === old.id).source.retrieved_at, '2026-09-21');
  assert.deepEqual(merged.cards.find(c => c.id === other.id), other);
  assert.equal(candidate.id, 'shinhan-parser-new-slug', 'merge does not mutate the candidate');
  assert.equal(old.source.retrieved_at, '2026-07-31');
});

test('URL canonicalization deduplicates repeated discovery and preserves existing identity', () => {
  const old = card({ source: { kind: 'issuer_official_page', url: `${PAGE}?b=2&a=1#old`, retrieved_at: '2026-07-31' } });
  const seeds = { issuers: [{ issuer: 'shinhan', products: [
    { name: old.name, card_type: 'credit', url: `${PAGE}?a=1&b=2#new` },
    { name: '선불 제외', card_type: 'prepaid', url: `${PAGE}?prepaid=1` },
  ] }] };
  const jobs = makeJobs([old], seeds, issuers);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].existingId, old.id);
  assert.equal(jobs[0].url, `${PAGE}?a=1&b=2`);
});

test('unofficial source candidates and seed URLs never enter accepted jobs', () => {
  const foreign = 'https://cards.example.invalid/product';
  assert.throws(() => makeJobs([], { issuers: [{ issuer: 'shinhan', products: [{ name: '외부', card_type: 'credit', url: foreign }] }] }, issuers), /Unofficial/);
  const candidate = fresh();
  candidate.source.url = foreign;
  assert.ok(assessCandidate(candidate, card(), schema, issuers).length);
});

test('a new product ID cannot silently overwrite a different source URL', () => {
  const previous = card();
  const incoming = fresh(previous);
  incoming.source.url = `${PAGE}?different_product=1`;
  const original = { schema_version: 1, generated_at: '2026-07-31', cards: [previous] };
  assert.throws(() => mergeAccepted(original, [{ card: incoming }], '2026-09-21'), /Conflicting/);
  assert.equal(original.cards[0].source.url, PAGE);
});

test('known per-benefit numeric limits cannot disappear during a refresh', () => {
  const previous = card();
  const candidate = fresh(previous);
  for (const benefit of candidate.benefits) {
    delete benefit.rate_pct;
    delete benefit.monthly_cap_krw;
    delete benefit.requires_prev_month_spend_krw;
  }
  assert.ok(assessCandidate(candidate, previous, schema, issuers).length);
});

test('a different product name requires rejection or explicit identity review', () => {
  const previous = card();
  const candidate = fresh(previous);
  candidate.name = '신한카드 전혀 다른 상품';
  assert.ok(assessCandidate(candidate, previous, schema, issuers).length);
});

test('an older cached page cannot replace a more recently verified record', () => {
  assert.ok(assessCandidate(card(), fresh(), schema, issuers).length);
});

test('unresolved client templates inside benefits reject a candidate', () => {
  const previous = card();
  const candidate = fresh(previous);
  candidate.benefits[0].title = '{{ product.benefitName }}';
  assert.ok(assessCandidate(candidate, previous, schema, issuers).length);
});

test('duplicate original IDs are reported instead of disappearing in Map construction', () => {
  const original = { schema_version: 1, generated_at: '2026-07-31', cards: [card(), card()] };
  assert.throws(() => mergeAccepted(original, [], '2026-09-21'), /duplicate|중복/i);
});
