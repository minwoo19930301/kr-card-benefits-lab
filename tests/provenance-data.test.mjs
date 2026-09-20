import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const read = async name => JSON.parse(await readFile(new URL(`../data/${name}`, import.meta.url), 'utf8'));

test('published collection counts and content hash match accepted evidence', async () => {
  const [corpus, report, evidence] = await Promise.all(['cards.json', 'collection-report.json', 'collection-evidence.json'].map(read));
  assert.equal(report.run_id, evidence.run_id);
  assert.equal(report.corpus_sha256, createHash('sha256').update(JSON.stringify(corpus)).digest('hex'));
  assert.ok(report.request_count <= report.request_limit);
  assert.equal(report.accepted_count, evidence.records.filter(r => r.status === 'accepted').length);
  for (const row of report.issuer_reports) {
    const records = evidence.records.filter(r => r.issuer === row.issuer);
    assert.equal(row.succeeded, records.filter(r => r.status === 'accepted').length);
    assert.equal(row.failed, records.filter(r => ['failed', 'rejected'].includes(r.status)).length);
    assert.equal(row.skipped, records.filter(r => r.status === 'skipped').length);
  }
  const cards = new Map(corpus.cards.map(c => [c.id, c]));
  for (const record of evidence.records.filter(r => r.status === 'accepted')) {
    const card = cards.get(record.card_id);
    assert.ok(card, `Accepted card ${record.card_id} is missing`);
    assert.equal(card.source.url, record.url);
    assert.match(record.sha256, /^[a-f0-9]{64}$/);
    assert.ok(record.bytes > 0);
    assert.ok((report.transports ?? [report.transport]).includes(record.transport));
    if(record.transport === 'direct_official_api') {
      assert.equal(record.issuer, 'woori');
      assert.equal(record.supplemental_evidence.endpoint, 'https://pc.wooricard.com/dcpc/yh1/crd/crd01/searchCrdDtl.pwkjson');
      assert.equal(new URL(record.url).searchParams.get('cdPrdCd'), record.supplemental_evidence.request_product_id);
      assert.equal(record.supplemental_evidence.hash_scope, 'resultVo');
    }
  }
});

test('tax events retain official sources, acquisition dates and eligibility conditions', async () => {
  const { events } = await read('card-events.json');
  const domains = new Set(['www.shinhancard.com', 'card.kbcard.com', 'www.hanacard.co.kr', 'card.nonghyup.com', 'www.hyundaicard.com', 'nm.wooricard.com', 'web.paybooc.co.kr']);
  const seen = new Set();
  for (const event of events) {
    assert.ok(!seen.has(event.id)); seen.add(event.id);
    const url = new URL(event.url);
    assert.equal(url.protocol, 'https:'); assert.ok(domains.has(url.hostname));
    for (const key of ['starts_at', 'ends_at', 'checked_at']) assert.match(event[key], /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(event.starts_at <= event.ends_at);
    assert.ok(event.conditions.length >= 2);
  }
});
