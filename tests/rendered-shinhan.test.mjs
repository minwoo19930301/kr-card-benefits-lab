import test from 'node:test';
import assert from 'node:assert/strict';

import { parseKrwLoose, parseKrw } from '../scripts/collect-issuer-feed.mjs';
import { parseShinhanDetail, parseHyundaiDetail } from '../scripts/collect-issuer-rendered.mjs';

test('parseKrwLoose: 한글 단위 조합을 읽는다', () => {
  // 신한카드가 연회비를 이 형식으로 표기한다
  assert.equal(parseKrwLoose('1만8천원'), 18000);
  assert.equal(parseKrwLoose('1만5천원'), 15000);
  assert.equal(parseKrwLoose('8천원'), 8000);
  assert.equal(parseKrwLoose('3만원'), 30000);
  assert.equal(parseKrwLoose('30,000원'), 30000);
});

test('parseKrwLoose: parseKrw 가 거부하는 손상 값은 그대로 거부한다', () => {
  assert.equal(parseKrwLoose('16,0'), null);
  assert.equal(parseKrwLoose('50만원 이상'), null);
  assert.equal(parseKrwLoose('1만점'), null);
  assert.equal(parseKrwLoose('원'), null);
  assert.equal(parseKrw('1만8천원'), null, 'parseKrw 자체 동작은 바뀌지 않아야 한다');
});

// ------------------------------------------------------------------ 신한카드

const SHINHAN_FIXTURE = `<html><head><title>신한카드 Mr.Life | 카드 | 신한카드</title></head><body>
<div class="fee">연회비 Visa 1만8천원 (기본) S&amp; 1만5천원 (기본)</div>
<div>신규 고객 전용 이벤트 연회비 100% 캐시백</div>
<div id="cardDetailTab1">
<ul class="benefit-list">
  <li class="benefit-list__item"><button type="button">
    <div class="item--text">
      <p class="item--text-title">월납(공과금) 할인</p>
      <ul class="shc-ul item--text-desc" data-type="dot"><li>전기요금, 도시가스요금, 통신요금 10% 할인</li></ul>
    </div>
    <div class="item--image"><span class="icon--benefit utilities"></span></div>
  </button></li>
  <li class="benefit-list__item"><button type="button">
    <div class="item--text">
      <p class="item--text-title">TIME 할인</p>
      <ul class="shc-ul item--text-desc" data-type="dot"><li>365일 24시간 10% 할인서비스(편의점, 병원/약국)</li>
      <li>전월 이용금액 30만원 이상 시 월 1만원 한도</li></ul>
    </div>
    <div class="item--image"></div>
  </button></li>
</ul></div></body></html>`;

test('parseShinhanDetail: 카드명에서 접미 메뉴 경로를 떼어낸다', () => {
  const { card } = parseShinhanDetail(SHINHAN_FIXTURE, {
    pageUrl: 'https://www.shinhancard.com/pconts/html/card/apply/credit/1187937_2207.html',
    retrievedAt: '2026-07-31',
  });
  assert.equal(card.name, '신한카드 Mr.Life');
  assert.equal(card.issuer, 'shinhan');
  assert.match(card.id, /^shinhan-/);
});

test('parseShinhanDetail: 브랜드별 연회비 중 최저값을 취한다', () => {
  const { card } = parseShinhanDetail(SHINHAN_FIXTURE, {
    pageUrl: 'https://www.shinhancard.com/pconts/html/card/apply/credit/1187937_2207.html',
    retrievedAt: '2026-07-31',
  });
  // Visa 1만8천원 / S& 1만5천원 → 15,000
  assert.equal(card.annual_fee_krw, 15000);
});

test('parseShinhanDetail: 중첩 리스트에도 혜택을 모두 추출한다', () => {
  const { card } = parseShinhanDetail(SHINHAN_FIXTURE, {
    pageUrl: 'https://www.shinhancard.com/pconts/html/card/apply/credit/1187937_2207.html',
    retrievedAt: '2026-07-31',
  });
  assert.equal(card.benefits.length, 2, '항목 <li> 안에 <ul><li> 가 중첩돼도 2건이 나와야 한다');
  assert.equal(card.benefits[0].title, '월납(공과금) 할인');
  assert.equal(card.benefits[0].category, 'utility');
  assert.equal(card.benefits[0].rate_pct, 10);

  const time = card.benefits[1];
  assert.equal(time.title, 'TIME 할인');
  assert.equal(time.monthly_cap_krw, 10000);
  assert.equal(time.requires_prev_month_spend_krw, 300000);
});

test('parseShinhanDetail: 체크카드 이름이면 card_type 을 check 로 둔다', () => {
  const html = SHINHAN_FIXTURE.replace('신한카드 Mr.Life |', '신한카드 처음 체크 |');
  const { card } = parseShinhanDetail(html, {
    pageUrl: 'https://www.shinhancard.com/pconts/html/card/apply/check/1_1.html',
    retrievedAt: '2026-07-31',
    cardType: 'credit',
  });
  assert.equal(card.card_type, 'check');
});

test('parseShinhanDetail: 혜택 목록이 없으면 수록하지 않는다', () => {
  const { card } = parseShinhanDetail(
    '<html><head><title>신한카드 X | 카드 | 신한카드</title></head><body>연회비 1만원</body></html>',
    { pageUrl: 'https://www.shinhancard.com/pconts/html/card/apply/credit/1_1.html', retrievedAt: '2026-07-31' },
  );
  assert.equal(card, null);
});

// ------------------------------------------------------------------ 현대카드 레이아웃 변형

/** item_cont / img_area 가 없는 변형 레이아웃. 초기 구현은 이 형태를 전부 건너뛰었다. */
const HYUNDAI_VARIANT = `<html><head><title>the Purple-현대카드</title></head><body>
<div class="section">연회비 국내외겸용(Visa Signature) 1,000,000원 (기본연회비 200,000원 + 제휴연회비 800,000원)</div>
<div class="card_benefit type02">
  <div class="item_tit"><em>Priority Pass 카드</em><p>전 세계 공항 라운지 무료 이용</p></div>
  <div class="item_tit"><em>발레파킹 서비스</em><p>인천국제공항 무료 발레파킹</p></div>
</div></body></html>`;

test('parseHyundaiDetail: item_cont 가 없는 레이아웃에서도 혜택을 뽑는다', () => {
  const { card, warnings } = parseHyundaiDetail(HYUNDAI_VARIANT, {
    pageUrl: 'https://www.hyundaicard.com/cpc/cr/CPCCR0201_01.hc?cardWcd=TPE4',
    retrievedAt: '2026-07-31',
  });
  assert.ok(card, `수록되어야 한다: ${warnings.join('; ')}`);
  assert.equal(card.name, 'the Purple');
  assert.equal(card.annual_fee_krw, 1000000);
  assert.equal(card.benefits.length, 2);
  assert.match(card.benefits[0].title, /Priority Pass/);
});
