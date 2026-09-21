import { mergeCatalog } from './catalog.js';
import { computePickingRate, pickingCaveat, formatKrw, PICKING_STATUS } from './picking.js';
import { emptyFilters, matches, sortCards, minTier } from './filters.js?v=full-catalog-3';
import { freshness, taxLabel, reviewLabel, coverageRows, eventPeriod, koreanToday } from './evidence.js';

const CATEGORY_LABELS = {
  shopping: '쇼핑',
  food: '외식·카페',
  transit: '교통',
  fuel: '주유',
  telecom: '통신',
  utility: '공과금·생활',
  tax: '세금',
  overseas: '해외',
  travel: '여행',
  ott: 'OTT·구독',
  education: '교육',
  medical: '의료',
  mileage: '마일리지',
  point: '포인트·적립',
  other: '기타',
};

const CARD_TYPE_LABELS = { credit: '신용', check: '체크' };
const CONFIDENCE_LABELS = { high: '높음', medium: '보통', low: '낮음' };

const state = {
  cards: [],
  catalog: null,
  visibleLimit: 60,
  images: {},
  issuers: new Map(),
  generatedAt: '',
  filters: emptyFilters(),
  sort: 'name',
  collectionReport: null,
  eventsDoc: null,
};

const el = (id) => document.getElementById(id);

function text(node, value) {
  node.textContent = value ?? '';
  return node;
}

function create(tag, className, textContent) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (textContent != null) node.textContent = textContent;
  return node;
}

// ------------------------------------------------------------------ load

async function fetchDocument(url, optional = false) {
  try {
    const response = await fetch(url, {cache: 'no-cache'});
    if (!response.ok) throw new Error(`${url} (HTTP ${response.status})`);
    return await response.json();
  } catch (error) {
    if (optional) return null;
    throw error;
  }
}

async function load() {
  const [cardsDoc, issuersDoc, imagesDoc, archiveDoc] = await Promise.all([
    fetchDocument('cards.json'),
    fetchDocument('issuers.json'),
    fetchDocument('card-images.json', true),
    fetchDocument('archive-catalog.json'),
  ]);
  state.catalog = mergeCatalog(cardsDoc.cards, archiveDoc.cards);
  state.cards = state.catalog.cards;
  state.images = {...archiveDoc.images, ...(imagesDoc?.images ?? {})};
  for (const match of state.catalog.matched) {
    if (!state.images[match.official_id] && archiveDoc.images[match.archive_id]) state.images[match.official_id] = archiveDoc.images[match.archive_id];
  }
  for (const i of archiveDoc.issuers) state.issuers.set(i.key, i);
  state.generatedAt = cardsDoc.generated_at;
  for (const i of issuersDoc.issuers) state.issuers.set(i.key, i);

  buildIssuerSelect();
  buildCategoryChips();
  bindControls();
  render();

  renderOverview();
  text(el('meta-line'), `공식 데이터 생성일 ${state.generatedAt} · 이전 파일 기준일 2026-07-01 · 공식 수록과 현재 발급 가능 여부는 다릅니다.`);
  [state.collectionReport, state.eventsDoc] = await Promise.all([
    fetchDocument('collection-report.json', true), fetchDocument('card-events.json', true),
  ]);
  renderOverview();
  renderEvents();
}

function eventCard(event, status) {
  const article = create('article', 'event-card');
  const labels = { active: '기간상 진행 중', upcoming: '시작 예정', expired: '종료된 행사', unknown: '기간 미확인' };
  const header = create('div', 'tags');
  header.append(create('span', 'badge', state.issuers.get(event.issuer)?.name || event.issuer),
    create('span', `badge ${status === 'active' ? 'status-fresh' : 'badge-muted'}`, labels[status]));
  const title = create('h3');
  const link = create('a', null, event.title);
  link.href = event.url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer nofollow';
  title.append(link);
  article.append(header, title, create('p', 'caveat', `행사 ${event.starts_at || '미확인'} ~ ${event.ends_at || '미확인'} · 원문 확인 ${event.checked_at || '미확인'}`));
  if (event.summary) article.append(create('p', null, event.summary));
  if (event.conditions?.length) {
    const conditions = create('ul');
    for (const condition of event.conditions) conditions.append(create('li', null, condition));
    article.append(conditions);
  }
  return article;
}

function renderEvents() {
  const current = el('current-events');
  current.replaceChildren();
  const events = state.eventsDoc?.events;
  if (!Array.isArray(events)) {
    current.append(create('p', 'caveat', '행사 자료를 불러오지 못했습니다. 현재 혜택이 없다는 뜻은 아닙니다.'));
    return;
  }
  const today = koreanToday();
  const active = events.filter((event) => eventPeriod(event, today) === 'active');
  const others = events.filter((event) => eventPeriod(event, today) !== 'active');
  if (!active.length) {
    current.append(create('p', 'event-empty', `${today} 기준, 저장된 자료에 기간상 진행 중인 행사가 없습니다.`));
  } else {
    current.append(create('p', 'caveat', `${today} 기준, 저장된 행사 기간과 대조한 결과입니다. 변경·조기 종료 여부는 공식 원문에서 다시 확인하세요.`));
    for (const event of active) current.append(eventCard(event, 'active'));
  }
  el('event-history').hidden = !others.length;
  text(el('event-history-label'), `종료·예정·기간 미확인 행사 ${others.length}건`);
  const history = el('other-events');
  history.replaceChildren();
  for (const event of others) history.append(eventCard(event, eventPeriod(event, today)));
}

function renderOverview() {
  const cards = state.cards;
  const collected = new Set(cards.map((c) => c.issuer));
  const recent = cards.filter((c) => freshness(c).key === 'fresh').length;
  const stale = cards.filter((c) => freshness(c).key === 'stale').length;
  const stats = el('data-stats');
  stats.replaceChildren();
  for (const [label, value] of [['통합 목록', `${cards.length}개`], ['이전 목록 복구', `${state.catalog.archive_total}개`], ['공식 원문 수록', `${state.catalog.official_total}개`], ['공식 재확인 전', `${state.catalog.archive_unmatched}개`]]) {
    const item = create('div', 'stat');
    item.append(create('span', 'stat-label', label), create('strong', null, value));
    stats.append(item);
  }
  const rows = coverageRows(cards.filter(c => c.catalog_origin === 'official'), [...state.issuers.values()], state.collectionReport);
  text(el('coverage-summary'), `발행사·서비스 ${collected.size}곳 · 이전 자료와 공식 원문 구분`);
  const missingDate = cards.filter(c => c.catalog_origin === 'official').length - recent - stale;
  const report = state.collectionReport;
  const transportName = report?.transport === 'brightdata_web_unlocker' ? 'Bright Data' : report?.transport === 'direct_official_http' ? '공식 사이트 직접 수집' : '수집 방식 미기재';
  text(el('collection-note'), (report
    ? `실행 기록 ${report.generated_at || '일자 미기재'} · ${transportName}. ${report.transport_note || ''} 저장 카드 수는 이번 실행의 성공 건수와 다릅니다.`
    : '실행 보고서가 없어 이번 수집의 성공·실패 여부를 확인할 수 없습니다. 저장된 카드와 기존 미수집 사유만 표시합니다.')
    + (missingDate ? ` 확인일 미확인 ${missingDate}장.` : ''));
  const body = el('coverage-body');
  body.replaceChildren();
  for (const row of rows) {
    const tr = create('tr');
    const label = create('th', null, row.name);
    label.scope = 'row';
    const result = row.run
      ? [['시도', row.run.attempted], ['성공', row.run.succeeded], ['실패', row.run.failed], ['갱신', row.run.updated_cards], ['이전 유지', row.run.retained_cards]]
        .filter(([, value]) => Number.isFinite(value)).map(([key, value]) => `${key} ${value}`).join(' · ') || '건수 미기재'
      : '미확인';
    const archivedCount = cards.filter(c => c.issuer === row.key && c.catalog_origin === 'archive').length;
    tr.append(label, create('td', null, `공식 ${row.count} · 이전 ${archivedCount}`), create('td', null, row.label), create('td', null, result),
      create('td', 'coverage-note', [row.run?.checked_at, row.note].filter(Boolean).join(' · ') || '—'));
    body.append(tr);
  }
}

function buildIssuerSelect() {
  const select = el('issuer');
  const all = create('option', null, '전체');
  all.value = '';
  select.append(all);
  const keys = [...new Set([...state.issuers.keys(), ...state.cards.map((c) => c.issuer)])];
  for (const key of keys) {
    const count = state.cards.filter((card) => card.issuer === key).length;
    const option = create('option', null, `${state.issuers.get(key)?.name ?? key} (${count}장)`);
    option.value = key;
    select.append(option);
  }
}

function buildCategoryChips() {
  const host = el('categories');
  const present = new Set(state.cards.flatMap((c) => c.benefits.map((b) => b.category)));
  for (const [key, label] of Object.entries(CATEGORY_LABELS)) {
    if (!present.has(key)) continue;
    const id = `cat-${key}`;
    const wrap = create('span', 'chip');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = id;
    input.value = key;
    input.addEventListener('change', () => {
      if (input.checked) state.filters.categories.add(key);
      else state.filters.categories.delete(key);
      render();
    });
    const lab = create('label', null, label);
    lab.setAttribute('for', id);
    wrap.append(input, lab);
    host.append(wrap);
  }
}

function bindControls() {
  el('q').addEventListener('input', (e) => {
    state.filters.q = e.target.value.trim();
    render();
  });
  for (const key of ['catalogOrigin', 'issuer', 'cardType', 'maxFee', 'maxSpend', 'taxSpend', 'taxRewards', 'freshness', 'reviewStatus']) {
    el(key).addEventListener('change', (e) => {
      state.filters[key] = e.target.value;
      render();
    });
  }
  el('sort').addEventListener('change', (e) => {
    state.sort = e.target.value;
    render();
  });
  el('load-more').addEventListener('click', () => { state.visibleLimit += 60; render(true); });
  el('detail-close').addEventListener('click', () => el('detail').close());
  el('reset-filters').addEventListener('click', () => {
    state.filters = emptyFilters();
    state.sort = 'name';
    for (const control of document.querySelectorAll('.controls input, .controls select')) {
      if (control.type === 'checkbox') control.checked = false;
      else control.value = control.id === 'sort' ? 'name' : '';
    }
    render();
  });
}

// ------------------------------------------------------------------ render

function pickingBadge(result) {
  if (result.status === PICKING_STATUS.OK) {
    const badge = create('span', 'badge badge-picking', `피킹률 약 ${result.pct}%`);
    badge.title = `월 추정 혜택 ${formatKrw(result.estimatedKrw)} ÷ 전월실적 ${formatKrw(result.tierKrw)}`;
    return badge;
  }
  if (result.status === PICKING_STATUS.NO_SPEND_CONDITION) {
    return create('span', 'badge badge-muted', '실적 조건 없음');
  }
  return create('span', 'badge badge-muted', '피킹률 산출 불가');
}

function sourceLink(card, label = '수집에 사용한 공식 원문') {
  const a = create('a', null, label);
  a.href = card.source.url;
  a.rel = 'noopener noreferrer nofollow';
  a.target = '_blank';
  return a;
}

function taxSummary(card) {
  const box = create('div', 'tax-summary');
  for (const [field, label] of [['counts_as_spend', '세금 전월실적'], ['earns_rewards', '세금 적립·할인']]) {
    const item = create('div');
    item.append(create('span', 'tax-label', label), create('strong', null, taxLabel(card, field)));
    box.append(item);
  }
  return box;
}

function cardArtwork(card, detail = false) {
  const image = state.images[card.id];
  const box = create('div', `card-artwork${detail ? ' card-artwork-detail' : ''}`);
  if (!image?.src || !/^images\/(cards|archive)\/[a-f0-9]+\.(png|jpg|gif|webp)$/.test(image.src)) {
    box.append(create('span', 'artwork-placeholder', '이미지 준비 중'));
    return box;
  }
  const img = create('img');
  const orient = () => { if (img.naturalHeight > img.naturalWidth) img.classList.add('portrait-to-landscape'); };
  img.addEventListener('load', orient, {once: true});
  img.src = image.src;
  if (img.complete) orient();
  img.alt = `${card.name} 카드 디자인`;
  img.loading = detail ? 'eager' : 'lazy';
  img.decoding = 'async';
  img.width = 180;
  img.height = 114;
  img.addEventListener('error', () => box.replaceChildren(create('span', 'artwork-placeholder', '이미지를 불러오지 못했어요')), { once: true });
  box.append(img);
  return box;
}

function cardRow(card) {
  const article = create('article', 'card');
  article.dataset.cardId = card.id;
  const checked = freshness(card);
  const header = create('header', 'card-head');
  const detailBtn = create('button', 'artwork-button');
  detailBtn.type = 'button';
  detailBtn.setAttribute('aria-label', `${card.name} 상세 보기`);
  detailBtn.append(cardArtwork(card));
  detailBtn.addEventListener('click', () => openDetail(card));
  header.append(detailBtn);
  const tags = create('div', 'tags');
  tags.append(create('span', 'badge', state.issuers.get(card.issuer)?.name ?? card.issuer));
  tags.append(create('span', 'badge', `${CARD_TYPE_LABELS[card.card_type] ?? card.card_type}카드`));
  tags.append(create('span', `badge ${card.catalog_origin === 'archive' ? 'status-stale' : 'status-fresh'}`, card.catalog_origin === 'archive' ? '이전 자료 · 미확인' : '공식 원문 수록'));
  header.append(tags, create('h2', null, card.name));
  article.append(header);
  if (card.catalog_origin === 'archive') {
    article.append(create('p', 'archive-note', `이전 저장 ${card.archive.snapshot_date} · ${card.archive.discontinued_in_snapshot ? '당시 단종 표시' : '현재 발급 상태 미확인'}`));
    const list = create('ul', 'benefit-list');
    for (const b of card.benefits.slice(0, 3)) { const li=create('li'); li.append(create('span','cat',CATEGORY_LABELS[b.category] ?? b.category),create('span','btitle',b.title)); list.append(li); }
    article.append(list, create('p','card-detail-hint','이전 소개 내용입니다. 현재 적용 여부는 공식 재확인 전입니다.'));
    const btn=create('button','link-btn archive-open','이전 저장 내용 보기');btn.addEventListener('click',()=>openDetail(card));article.append(btn);
    return article;
  }

  const tier = minTier(card);
  const facts = create('dl', 'card-facts');
  facts.append(create('dt', null, '연회비'), create('dd', null,
    Number.isFinite(card.annual_fee_krw) ? `${card.annual_fee_krw > 0 ? '최저 ' : ''}${formatKrw(card.annual_fee_krw)}` : '미확인'));
  facts.append(create('dt', null, '전월실적'), create('dd', null,
    card.no_prev_month_spend_condition ? '조건 없음' : tier !== null ? `${formatKrw(tier)}부터` : '미확인'));
  article.append(facts);
  const picking = computePickingRate(card);
  if (picking.status === PICKING_STATUS.OK) article.append(pickingBadge(picking));

  const list = create('ul', 'benefit-list');
  for (const b of card.benefits.slice(0, 3)) {
    const li = create('li');
    li.append(create('span', 'cat', CATEGORY_LABELS[b.category] ?? b.category));
    const title = create('span', 'btitle', b.title);
    title.title = b.title;
    li.append(title);
    list.append(li);
  }
  article.append(list);
  const more = card.benefits.length > 3 ? `외 ${card.benefits.length - 3}개 혜택 · ` : '';
  article.append(create('p', 'card-detail-hint', `${more}한도·제외 조건은 상세에서 확인`));
  article.append(taxSummary(card));

  const evidence = create('p', 'evidence-line');
  evidence.append(create('span', `badge status-${checked.key}`, checked.label),
    document.createTextNode(` 확인 ${checked.date || '미확인'}`));
  article.append(evidence);
  const actions = create('div', 'actions');
  const open = create('button', 'link-btn primary-btn', '혜택 자세히');
  open.addEventListener('click', () => openDetail(card));
  const official = create('a', 'link-btn', '공식 원문');
  official.href = card.product_url;
  official.rel = 'noopener noreferrer nofollow';
  official.target = '_blank';
  actions.append(open, official);
  article.append(actions);
  return article;
}

async function openArchiveDetail(card) {
  const body=el('detail-body');body.replaceChildren();
  const title=create('h2',null,card.name);title.id='detail-title';
  body.append(title,cardArtwork(card,true));
  body.append(create('p','notice notice-warn',`이전 저장 자료 (${card.archive.snapshot_date}). 카드사 공식 원문을 재확인하지 않았습니다. 아래 혜택·연회비·실적은 과거 기록이며 현재 조건으로 사용하지 마세요.`));
  body.append(create('p',null,card.archive.discontinued_in_snapshot?'이전 파일에서 단종으로 표시된 상품입니다. 현재 상태는 미확인입니다.':'이전 파일에 단종 표시가 없었습니다. 현재 발급 가능 여부는 미확인입니다.'));
  const dl=create('dl','detail-meta');
  for(const [k,v] of [['발행사·서비스',card.issuer_name],['이전 연회비',card.archive.annual_fee_text||'미기재'],['이전 전월실적',card.archive.previous_spend_text]])dl.append(create('dt',null,k),create('dd',null,v));
  body.append(dl,create('h3',null,'이전 저장 혜택'));
  const content=create('div');content.append(create('p','caveat','저장 내용을 불러오고 있습니다.'));body.append(content);
  body.append(create('p','source-line',card.source.note));el('detail').showModal();
  try {
    if (!/^archive-details\/archive-\d+\.json$/.test(card.archive.detail_src)) throw new Error('Invalid archive path');
    const doc=await fetchDocument(card.archive.detail_src);
    if (doc.id !== card.id || !Array.isArray(doc.benefits)) throw new Error('Invalid archive detail');
    content.replaceChildren();
    for(const b of doc.benefits)content.append(create('h4',null,b.title),create('p','archive-benefit',b.text));
  } catch { content.replaceChildren(create('p','caveat','저장 내용을 불러오지 못했습니다. 잠시 후 다시 열어주세요.')); }
}

function openDetail(card) {
  if (card.catalog_origin === 'archive') { openArchiveDetail(card); return; }
  const picking = computePickingRate(card);
  const body = el('detail-body');
  body.replaceChildren();

  const title = create('h2', null, card.name);
  title.id = 'detail-title';
  body.append(title, cardArtwork(card, true));
  if (card.tagline) body.append(create('p', 'tagline', card.tagline));

  const dl = create('dl', 'detail-meta');
  const rows = [
    ['카드사', state.issuers.get(card.issuer)?.name ?? card.issuer],
    ['종류', `${CARD_TYPE_LABELS[card.card_type] ?? card.card_type}카드`],
    ['확인된 최저 연회비', Number.isFinite(card.annual_fee_krw) ? formatKrw(card.annual_fee_krw) : '미확인'],
    ['연회비 원문', card.annual_fee_note ?? '-'],
    [
      '전월실적 구간',
      card.no_prev_month_spend_condition
        ? '조건 없음'
        : (card.prev_month_spend_tiers_krw ?? []).map(formatKrw).join(' / ') || '미확인',
    ],
    [
      '통합 월 한도',
      Number.isFinite(card.integrated_monthly_cap_krw)
        ? formatKrw(card.integrated_monthly_cap_krw)
        : '미확인',
    ],
    ['추출 충실도', `${CONFIDENCE_LABELS[card.confidence] || '미확인'} — 필드 추출 정도이며 혜택 보증이 아닙니다`],
    ['원문 검수', reviewLabel(card)],
    ['원문 확인일', `${card.source.retrieved_at || '미확인'} · ${freshness(card).label}`],
    ['레코드 갱신일', card.updated_at],
    ['현재 발급 상태', '미확인 · 공식 페이지 수록이 발급 가능을 보장하지 않습니다.'],
  ];
  for (const [k, v] of rows) {
    dl.append(create('dt', null, k), create('dd', null, v));
  }
  body.append(dl);

  body.append(create('h3', null, '세금 납부 조건'));
  body.append(taxSummary(card));
  body.append(create('p', 'caveat', card.tax?.note || '국세·지방세 적용 범위와 예외를 확인할 원문 근거가 아직 정리되지 않았습니다. 미확인은 포함 또는 제외를 뜻하지 않습니다.'));
  body.append(create('p', 'caveat', '전월실적에 포함되더라도 포인트 적립·할인 대상에서는 제외될 수 있습니다. 납부 할부 행사는 상품의 상시 혜택과 별도로 확인하세요.'));

  const pickingBox = create('div', 'notice notice-info');
  pickingBox.append(create('strong', null, '피킹률 추정'));
  const p = create('p');
  if (picking.status === PICKING_STATUS.OK) {
    p.textContent =
      `약 ${picking.pct}% = 월 추정 최대 혜택 ${formatKrw(picking.estimatedKrw)} ÷ ` +
      `전월실적 ${formatKrw(picking.tierKrw)}`;
  } else {
    p.textContent = '계산하지 않았습니다.';
  }
  pickingBox.append(p, create('p', 'caveat', pickingCaveat(picking)));
  body.append(pickingBox);

  body.append(create('h3', null, `혜택 ${card.benefits.length}건`));
  const table = create('table', 'benefit-table');
  const thead = create('thead');
  const hr = create('tr');
  for (const h of ['분야', '혜택', '최대 요율', '월 한도', '건당 대상금액 한도', '필요 전월실적']) {
    hr.append(create('th', null, h));
  }
  thead.append(hr);
  table.append(thead);
  const tbody = create('tbody');
  for (const b of card.benefits) {
    const tr = create('tr');
    tr.append(create('td', null, CATEGORY_LABELS[b.category] ?? b.category));
    const td = create('td');
    td.append(create('div', 'btitle', b.title));
    if (b.summary) td.append(create('div', 'bsummary', b.summary));
    for (const note of b.notes ?? []) td.append(create('div', 'caveat', note));
    tr.append(td);
    tr.append(create('td', 'num', Number.isFinite(b.rate_pct) ? `${b.rate_pct}%` : '미확인'));
    tr.append(
      create(
        'td',
        'num',
        Number.isFinite(b.monthly_cap_krw)
          ? formatKrw(b.monthly_cap_krw)
          : Number.isFinite(b.monthly_cap_points)
            ? `${b.monthly_cap_points.toLocaleString('ko-KR')}P`
            : '미확인',
      ),
    );
    tr.append(create('td', 'num', Number.isFinite(b.per_txn_eligible_spend_cap_krw) ? formatKrw(b.per_txn_eligible_spend_cap_krw) : '미확인'));
    tr.append(
      create(
        'td',
        'num',
        Number.isFinite(b.requires_prev_month_spend_krw)
          ? formatKrw(b.requires_prev_month_spend_krw)
          : '미확인',
      ),
    );
    tbody.append(tr);
  }
  table.append(tbody);
  const scroll = create('div', 'table-scroll');
  scroll.tabIndex = 0;
  scroll.setAttribute('role', 'region');
  scroll.setAttribute('aria-label', '혜택 상세 표, 가로로 스크롤할 수 있습니다');
  scroll.append(table);
  body.append(scroll);

  const src = create('p', 'source-line');
  src.append(document.createTextNode('출처: '));
  const a = sourceLink(card, card.source.url);
  src.append(a, document.createTextNode(` (수집일 ${card.source.retrieved_at})`));
  body.append(src);
  if (card.source.note) body.append(create('p', 'caveat', card.source.note));

  const warn = create('p', 'caveat');
  warn.textContent =
    '이 표의 "미확인"은 혜택이 없다는 뜻이 아니라 공식 자료에서 값을 확실히 읽어내지 못했다는 뜻입니다. ' +
    '정확한 조건은 공식 상품 페이지와 상품설명서를 확인하세요.';
  body.append(warn);

  el('detail').showModal();
}

function render(keepLimit = false) {
  if (!keepLimit) state.visibleLimit = 60;
  const filtered = sortCards(state.cards.filter((c) => matches(c, state.filters)), state.sort);
  const host = el('results');
  host.replaceChildren();

  if (!filtered.length) {
    host.append(create('p', 'empty', '저장된 자료에서 조건이 확인된 카드가 없습니다. 미확인 값이나 미수집 카드사가 있을 수 있습니다. 필터를 넓혀 다시 살펴보세요.'));
  } else {
    for (const card of filtered.slice(0, state.visibleLimit)) host.append(cardRow(card));
    el('load-more').textContent = `60개 더 보기 · 남은 ${Math.max(0, filtered.length - state.visibleLimit)}개`;
  }

  el('load-more').hidden = filtered.length <= state.visibleLimit;
  const withPicking = filtered.filter((c) => computePickingRate(c).status === PICKING_STATUS.OK).length;
  text(
    el('summary'),
    `${filtered.length}개 검색 · ${Math.min(filtered.length, state.visibleLimit)}개 표시 / 통합 ${state.cards.length}개 · 피킹률 산출 가능 ${withPicking}개`,
  );
}

load().catch((err) => {
  el('results').append(create('p', 'empty', `데이터를 불러오지 못했습니다: ${err.message}`));
});
