import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseExtraDetail } from '../scripts/parse-official-extra.mjs';

const { fragments } = JSON.parse(readFileSync(new URL('./fixtures/official-extra.json', import.meta.url), 'utf8'));
const origins = { kb: 'card.kbcard.com', hana: 'www.hanacard.co.kr', nh: 'card.nonghyup.com', lotte: 'www.lottecard.co.kr', bc: 'www.bccard.com', samsung: 'www.samsungcard.com' };
const options = (issuerKey, extra = {}) => ({ issuerKey, pageUrl: `https://${origins[issuerKey]}/official-product`, retrievedAt: '2026-09-21', ...extra });
const parse = (key, issuer, extra) => parseExtraDetail(fragments[key], options(issuer, extra));

test('KB domestic mobile-only fee is explicit; mixed telecom/OTT percentages are not generalized', () => {
  const { card } = parse('kb', 'kb');
  assert.equal(card.name, 'My WE:SH 카드');
  assert.equal(card.card_type, 'credit');
  assert.equal(card.annual_fee_krw, 9000);
  assert.match(card.annual_fee_note, /모바일단독/);
  const mixed = card.benefits.find((b) => /OTT/.test(b.title));
  assert.match(mixed.title, /10%.*30%/);
  assert.equal(mixed.rate_pct, undefined);
});

test('Hana uses current heading, not commented placeholder; family/base fees never become total', () => {
  const { card } = parse('hanaPrime', 'hana');
  assert.equal(card.name, 'JADE Prime');
  assert.equal(card.annual_fee_krw, 295000);
  assert.notEqual(card.annual_fee_krw, 25000);
});

test('different Hana FREE and FREE+ products have different IDs and configurable fees stay unknown', () => {
  const plus = parse('hanaFreePlus', 'hana').card;
  const base = parse('hanaFree', 'hana').card;
  assert.equal(plus.name, '원더카드 2.0 FREE+');
  assert.equal(base.name, '원더카드 2.0 FREE');
  assert.notEqual(plus.id, base.id);
  assert.match(plus.id, /plus/);
  assert.equal(plus.annual_fee_krw, undefined);
});

test('NH eligibility table confirms credit; domestic mobile total excludes family and base fees', () => {
  const { card } = parse('nhWonderful', 'nh');
  assert.equal(card.name, 'NH올원더풀카드');
  assert.equal(card.card_type, 'credit');
  assert.equal(card.annual_fee_krw, 22000);
  assert.match(card.annual_fee_note, /모바일카드.*일반카드/);
});

test('NH explicit check-card name works; FLEX is not arbitrarily assigned credit', () => {
  assert.equal(parse('nhCheck', 'nh').card.card_type, 'check');
  const unknown = parse('nhFlex', 'nh');
  assert.equal(unknown.card, null);
  assert.match(unknown.warnings.join(' '), /구분 미확인/);
  const authorizedType = parse('nhFlex', 'nh', { cardType: 'credit' }).card;
  assert.equal(authorizedType.annual_fee_krw, 4000);
  assert.match(authorizedType.benefits[0].notes.join(' '), /가맹점.*미확인/);
});

test('Lotte discontinued card is rejected even when it remains in official catalog', () => {
  assert.equal(parse('lotte', 'lotte').card.annual_fee_krw, 20000);
  const result = parse('lotteStopped', 'lotte');
  assert.equal(result.card, null);
  assert.match(result.warnings.join(' '), /발급 중단/);
});

test('BC primary headline facts are retained, and terms absent from extraction are declared unknown', () => {
  const { card } = parse('bc', 'bc', { expectedName: '[BC바로] 페이북카드' });
  assert.equal(card.name, '페이북카드');
  assert.equal(card.annual_fee_krw, 15000);
  assert.equal(card.benefits[0].rate_pct, 1);
  assert.match(card.benefits[0].notes.join(' '), /전월실적과 제외 조건은 미확인/);
});

test('Samsung payload scalar is read without execution and overseas fee is not called domestic', () => {
  // Shape from the retrieved Nuxt payload; this intentionally contains executable
  // syntax that a parser must never evaluate.
  const payload = '<script>window.__NUXT__=(function(a,b,c){throw new Error("must never execute");return{pdDtInfo:{chkcdYn:b}}}("","N",Array(17)));</script>';
  const { card } = parseExtraDetail(fragments.samsung + payload, options('samsung'));
  assert.equal(card.card_type, 'credit');
  assert.equal(card.name, '삼성 iD AUTO 카드');
  assert.equal(card.annual_fee_krw, undefined);
  assert.match(card.annual_fee_note, /해외/);
  assert.ok(card.benefits.every((b) => !/카드이용TIP|카드 디자인/.test(b.title)));
});

test('unknown financial fields are never invented and every summary discloses missing conditions', () => {
  for (const [key, issuer] of [['kb', 'kb'], ['hanaPrime', 'hana'], ['nhWonderful', 'nh'], ['lotte', 'lotte'], ['bc', 'bc']]) {
    const { card } = parse(key, issuer);
    assert.equal(card.tax, undefined);
    assert.equal(card.prev_month_spend_tiers_krw, undefined);
    assert.equal(card.integrated_monthly_cap_krw, undefined);
    assert.ok(card.benefits.every((b) => b.monthly_cap_krw === undefined && b.notes.length));
  }
});

test('mismatched product, wrong issuer domain, contradictory type, and error pages are rejected', () => {
  assert.equal(parse('kb', 'kb', { expectedName: 'Some other product' }).card, null);
  assert.equal(parse('kb', 'kb', { pageUrl: 'https://example.com/card' }).card, null);
  assert.equal(parse('kb', 'kb', { cardType: 'check' }).card, null);
  assert.equal(parseExtraDetail('<html>Service unavailable</html>', options('kb')).card, null);
});
