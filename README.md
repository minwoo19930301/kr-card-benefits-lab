# kr-card-benefits-lab

[대시보드](https://minwoo19930301.github.io/kr-card-benefits-lab/) · [저장소](https://github.com/minwoo19930301/kr-card-benefits-lab)

카드사 **공식 상품 페이지와 공개 피드**에서 읽은 한국 신용·체크카드 정보를 정리하는 리서치 저장소입니다.
출처가 붙은 JSON 데이터와 검색·비교용 정적 화면을 제공합니다. 공식 원문 자료와 사용자가 복구를 요청한 기존 1,563개 저장 자료를 구분해서 제공합니다. 이전 자료는 현재 혜택·발급 상태가 재확인되지 않은 역사적 스냅샷입니다.

- 카드 데이터: [`data/cards.json`](data/cards.json)
- 카드사·공식 도메인: [`data/issuers.json`](data/issuers.json)
- 스키마: [`data/cards.schema.json`](data/cards.schema.json), [필드 설명](docs/schema.md)
- 출처·수집 방식: [sources.md](docs/sources.md)
- 계산·필터 기준: [methodology.md](docs/methodology.md)

## 먼저 실행하기

Node.js 22 이상이 필요합니다. 기본 빌드·검증에는 별도 npm 패키지 설치가 필요하지 않습니다.

```bash
npm test
npm run validate
npm run build
npm run serve
```

`npm run serve`는 빌드 후 `http://localhost:8787`에서 화면을 엽니다. 저장된 데이터만 보며 수집을 실행하지 않습니다.
`npm run validate -- --check-urls`는 공식 URL 도달성까지 확인하므로 네트워크 요청이 발생합니다.

## 화면에서 확인할 것

- 카드마다 **공식 원문·실제 수집일·사람 검수 여부**를 표시합니다.
- 세금의 **전월실적 포함**과 **적립·할인 대상**을 각각 필터링합니다. 미확인 값은 포함 또는 제외로 취급하지 않습니다.
- 최근 확인은 원문 수집일로부터 **30일 이내**라는 뜻입니다. 현재 발급 가능하거나 모든 혜택이 검수됐다는 뜻은 아닙니다.
- 카드사별 수집 현황은 이번 실행의 성공·실패와 **이전 자료 유지**를 나눠 보여줍니다. 저장 카드 수를 이번 수집 성공 수로 읽으면 안 됩니다.
- 세금 납부 **기간 행사**는 카드 상품의 상시 혜택과 별도 표시합니다. 종료·예정·기간 미확인 행사는 진행 중 행사와 구분합니다.
- 피킹률은 확인된 월 한도를 모두 채운다는 가정의 추정치입니다. 정보가 부족하면 산출하지 않습니다.

## 공식 자료 갱신

공통 수집기는 등록된 공식 URL을 읽고, 카드사별 파서와 스키마 검증을 통과한 결과만 반영합니다.
Bright Data는 원문을 가져오는 전송 수단이며 데이터의 출처는 계속 **카드사 URL**입니다.

### Bright Data

실행 환경에 `BRIGHT_DATA_API_KEY`와 **이미 생성된 Web Unlocker zone 이름**인 `BRIGHT_DATA_ZONE`이 필요합니다.
키나 zone을 코드·데이터·커밋에 넣지 마세요. 수집기는 zone을 자동 생성하지 않습니다.

```bash
# 최대 요청 수를 제한해 후보 결과와 실행 보고서 생성
npm run collect:official -- --transport brightdata --limit 400

# 검증을 통과한 결과를 data/에 반영
npm run collect:official -- --transport brightdata --limit 400 --apply
```

`--apply`가 없어도 실제 수집 요청은 발생합니다. Bright Data 사용량과 요금이 발생할 수 있습니다.
키를 파일로 관리한다면 저장소 밖 파일을 `--key-file /absolute/path/to/credentials`로 지정하고,
필요하면 `--key-name BRIGHT_DATA_API_KEY`를 함께 지정합니다. 파일의 선택한 변수만 읽으며 셸 코드로 실행하지 않습니다.
zone은 환경변수 또는 `--zone`으로 지정합니다.

**2026-09-21 갱신:** 초기 점검 이후 사용자가 Web Unlocker zone을 설정했고 실제 카드사 원문 수집을 시작했습니다.
현재 실행 결과는 `data/collection-report.json`과 `data/collection-evidence.json`을 기준으로 확인합니다.

### 공식 사이트 직접 요청

```bash
npm run collect:official -- --transport direct --limit 400
npm run collect:official -- --transport direct --limit 400 --apply
```

직접 요청도 같은 공식 도메인·파서·품질 검증을 거칩니다. HTML 응답을 받았어도 동적 연회비나 혜택을 읽지 못할 수 있습니다.
읽지 못한 값은 성공으로 꾸미지 않으며, 기존 자료보다 필수 정보가 줄어든 후보는 반영하지 않습니다.
직접 요청 결과를 Bright Data로 수집한 것처럼 표시하지 않습니다.

`--issuer shinhan`처럼 한 카드사로 좁히거나 `--concurrency`(1~20)로 동시 요청 수를 조정할 수 있습니다.
카드사별 연속 실패 중단 기준은 `--failure-threshold`(기본 3)입니다. 알려진 URL을 모두 확인할 때는 요청 예산 안에서 기준을 높일 수 있습니다.
요청 상한·인증·권한·할당량 오류와 카드사별 연속 실패는 실행 보고서에서 확인합니다.

### 공식 공개 API 보완

```bash
# 마지막 수집 보고서를 기준으로 우리·신한 공개 API 및 현대 상세 HTML 보완
npm run enrich:official
```

상품코드·이름·카드 유형을 대조하며, 보완 원문 URL·해시·수집일·전송 방식을 별도로 기록합니다.
신한카드 연회비는 본인 카드 근거가 명확한 경우만 적용합니다. 기존 수치 조건이 사라지면 이전 자료를 유지합니다.
이 명령은 공식 공개 API·HTML에 직접 요청하며 Bright Data 요청 건수와 구분됩니다.
직접 수집의 준비 디렉터리를 인자로 주면 검증된 직접 수집 결과도 병합합니다.
`collect:official -- --cache-only`는 검증된 Bright Data 캐시만 통합하며 새로운 유료 요청을 만들지 않습니다. 캐시 통합 단계의 요청 수 0은 앞선 수집 비용이 0이라는 뜻이 아닙니다.

### 저장과 재검증

후보 결과와 보고서는 `work/collections/<run_id>/`에 준비됩니다. `--apply`일 때 검증된 결과를 정본에 반영합니다.
실패·미시도·추출 거절된 카드의 이전 데이터와 수집일은 유지합니다. 목록에서 보이지 않았다는 이유만으로 단종 처리하거나 삭제하지 않습니다.

```bash
npm run validate
npm test
npm run build
```

원문 HTML은 **저장소 밖 캐시**에만 보관하고 커밋·사이트 배포에 포함하지 않습니다.
기본 캐시는 저장소의 상위 디렉터리에 있는 `bd-card-cache/`이며 `--cache-dir`로 다른 외부 경로를 지정할 수 있습니다.
추적용 보고서에는 URL·수집 시각·응답 해시·시도 결과를 남깁니다. 원문 전체, 인증 키, 쿠키는 공개 산출물에 넣지 않습니다.

## 자료의 한계

빈 값은 **혜택 없음이 아니라 미확인**입니다. 현재 카드 스키마에서는 미확인 필드를 생략하며 0이나 `false`로 대신 채우지 않습니다.
자동 추출 결과는 `review_status: machine_extracted`로 남기고, 사람이 원문을 대조한 경우에만 `human_reviewed`로 표시합니다.
숫자가 온전히 읽힌 정도인 `confidence`와 사람 검수 여부는 서로 다릅니다.

파일 생성일 `generated_at`, 카드 갱신일 `updated_at`, 원문 수집일 `source.retrieved_at`도 서로 다릅니다.
파일을 다시 빌드했다고 모든 카드가 재확인되는 것은 아닙니다. 완전한 상품 목록이나 현재 발급 가능성을 보증하지 않습니다.
신청·세금 납부 전에는 공식 상품설명서와 행사 조건을 다시 확인하세요.

## 구조

```text
data/
  cards.json / cards.schema.json  카드 정본과 스키마
  issuers.json                   카드사와 공식 도메인
  official-seeds.json             추가로 조사한 공식 상품 URL
  collection-report.json         카드사별 수집 요약 (실행 후 생성)
  collection-evidence.json       URL별 시도·해시·검증 결과 (실행 후 생성)
  card-events.json                상품과 별도로 관리하는 기간 행사
scripts/
  collect-official-bd.mjs         공통 공식 자료 수집 진입점
  lib/brightdata.mjs              Bright Data 전송·요청 예산·캐시
  collect-issuer-feed.mjs         기존 우리카드 공개 피드 수집기·파서
  collect-issuer-rendered.mjs     기존 로컬 Chrome 수집기·파서
  validate.mjs / build-site.mjs  정본 검증과 정적 사이트 빌드
site/
  app.js filters.js evidence.js picking.js index.html styles.css
docs/ tests/
```

기존 피드·로컬 Chrome 수집기는 별도 경로로 남아 있습니다. 로컬 Chrome 수집은 Chrome 설치가 필요하며,
공통 수집기의 Bright Data 요청과 같은 실행 방식이 아닙니다. 상세 차이는 [출처 문서](docs/sources.md)에 있습니다.

## 기여와 라이선스

공식 상품 URL과 실제 읽은 근거를 함께 추가하고 `npm run validate`, `npm test`를 통과시켜 주세요.
자동 검증 통과만으로 사람 검수 표시를 바꾸지 마세요.

코드는 [MIT](LICENSE)입니다. 코드 라이선스가 카드사 문구·상표 등 제3자 자료의 권리를 부여하지는 않습니다.
공식 원문을 대량 복제하는 대신 필요한 사실·요약과 출처를 저장합니다. [이용상 주의](docs/legal-notes.md)를 참고하세요.

### 카드 디자인 이미지

목록과 상세 화면은 `data/card-images.json`에 기록한 카드사 공식 이미지를 표시합니다. 현재 공식 원문 816개 상품 중 778개 이미지를 복구했고, 원본 다운로드 실패 또는 상품 식별이 일치하지 않는 38개는 `이미지 준비 중`으로 표시합니다(동일 상품의 이전 사진이 있는 경우 출처를 유지해 보완). 이미지는 `site/images/cards/`에 원본 그대로 저장하며, 이미지 URL·상품 출처·확인일·SHA-256을 함께 남깁니다. 카드 디자인의 권리는 각 카드사에 있습니다.

`python3 scripts/collect-card-images.py`는 작업 폴더 옆 `bd-card-cache/`에 저장한 공식 페이지와 공개 상품 응답에서 이미지를 복구합니다. 이미 검증한 파일은 해시가 일치하면 재사용합니다. 캐시가 없는 새 환경에서는 누락 이미지가 자동으로 모두 복구되지 않으며, 기존 수집 절차로 공식 페이지 캐시를 준비해야 합니다.

### 이전 전체 목록 복구 (2026-09-22)

기존 1,563개 카드와 사진, 상세 혜택을 모두 보존했습니다. 공식 816개와 이름·발급사·유형이 유일하게 일치하는 436개를 연결하여 화면에는 중복을 합친 1,943개를 표시합니다. 공식 재확인 전인 1,127개는 별도 표시하며, 이전 자료의 금액을 현재 연회비·실적 계산에 사용하지 않습니다. 이 숫자는 현재 발급 가능한 전체 카드 수가 아닙니다.

세로 원본 사진은 목록과 상세 화면에서 가로로 회전하며 원본 파일은 유지합니다. 이전 상세 내용은 클릭할 때 불러오고 목록은 60개씩 표시합니다. `data/archive-catalog.json`과 `site/archive-details/`에는 복구 자료, `data/cards.json`에는 공식 원문 자료를 분리해 저장합니다. `scripts/restore-archive.mjs`는 사용자가 보유한 원본 저장 파일만 읽고 외부 수집을 하지 않습니다.
