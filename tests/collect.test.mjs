import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseKrw,
  parsePercent,
  parseAnnualFee,
  inferCategory,
  makeSlug,
  romanizeHangul,
  robotsVerdict,
  stripTags,
  decodeEntities,
  extractMaxRatePct,
  extractPerTxnCap,
  extractSpendTiers,
  detectNoSpendCondition,
  parseCapTable,
  parseTierThreshold,
  parseTierCapRows,
  matchCapRow,
  parseCardPage,
} from '../scripts/collect-issuer-feed.mjs';

test('parseKrw: 완전한 금액만 통과시킨다', () => {
  assert.equal(parseKrw('30,000원'), 30000);
  assert.equal(parseKrw('5만원'), 50000);
  assert.equal(parseKrw('300원'), 300);
  assert.equal(parseKrw('1,234,000원'), 1234000);
});

test('parseKrw: 원본 피드에 존재하는 잘린 금액은 거부한다', () => {
  // 우리카드 ai-data 피드에서 실제로 관측된 손상 값
  assert.equal(parseKrw('16,0'), null);
  assert.equal(parseKrw('60,0'), null);
  assert.equal(parseKrw('12,0원'), null);
  assert.equal(parseKrw(''), null);
  assert.equal(parseKrw(undefined), null);
});

test('parsePercent: 순수 퍼센트 표기만 통과', () => {
  assert.equal(parsePercent('5%'), 5);
  assert.equal(parsePercent('2.5%'), 2.5);
  assert.equal(parsePercent('최대 5%'), null);
  assert.equal(parsePercent('120%'), null);
});

test('parseAnnualFee: 최저 금액을 고르고 없음은 0', () => {
  assert.equal(parseAnnualFee('연회비 국내전용 15,000원 해외겸용 18,000원'), 15000);
  assert.equal(parseAnnualFee('연회비 없음'), 0);
  assert.equal(parseAnnualFee('연회비 면제'), 0);
  assert.equal(parseAnnualFee(''), null);
  assert.equal(parseAnnualFee('연회비 정보 준비중'), null);
});

test('inferCategory: 여러 업종이 섞이면 먼저 언급된 쪽을 택한다', () => {
  assert.equal(inferCategory('대형마트, 병원, 서점 등 5% 할인'), 'shopping');
  assert.equal(inferCategory('병원, 약국 할인'), 'medical');
  assert.equal(inferCategory('넷플릭스 웨이브 구독 할인'), 'ott');
  assert.equal(inferCategory('지하철 버스 할인'), 'transit');
  assert.equal(inferCategory('설명 없는 무언가'), 'other');
});

test('romanizeHangul: 한글 음절을 라틴으로 음차한다', () => {
  assert.equal(romanizeHangul('우리카드'), 'urikadeu');
  assert.equal(romanizeHangul('신한'), 'sinhan');
  assert.equal(romanizeHangul('ABC 카드'), 'ABC kadeu');
});

test('makeSlug: id 패턴을 만족하는 읽을 수 있는 slug 를 만든다', () => {
  const slug = makeSlug('카드의정석 EVERY MILE', 'https://example.com/a');
  assert.match(slug, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.ok(slug.includes('every'));

  // 라틴 문자로 환원할 수 없는 이름은 결정적 해시로 대체된다
  const a = makeSlug('!!!', 'https://example.com/x');
  const b = makeSlug('!!!', 'https://example.com/x');
  const c = makeSlug('!!!', 'https://example.com/y');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^card-[a-z0-9]+$/);
});

test('robotsVerdict: 가장 긴 일치 규칙을 적용한다', () => {
  const robots = ['User-agent: *', 'Disallow: /dcmw/', 'Allow: /ai-data/', 'Allow: /dcmw/main.do'].join('\n');
  assert.equal(robotsVerdict(robots, '/ai-data/').allowed, true);
  assert.equal(robotsVerdict(robots, '/dcmw/').allowed, false);
  assert.equal(robotsVerdict(robots, '/dcmw/main.do').allowed, true);
});

test('robotsVerdict: 다른 User-agent 그룹의 규칙은 무시한다', () => {
  const robots = ['User-agent: Googlebot', 'Allow: /secret/', 'User-agent: *', 'Disallow: /secret/'].join('\n');
  assert.equal(robotsVerdict(robots, '/secret/').allowed, false);
});

test('robotsVerdict: 일치 규칙이 없으면 rule 이 null 이다', () => {
  const verdict = robotsVerdict('User-agent: *\nDisallow: /x/', '/ai-data/');
  assert.equal(verdict.rule, null);
});

test('stripTags / decodeEntities', () => {
  assert.equal(stripTags('<p>가 <b>나</b></p>'), '가 나');
  assert.equal(decodeEntities('a&amp;b&nbsp;c'), 'a&b c');
});

test('extractMaxRatePct: 표기된 요율 중 최댓값', () => {
  assert.equal(extractMaxRatePct('국내 패키지여행 3%~10% 할인'), 10);
  assert.equal(extractMaxRatePct('요율 표기 없음'), null);
  assert.equal(extractMaxRatePct('0% 할인'), null);
});

test('extractPerTxnCap: 건당 한도', () => {
  assert.equal(extractPerTxnCap('※ 결제 건당 최대 할인 대상 금액 5만원'), 50000);
  assert.equal(extractPerTxnCap('건당 제한 없음'), null);
});

test('extractSpendTiers: 전월실적 구간을 중복 없이 정렬해 모은다', () => {
  const text = '전월 국내 가맹점 이용실적 30만원 이상 시 제공. 전월 실적 50만원 이상이면 추가. 전월실적 30만원 이상';
  assert.deepEqual(extractSpendTiers(text), [300000, 500000]);
  assert.deepEqual(extractSpendTiers('실적 언급 없음'), []);
});

test('detectNoSpendCondition', () => {
  assert.equal(detectNoSpendCondition('전월 실적 조건 없이 제공'), true);
  assert.equal(detectNoSpendCondition('전월 실적 무관'), true);
  assert.equal(detectNoSpendCondition('전월 실적 30만원 이상'), false);
});

test('parseCapTable: 손상된 셀은 버리고 온전한 값만 남긴다', () => {
  const html = `
    <table>
      <thead><tr><th>전월 이용실적</th><th>30만원 이상</th><th>60만원 이상</th></tr></thead>
      <tbody>
        <tr><td>쇼핑 / 생활</td><td>4,000원</td><td>16,0</td></tr>
        <tr><td>통합 월 할인한도</td><td>30,000원</td><td>60,0</td></tr>
      </tbody>
    </table>`;
  const t = parseCapTable(html);
  assert.deepEqual(t.tiers, [300000, 600000]);
  assert.deepEqual(t.rows[0].caps, [4000, null]);
  assert.deepEqual(t.totalCaps, [30000, null]);
});

test('parseCapTable: 실적 헤더가 없는 표는 무시한다', () => {
  const html = '<table><thead><tr><th>업종</th><th>할인율</th></tr></thead><tbody><tr><td>백화점</td><td>5%</td></tr></tbody></table>';
  assert.deepEqual(parseCapTable(html).tiers, []);
});

test('matchCapRow: 첫 유효 구간의 한도와 실적을 짝지어 준다', () => {
  const capTable = {
    tiers: [300000, 600000],
    rows: [{ label: '쇼핑 / 생활', caps: [4000, 8000] }],
    totalCaps: [],
  };
  assert.deepEqual(matchCapRow(capTable, '쇼핑/생활업종 할인'), { cap: 4000, tier: 300000 });
  assert.equal(matchCapRow(capTable, '해외 이용'), null);
  assert.equal(matchCapRow({ tiers: [], rows: [], totalCaps: [] }, '쇼핑'), null);
});

// ---------------------------------------------------------------- 통합



const FIXTURE = `<!doctype html><html><head>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"CreditCard","name":"테스트 우리카드",
 "description":"테스트용 설명","url":"https://pc.wooricard.com/dcpc/x?cdPrdCd=1",
 "annualFee":"연회비 10,000원"}
</script></head><body>
<div class="meta-row">
  <div class="meta-item"><div class="label">연회비</div><div class="value">연회비 국내전용 10,000원</div></div>
  <div class="meta-item"><div class="label">카드 종류</div><div class="value">신용카드</div></div>
</div>
<ul class="summary-list">
  <li><strong>5%</strong><span class="condition">쇼핑/생활업종 할인</span></li>
  <li><strong>커피전문점 25% 청구할인</strong><span class="condition">스타벅스 등 커피전문점 25% 할인</span></li>
</ul>
<div class="acco-item"><h3>쇼핑 / 생활 업종 할인</h3>
  <p># 쇼핑/생활 업종 5% 청구할인</p>
  <p>※ 결제 건당 최대 할인 대상 금액 5만원</p>
</div>
<table>
  <thead><tr><th>전월 국내 이용실적</th><th>30만원 이상</th></tr></thead>
  <tbody><tr><td>쇼핑 / 생활</td><td>4,000원</td></tr></tbody>
</table>
</body></html>`;

test('parseTierThreshold: 구간 표기에서 하한을 뽑는다', () => {
  assert.equal(parseTierThreshold('30만원 이상 ~ 70만원 미만'), 300000);
  assert.equal(parseTierThreshold('120만원 이상'), 1200000);
  assert.equal(parseTierThreshold('실적조건 없음'), null);
});

test('parseTierCapRows: 한도 열이 있는 행 방향 표만 읽는다', () => {
  const good = `
    <table>
      <thead><tr><th>전월 국내외 가맹점 이용실적</th><th>월 할인한도</th><th>비고</th></tr></thead>
      <tbody>
        <tr><td>30만원 이상 ~ 70만원 미만</td><td>10,000원</td><td>조건</td></tr>
        <tr><td>120만원 이상</td><td>20,000원</td><td></td></tr>
      </tbody>
    </table>`;
  assert.deepEqual(parseTierCapRows(good), [
    { tier: 300000, cap: 10000 },
    { tier: 1200000, cap: 20000 },
  ]);
});

test('parseTierCapRows: 리터당 단가 표를 한도로 오독하지 않는다', () => {
  // 헤더에 '한도' 열이 없다. 값 '5원' 은 리터당 할인액이다.
  const perLiter = `
    <table>
      <thead><tr><th>전월 국내가맹점 이용실적</th><th>특정주유소</th><th>일반주유소</th></tr></thead>
      <tbody><tr><td>30만원 이상</td><td>5원</td><td>5원</td></tr></tbody>
    </table>`;
  assert.deepEqual(parseTierCapRows(perLiter), []);
});

test('parseTierCapRows: 포인트 한도 표는 금액이 아니므로 걸러진다', () => {
  const points = `
    <table>
      <thead><tr><th>전월 이용실적</th><th>적립한도</th></tr></thead>
      <tbody><tr><td>50만원 이상</td><td>1만점</td></tr></tbody>
    </table>`;
  assert.deepEqual(parseTierCapRows(points), []);
});

test('parseKrw: 임계값 표기는 금액으로 받지 않는다', () => {
  // '50만원 이상' 을 금액으로 받아들이면 실적 금액이 월 한도로 잘못 기록된다
  assert.equal(parseKrw('50만원 이상'), null);
  assert.equal(parseKrw('30만원이상'), null);
  assert.equal(parseKrw('실적조건 없음'), null);
  assert.equal(parseKrw('4,000포인트'), null);
});

test('parseCapTable: 실적이 열로 들어간 표는 한도 표로 쓰지 않는다', () => {
  // 우리카드 ai-data 피드에 실제로 존재하는 형태.
  // 이 표를 구간 행렬로 오인하면 '50만원 이상'이 월 한도 500000 으로 기록된다.
  const html = `
    <table>
      <thead><tr><th>구분</th><th>전월 국내외가맹점 이용실적</th><th>대상 가맹점</th><th>적립 포인트</th><th>통합원 적립한도</th></tr></thead>
      <tbody>
        <tr><td>특별적립</td><td>50만원 이상</td><td>아코르 호텔</td><td>5포인트</td><td>4,000포인트</td></tr>
        <tr><td>기본적립</td><td>실적조건 없음</td><td>국내가맹점</td><td>1.3포인트</td><td>적립한도 제한없음</td></tr>
      </tbody>
    </table>`;
  const t = parseCapTable(html);
  assert.deepEqual(t.tiers, [], '구간 행렬이 아니므로 tiers 가 비어야 한다');
  assert.deepEqual(t.rows, [], '한도 행을 만들어서는 안 된다');
});

test('parseCardPage: 월 한도가 필요 실적 이상이면 한도를 버린다', () => {
  const html = FIXTURE.replace('<td>4,000원</td>', '<td>300,000원</td>');
  const { card } = parseCardPage(html, {
    issuerKey: 'woori',
    pageUrl: 'https://pc.wooricard.com/ai-data/card_1.html',
    retrievedAt: '2026-07-31',
  });
  const shopping = card.benefits.find((b) => b.category === 'shopping');
  assert.equal(shopping.monthly_cap_krw, undefined, '실적 이상인 한도는 파싱 오류로 보고 버려야 한다');
  assert.equal(shopping.requires_prev_month_spend_krw, 300000);
});

test('parseCardPage: 픽스처에서 카드 객체를 만든다', () => {
  const { card, warnings } = parseCardPage(FIXTURE, {
    issuerKey: 'woori',
    pageUrl: 'https://pc.wooricard.com/ai-data/card_1.html',
    retrievedAt: '2026-07-31',
  });
  assert.ok(card, `card 가 생성되어야 함: ${warnings.join('; ')}`);
  assert.equal(card.issuer, 'woori');
  assert.match(card.id, /^woori-/);
  assert.equal(card.name, '테스트 우리카드');
  assert.equal(card.card_type, 'credit');
  assert.equal(card.annual_fee_krw, 10000);
  assert.deepEqual(card.prev_month_spend_tiers_krw, [300000]);
  assert.equal(card.source.kind, 'issuer_machine_readable_feed');
  assert.equal(card.review_status, 'machine_extracted');

  const shopping = card.benefits.find((b) => b.category === 'shopping');
  assert.ok(shopping);
  assert.equal(shopping.rate_pct, 5);
  assert.equal(shopping.monthly_cap_krw, 4000);
  assert.equal(shopping.requires_prev_month_spend_krw, 300000);
  assert.equal(shopping.per_txn_eligible_spend_cap_krw, 50000);

  // <strong> 에 혜택명이 들어간 경우에도 요율을 본문에서 뽑아낸다
  const coffee = card.benefits.find((b) => b.title.includes('커피'));
  assert.ok(coffee);
  assert.equal(coffee.rate_pct, 25);
});

test('parseCardPage: 카드 종류를 알 수 없으면 추측하지 않고 건너뛴다', () => {
  const html = FIXTURE.replace('신용카드', '');
  const { card, warnings } = parseCardPage(html, {
    issuerKey: 'woori',
    pageUrl: 'https://pc.wooricard.com/ai-data/card_1.html',
    retrievedAt: '2026-07-31',
  });
  assert.equal(card, null);
  assert.ok(warnings.some((w) => w.includes('카드 종류')));
});

test('parseCardPage: JSON-LD 가 없으면 건너뛴다', () => {
  const { card } = parseCardPage('<html><body>없음</body></html>', {
    issuerKey: 'woori',
    pageUrl: 'https://pc.wooricard.com/ai-data/card_1.html',
    retrievedAt: '2026-07-31',
  });
  assert.equal(card, null);
});
