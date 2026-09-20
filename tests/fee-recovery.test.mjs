import test from 'node:test';
import assert from 'node:assert/strict';
import { parseShinhanDetail } from '../scripts/collect-issuer-rendered.mjs';

const options = {
  pageUrl: 'https://www.shinhancard.com/pconts/html/card/apply/credit/1187937_2207.html',
  retrievedAt: '2026-09-21', cardType: 'credit',
};
function page(fee, extra = '') {
  return `<html><head><title>신한카드 Deep Oil | 카드 | 신한카드</title></head><body>
    <div>연회비 ${fee} 주요 혜택</div>
    <ul><li class="benefit-list__item"><p class="item--text-title">주유 10% 할인</p>
      <ul class="item--text-desc"><li>전월 이용금액 30만원 이상</li></ul><div class="item--image"></div></li></ul>
    <footer>${extra}</footer></body></html>`;
}

test('미해결 연회비 템플릿은 페이지 다른 영역의 면제 문구로 0원이 되지 않는다', () => {
  const { card, warnings } = parseShinhanDetail(page('{{card.annualFee}}', '가족카드 연회비 면제. 일부 고객은 연회비 면제 대상입니다.'), options);
  assert.ok(card);
  assert.equal(card.annual_fee_krw, undefined);
  assert.ok(warnings.some(w => /연회비 파싱 불가/.test(w)));
});

test('연회비 영역의 브랜드 미해결 템플릿 뒤 면제 안내도 명시적 0원으로 해석하지 않는다', () => {
  const { card } = parseShinhanDetail(page('VISA {{fee}} 가족카드 연회비 면제'), options);
  assert.equal(card.annual_fee_krw, undefined);
});

test('실제 본인 연회비를 읽었으면 다른 영역 면제 안내와 무관하게 금액을 유지한다', () => {
  const { card } = parseShinhanDetail(page('국내전용 10,000원', '특정 제휴회원 연회비 면제'), options);
  assert.equal(card.annual_fee_krw, 10000);
});

test('해당 상품 연회비 영역이 없음 또는 면제로 시작할 때만 0원을 인정한다', () => {
  for (const fee of ['없음', '면제']) {
    assert.equal(parseShinhanDetail(page(fee), options).card.annual_fee_krw, 0);
  }
});
