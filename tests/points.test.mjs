import test from 'node:test';
import assert from 'node:assert/strict';

import { parseTierCapRows, extractMonthlyCapPoints } from '../scripts/collect-issuer-feed.mjs';
import {
  computePickingRate,
  pickingCaveat,
  PICKING_STATUS,
  POINT_TO_KRW_ASSUMPTION,
} from '../site/picking.js';

test('extractMonthlyCapPoints: 포인트 단위 월 한도를 읽는다', () => {
  assert.equal(extractMonthlyCapPoints('교육, 병원 5% M포인트 적립 (월 1만 M포인트 한도)'), 10000);
  assert.equal(extractMonthlyCapPoints('롯데백화점 10% M포인트 적립 (월 4만 M포인트 한도)'), 40000);
  assert.equal(extractMonthlyCapPoints('월 2,000포인트 한도'), 2000);
  assert.equal(extractMonthlyCapPoints('월 5천원 한도'), null, '원화 표기는 포인트가 아니다');
  assert.equal(extractMonthlyCapPoints('한도 없음'), null);
});

test('parseTierCapRows: 신한카드 형식(전월 이용금액 / 할인한도)을 읽는다', () => {
  const html = `
    <table>
      <thead><tr><th>전월 이용금액</th><th>할인한도</th></tr></thead>
      <tbody>
        <tr><td>30만원 이상<br>50만원 미만</td><td>3천원</td></tr>
        <tr><td>50만원 이상<br>100만원 미만</td><td>7천원</td></tr>
        <tr><td>100만원 이상</td><td>1만원</td></tr>
      </tbody>
    </table>`;
  assert.deepEqual(parseTierCapRows(html), [
    { tier: 300000, cap: 3000 },
    { tier: 500000, cap: 7000 },
    { tier: 1000000, cap: 10000 },
  ]);
});

test("parseTierCapRows: '월 이용금액 한도' 열을 할인 한도로 읽지 않는다", () => {
  // 신한카드 Deep Oil 의 실제 표. '주유서비스 월 이용금액 한도 15만원' 은
  // 할인 금액이 아니라 할인 대상 이용금액의 상한이다. 할인 한도로 읽으면 10배 과대추정된다.
  const html = `
    <table>
      <thead><tr><th>구분</th><th>주유서비스 월 이용금액 한도</th><th>영화서비스 월 제공횟수 한도</th></tr></thead>
      <tbody>
        <tr><td>전월 이용 금액</td><td>30만원 이상 70만원 미만</td><td>15만원</td><td>1회</td></tr>
        <tr><td>70만원 이상</td><td>30만원</td><td>2회</td></tr>
      </tbody>
    </table>`;
  assert.deepEqual(parseTierCapRows(html), [], '이용금액 한도 열은 배제되어야 한다');
});

test('computePickingRate: 포인트 한도를 1:1 가정으로 포함하고 그 사실을 알린다', () => {
  const card = {
    prev_month_spend_tiers_krw: [500000],
    benefits: [
      { monthly_cap_points: 10000 },
      { monthly_cap_points: 20000 },
    ],
  };
  const r = computePickingRate(card);
  assert.equal(r.status, PICKING_STATUS.OK);
  assert.equal(r.basis, 'summed_caps_with_points');
  assert.equal(r.usesPointAssumption, true);
  assert.equal(r.pointCappedCount, 2);
  assert.equal(r.estimatedKrw, 30000 * POINT_TO_KRW_ASSUMPTION);
  assert.equal(r.pct, 6);
  assert.match(pickingCaveat(r), /포인트/);
  assert.match(pickingCaveat(r), /1포인트를 1원/);
});

test('computePickingRate: 원화 한도가 있으면 포인트 한도를 중복으로 더하지 않는다', () => {
  const card = {
    prev_month_spend_tiers_krw: [300000],
    benefits: [{ monthly_cap_krw: 5000, monthly_cap_points: 5000 }],
  };
  const r = computePickingRate(card);
  assert.equal(r.estimatedKrw, 5000, '같은 혜택을 두 번 세지 않아야 한다');
  assert.equal(r.usesPointAssumption, false);
  assert.equal(r.basis, 'summed_benefit_caps');
});

test('computePickingRate: 통합 한도가 있으면 포인트 가정을 쓰지 않는다', () => {
  const card = {
    prev_month_spend_tiers_krw: [300000],
    integrated_monthly_cap_krw: 20000,
    benefits: [{ monthly_cap_points: 99999 }],
  };
  const r = computePickingRate(card);
  assert.equal(r.basis, 'integrated_cap');
  assert.equal(r.usesPointAssumption, false);
  assert.equal(r.estimatedKrw, 20000);
});

test('computePickingRate: 포인트 한도만 있고 실적 구간이 없으면 계산하지 않는다', () => {
  const r = computePickingRate({ benefits: [{ monthly_cap_points: 10000 }] });
  assert.equal(r.status, PICKING_STATUS.INSUFFICIENT_DATA);
  assert.equal(r.pct, null);
});
