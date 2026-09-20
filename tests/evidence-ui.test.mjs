import test from 'node:test';
import assert from 'node:assert/strict';
import { freshness, taxState, taxLabel, reviewLabel, coverageRows, eventPeriod } from '../site/evidence.js';
import { emptyFilters, matches } from '../site/filters.js';

const card = (extra = {}) => ({ issuer: 'shinhan', name: '테스트 카드', card_type: 'check', benefits: [], ...extra });
const filters = (extra = {}) => ({ ...emptyFilters(), ...extra });

test('세금 실적과 적립 필터는 서로 독립이며 미기재는 제외와 다르다', () => {
  const c = card({ tax: { counts_as_spend: true, earns_rewards: false } });
  assert.equal(matches(c, filters({ taxSpend: 'yes', taxRewards: 'no' })), true);
  assert.equal(matches(c, filters({ taxSpend: 'yes', taxRewards: 'yes' })), false);
  assert.equal(matches(card(), filters({ taxSpend: 'unknown', taxRewards: 'unknown' })), true);
  assert.equal(matches(card(), filters({ taxSpend: 'no' })), false);
  assert.equal(matches(card({ tax: {} }), filters({ taxRewards: 'no' })), false);
  assert.equal(taxState(card({ tax: { earns_rewards: 'false' } }), 'earns_rewards'), 'unknown');
  assert.equal(taxLabel(c, 'counts_as_spend'), '실적 포함');
  assert.equal(taxLabel(card(), 'earns_rewards'), '미확인');
});

test('확인일은 생성일·갱신일로 대체하지 않고 30일 경계와 미래·잘못된 날짜를 구분한다', () => {
  const day = '2026-09-21';
  assert.equal(freshness(card({ source: { retrieved_at: '2026-08-22' } }), day).key, 'fresh');
  assert.equal(freshness(card({ source: { retrieved_at: '2026-08-21' } }), day).key, 'stale');
  assert.equal(freshness(card({ updated_at: day }), day).key, 'unknown');
  for (const value of ['2026-09-22', '2026-02-30', '', 'bad date']) {
    assert.equal(freshness(card({ source: { retrieved_at: value } }), day).key, 'unknown');
  }
  assert.equal(matches(card({ source: { retrieved_at: '2026-07-31' } }), filters({ freshness: 'fresh', today: day })), false);
});

test('한글 카드사와 카드 종류를 검색하고 초기화 상태는 전체를 통과시킨다', () => {
  assert.equal(matches(card(), filters({ q: '  신한   체크 ' })), true);
  assert.equal(matches(card(), filters({ q: '신한 신용' })), false);
  assert.equal(matches(card(), emptyFilters()), true);
});

test('자동 추출과 사람 검수를 구분한다', () => {
  assert.match(reviewLabel(card({ review_status: 'machine_extracted' })), /검수 전/);
  assert.match(reviewLabel(card({ review_status: 'human_reviewed' })), /사람/);
  assert.match(reviewLabel(card()), /미확인/);
  assert.equal(matches(card({ review_status: 'machine_extracted' }), filters({ reviewStatus: 'human_reviewed' })), false);
});

test('보고서 없음·수집 실패·이전 자료 보존을 미수집이나 성공으로 뭉개지 않는다', () => {
  const issuers = [{ key: 'shinhan', name: '신한카드' }, { key: 'kb', name: 'KB국민카드', status_reason: '미수집 사유' }];
  const without = coverageRows([card()], issuers, null);
  assert.deepEqual(without.map((row) => [row.count, row.label]), [[1, '실행 기록 없음'], [0, '실행 기록 없음']]);
  assert.equal(without[1].note, '미수집 사유');
  const report = { issuer_reports: [{ issuer: 'shinhan', status: 'failed', attempted: 1, failed: 1, retained_cards: 1, note: '타임아웃' }] };
  const [row] = coverageRows([card()], issuers, report);
  assert.equal(row.label, '수집 실패');
  assert.equal(row.count, 1);
  assert.equal(row.run.retained_cards, 1);
  assert.equal(row.note, '타임아웃');
  assert.equal(coverageRows([], issuers, { issuer_reports: null }).length, 2);
});

test('행사는 기간 종료일까지만 진행 중이고 미래·만료·기간 미확인은 구분한다', () => {
  const event = { starts_at: '2026-09-01', ends_at: '2026-09-20' };
  assert.equal(eventPeriod(event, '2026-09-20'), 'active');
  assert.equal(eventPeriod(event, '2026-09-21'), 'expired');
  assert.equal(eventPeriod(event, '2026-08-31'), 'upcoming');
  assert.equal(eventPeriod({ starts_at: event.starts_at }, '2026-09-21'), 'unknown');
  assert.equal(eventPeriod({ starts_at: '2026-09-30', ends_at: '2026-09-01' }, '2026-09-21'), 'unknown');
});
