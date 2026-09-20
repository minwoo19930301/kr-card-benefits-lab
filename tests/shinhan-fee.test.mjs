import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { enrichShinhanFee } from '../scripts/lib/shinhan-fee.mjs';
const card = { issuer: 'shinhan', name: '신한카드 처음', product_url: 'https://www.shinhancard.com/pconts/html/card/apply/credit/1227020_2207.html', source: { retrieved_at: '2026-09-20' } };
const html = "getCardDetailInfo({pageId : '202404150001'});<li>가족카드는 신청할 수 없습니다.</li>";
const fee = (name, total, brand = '0') => ({ afeName: name, allAmountOrigin: total, basicAmountOrigin: 7000, aflAmountOrigin: 8000, afeCode: '1', cardBrandCode: brand });
const product = { cardProductEntryId: '202404150001', cardProductEntryName: card.name, cardProductUrl: '/pconts/html/card/apply/credit/1227020_2207.html', afeInfoList: [fee('기본', 15000), fee('기본', 18000, '1')] };
const opts = (p = product) => ({ fetchImpl: async () => new Response(JSON.stringify({ status: '200', payload: { cardProduct: p } })) });

test('verified no-family product uses total annual fee and keeps main source date', async () => {
  const r = await enrichShinhanFee(card, html, opts());
  assert.equal(r.enriched, true); assert.equal(r.card.annual_fee_krw, 15000);
  assert.equal(r.card.source.retrieved_at, card.source.retrieved_at);
  assert.equal(card.annual_fee_krw, undefined);
  assert.match(r.card.annual_fee_note, /Mastercard 기본 18,000원/);
  assert.equal(r.evidence.transport, 'direct_official_http'); assert.match(r.evidence.sha256, /^[a-f0-9]{64}$/);
});
test('unknown holder is not inferred from basic/general fee label', async () => {
  const r = await enrichShinhanFee(card, html.replace('<li>가족카드는 신청할 수 없습니다.</li>', ''), opts());
  assert.equal(r.enriched, false); assert.equal(r.reason, 'fee_holder_unknown'); assert.equal(r.evidence.fees.length, 2);
});
test('explicit primary and family rows exclude family amounts', async () => {
  const r = await enrichShinhanFee(card, html, opts({ ...product, afeInfoList: [fee('본인', 30000), fee('가족', 0)] }));
  assert.equal(r.card.annual_fee_krw, 30000);
});
test('entry, product name and official path must all match', async () => {
  for (const p of [{ cardProductEntryId: '999999999999' }, { cardProductEntryName: '신한카드 다른상품' }, { cardProductUrl: '/other.html' }, { cardProductUrl: 'https://evil.example/pconts/html/card/apply/credit/1227020_2207.html' }]) {
    const r = await enrichShinhanFee(card, html, opts({ ...product, ...p })); assert.equal(r.reason, 'fee_identity_mismatch');
  }
});
test('invalid totals never become zero or basic component fee', async () => {
  for (const total of [null, undefined, '15000', -1, 1.5]) {
    const r = await enrichShinhanFee(card, html, opts({ ...product, afeInfoList: [fee('본인', total)] })); assert.equal(r.reason, 'fee_total_invalid');
  }
});
test('cache preserves retrieval time, rejects tampering and avoids repeated GETs', async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'shinhan-fee-'));
  try {
    let calls = 0; const config = { cacheDir, fetchImpl: async (...args) => { calls++; return opts().fetchImpl(...args); } };
    const a = await enrichShinhanFee(card, html, config); const b = await enrichShinhanFee(card, html, config);
    assert.equal(calls, 1); assert.equal(b.evidence.cacheHit, true); assert.equal(a.evidence.retrievedAt, b.evidence.retrievedAt);
    const f = path.join(cacheDir, (await readdir(cacheDir))[0]); const d = JSON.parse(await readFile(f));d.body += ' ';await writeFile(f, JSON.stringify(d));
    await enrichShinhanFee(card, html, config); assert.equal(calls, 2);
  } finally { await rm(cacheDir, { recursive: true, force: true }); }
});
test('missing page IDs and HTTP/network failure preserve the original card', async () => {
  assert.equal((await enrichShinhanFee(card, '', opts())).reason, 'missing_page_id');
  for (const fetchImpl of [async () => new Response('error', { status: 500 }), async () => { throw new Error('failure'); }]) {
    const r = await enrichShinhanFee(card, html, { fetchImpl }); assert.equal(r.card, card); assert.equal(r.enriched, false);
  }
});
