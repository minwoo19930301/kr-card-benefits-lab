import test from 'node:test';
import assert from 'node:assert/strict';

import { parseHyundaiAnnualFee, parseHyundaiDetail } from '../scripts/collect-issuer-rendered.mjs';

// 실제 공식 페이지에서 관측한 연회비 표기
const SUMMIT_CE_FEE =
  '연회비 국내외겸용(Visa Platinum/Amex Platinum) 80,000원 (기본연회비 20,000원 + 제휴연회비 60,000원) ' +
  '가족카드 20,000원(기본연회비 0원 + 제휴연회비 20,000원) 국내전용 80,000원 (기본연회비 20,000원 + 제휴연회비 60,000원)';

const ZERO_UP_FEE =
  '연회비 국내외겸용(Visa Platinum/Amex Platinum) 30,000원 (기본연회비 10,000원 + 제휴연회비 20,000원) ' +
  '가족카드 10,000원(기본연회비 0원 + 제휴연회비 10,000원) 국내전용 30,000원 (기본연회비 10,000원 + 제휴연회비 20,000원)';

test('parseHyundaiAnnualFee: 본인 카드 총 연회비를 취한다', () => {
  assert.equal(parseHyundaiAnnualFee(SUMMIT_CE_FEE), 80000);
  assert.equal(parseHyundaiAnnualFee(ZERO_UP_FEE), 30000);
});

test('parseHyundaiAnnualFee: 가족카드·기본연회비 분해값을 취하지 않는다', () => {
  // 가족카드 20,000원 이나 기본연회비 0원 을 잡으면 안 된다
  assert.notEqual(parseHyundaiAnnualFee(SUMMIT_CE_FEE), 20000);
  assert.notEqual(parseHyundaiAnnualFee(SUMMIT_CE_FEE), 0);
});

test('parseHyundaiAnnualFee: 혜택 문구의 무료/면제를 연회비 0 으로 오독하지 않는다', () => {
  // 실제로 이 문구 때문에 연회비가 0 으로 기록되는 버그가 있었다
  const benefitText = '보너스 리워드 1만 M포인트 적립 커피 1,000원 할인 + 주말 무료 주차';
  assert.equal(parseHyundaiAnnualFee(benefitText), null, '금액 근거가 없으면 null 이어야 한다');
  assert.equal(parseHyundaiAnnualFee('무료 주차 제공 무료 발렛'), null);
  assert.equal(parseHyundaiAnnualFee('연회비 없음'), 0, '명시적 문구만 0 으로 인정');
  assert.equal(parseHyundaiAnnualFee('연회비 면제'), 0);
});

const DETAIL_FIXTURE = `<html><head><title>현대카드 Summit CE-현대카드</title></head><body>
<div class="section">${SUMMIT_CE_FEE}</div>
<div class="item_wrap">
  <div class="item_area">
    <div class="cate_tit"><p class="h3_b_lt">기본 혜택</p></div>
    <div class="item bg_type1">
      <div class="item_tit"><em class="h3_b_lt">국내외 가맹점</em><p class="h0_b_lt_size40">1.5% M포인트 적립</p></div>
      <div class="item_cont"><div class="sub_txt"><p class="h4_m">전월 이용 금액 50만원 이상 시</p></div>
      <div class="img_area logo w148"></div></div>
    </div>
    <div class="item bg_type1">
      <div class="item_tit"><em class="h3_b_lt">백화점, 호텔</em><p class="h0_b_lt_size40">15만원권 바우처 제공</p></div>
      <div class="item_cont"><div class="sub_txt"><p class="h4_m">발급 첫해 : 누적 이용 금액 100만원 이상 시</p></div>
      <div class="img_area logo w148"></div></div>
    </div>
  </div>
</div></body></html>`;

test('parseHyundaiDetail: 카드명·연회비·혜택을 추출한다', () => {
  const { card, warnings } = parseHyundaiDetail(DETAIL_FIXTURE, {
    pageUrl: 'https://www.hyundaicard.com/cpc/cr/CPCCR0201_01.hc?cardWcd=BTMCE',
    retrievedAt: '2026-07-31',
  });
  assert.ok(card, warnings.join('; '));
  assert.equal(card.name, '현대카드 Summit CE', '제목에서 "-현대카드" 접미를 떼야 한다');
  assert.equal(card.issuer, 'hyundai');
  assert.equal(card.annual_fee_krw, 80000);
  assert.equal(card.card_type, 'credit');
  assert.equal(card.source.kind, 'issuer_official_page');
  assert.equal(card.benefits.length, 2);

  const basic = card.benefits[0];
  assert.equal(basic.rate_pct, 1.5);
  assert.equal(basic.requires_prev_month_spend_krw, 500000);
});

test('parseHyundaiDetail: 누적 이용금액을 전월실적으로 기록하지 않는다', () => {
  const { card } = parseHyundaiDetail(DETAIL_FIXTURE, {
    pageUrl: 'https://www.hyundaicard.com/cpc/cr/CPCCR0201_01.hc?cardWcd=BTMCE',
    retrievedAt: '2026-07-31',
  });
  const voucher = card.benefits[1];
  assert.equal(
    voucher.requires_prev_month_spend_krw,
    undefined,
    '"누적 이용 금액 100만원" 은 전월 실적이 아니다',
  );
});

test('parseHyundaiDetail: 카드명을 못 읽으면 수록하지 않는다', () => {
  const { card } = parseHyundaiDetail('<html><head><title>현대카드</title></head><body></body></html>', {
    pageUrl: 'https://www.hyundaicard.com/cpc/cr/CPCCR0201_01.hc?cardWcd=X',
    retrievedAt: '2026-07-31',
  });
  assert.equal(card, null);
});

test('parseHyundaiDetail: 혜택 블록이 없으면 수록하지 않는다', () => {
  const { card } = parseHyundaiDetail(
    '<html><head><title>테스트카드-현대카드</title></head><body>연회비 없음</body></html>',
    { pageUrl: 'https://www.hyundaicard.com/cpc/cr/CPCCR0201_01.hc?cardWcd=Y', retrievedAt: '2026-07-31' },
  );
  assert.equal(card, null);
});


test('rendered tracking attributes preserve Hyundai benefits and conditions', () => {
  const html = DETAIL_FIXTURE.replaceAll('class="item_tit"', 'data-trg-fired="false" class="item_tit" aria-hidden="false"').replaceAll('class="sub_txt"', 'class="sub_txt" data-trg-fired="false"');
  const options = { pageUrl: 'https://www.hyundaicard.com/cpc/cr/CPCCR0201_01.hc?cardWcd=BTMCE', retrievedAt: '2026-09-21' };
  assert.deepEqual(parseHyundaiDetail(html, options), parseHyundaiDetail(DETAIL_FIXTURE, options));
});
