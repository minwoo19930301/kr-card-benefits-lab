# kr-card-benefits-lab

한국 신용·체크카드 혜택을 **카드사가 스스로 공개한 데이터만으로** 정리하는 개인 리서치 저장소다.
정적 대시보드와 기계 판독용 JSON 데이터셋을 함께 제공한다.

- 대시보드: `npm run serve` 후 http://localhost:8787
- 데이터: [`data/cards.json`](data/cards.json)
- 스키마: [`data/cards.schema.json`](data/cards.schema.json) / 설명은 [`docs/schema.md`](docs/schema.md)

## 목적

카드 혜택을 비교할 때 필요한 최소한의 구조화된 데이터를 직접 정의해서 갖는 것.
전수 수집이 목표가 아니라 **출처가 붙은 값**을 갖는 게 목표다.

## 데이터 출처 정책

**카드사 공식 페이지, 그중에서도 기계 접근이 명시적으로 허용된 경로만 사용한다.**
제3자 카드 비교 서비스나 가계부 앱의 비공개 API 는 사용하지 않는다.

현재 수집 대상은 두 곳이다.

- **우리카드** — `robots.txt` 에서 `Allow: /ai-data/` 로 명시 허용하고 `sitemap.xml` 에 등재해 둔
  기계판독 상품 페이지 (schema.org `CreditCard` JSON-LD)
- **현대카드** — 공식 상품 상세 페이지. 일반 HTTP 요청이 차단되므로 설치된 Chrome 을 헤드리스로
  렌더링해 읽는다. UA 위장·스텔스 플러그인·쿠키 재사용·CAPTCHA 우회는 쓰지 않는다.

나머지 카드사는 상세 값을 신뢰할 수 있게 읽을 방법이 아직 없어 **미수록**으로 두었다.
차단을 우회하지 않는다.

자세한 근거와 카드사별 확인 결과는 [`docs/sources.md`](docs/sources.md) 에 있다.

## 데이터에 대해 알아야 할 것

- **완전 자동 전수 데이터가 아니다.** 큐레이션 + 자동 추출 혼합이며, 현재 데이터는 전부
  `review_status: machine_extracted` (사람이 눈으로 확인하지 않음) 상태다.
- **빈 값은 "혜택 없음"이 아니라 "확인하지 못함"이다.** 원본 피드에 오탈자와 잘린 금액
  (`16,000원` → `16,0`)이 있어, 온전히 읽히지 않은 수치는 채우지 않는다.
- **혜택은 수시로 변경·단종된다.** 각 카드의 `updated_at` 과 `source.retrieved_at` 을 확인하고,
  신청 전에는 반드시 `product_url` 의 공식 페이지를 보라.
- **금융 조언이 아니다.** 개인 리서치 참고용이다. [`docs/legal-notes.md`](docs/legal-notes.md) 참고.

## 피킹률

```
피킹률(%) = (월 추정 최대 혜택 합) ÷ (전월 이용실적 기준 금액) × 100
```

약관상 월 한도를 모두 채웠다는 가정의 추정치다. 한도가 확인되지 않은 혜택은 0 원으로
계산하므로 과소추정되기도 한다. 데이터에 저장하지 않고 화면에서 계산한다
([`site/picking.js`](site/picking.js)). 계산식과 한계는
[`docs/methodology.md`](docs/methodology.md) 에 있다.

## 구조

```
data/
  cards.json           수집된 카드 데이터
  cards.schema.json    스키마 정본
  issuers.json         카드사 레지스트리 + 도메인 화이트리스트
scripts/
  collect-issuer-feed.mjs       기계판독 피드 수집 (robots 확인 → sitemap → 파싱)
  collect-issuer-rendered.mjs   렌더링 필요한 공식 페이지 수집 (로컬 전용, Chrome 필요)
  validate.mjs              스키마 + 출처 정책 검증
  build-site.mjs            site/ + data/ → dist/
site/
  index.html app.js styles.css picking.js
docs/
  schema.md sources.md methodology.md legal-notes.md
tests/
```

## 사용법

```bash
npm test                          # 단위 테스트 + 실제 데이터 검증
npm run validate                  # 스키마 + 출처 정책
npm run validate -- --check-urls  # 공식 URL 도달성까지 확인 (네트워크)
npm run build                     # dist/ 생성
npm run serve                     # 로컬에서 대시보드 확인

node scripts/collect-issuer-feed.mjs --issuer woori              # 기계판독 피드
node scripts/collect-issuer-rendered.mjs --issuer hyundai        # 렌더링 필요 (Chrome)
node scripts/collect-issuer-rendered.mjs --issuer hyundai --limit 2 --dry-run
```

의존성이 없다. Node 22 이상이면 그대로 돌아간다.

수집기는 실행할 때마다 `robots.txt` 를 먼저 읽고, 대상 경로에 명시적 `Allow` 가 없으면
중단한다. 요청은 순차적이고 기본 간격은 1.5초다. CI 에 스케줄 크롤을 걸지 않는다.

## 기여

카드를 추가하려면 **카드사 공식 상품 페이지 URL** 이 반드시 필요하다.
검색 결과 링크나 비교 사이트 링크는 출처로 인정하지 않는다.

1. `data/issuers.json` 의 `allowed_domains` 에 해당 도메인이 있는지 확인 (없으면 함께 추가)
2. 공식 페이지에 **실제로 적혀 있는 값만** 추가. 불확실하면 필드를 비우고 `confidence: low`
3. `source.kind` 는 `issuer_official_page`, 사람이 확인했으면 `review_status: human_reviewed`
4. `npm run validate && npm test` 통과

자세한 절차는 [`docs/sources.md`](docs/sources.md#미수록-카드사를-추가하는-방법) 참고.

## 라이선스

코드는 [MIT](LICENSE). `data/` 의 개별 사실은 각 카드사에 귀속되는 정보이며
상표는 각 권리자의 것이다. 제휴·후원 관계가 없다.
자세한 내용은 [`docs/legal-notes.md`](docs/legal-notes.md) 를 읽어라.
