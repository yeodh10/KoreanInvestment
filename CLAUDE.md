# AutoTrade KR — 프로젝트 컨텍스트 (Claude 인수인계)

> 한국투자증권(KIS) OpenAPI 기반 주식 자동매매 + 수동매매 웹 서비스.
> 현재 모의투자(VTS)로 운영 검증 중이며 **다중 사용자 서비스 출시 예정**.
> Node.js 빌트인만 사용 (npm 의존성 0). 마지막 갱신: 2026-06-10.

## 1. 아키텍처

```
proxy-server.js   서버 코어 (~2,050줄). HTTP 서버·KIS 프록시·우선순위 큐·SWR 캐시·
                  토큰 관리·주문/취소·자동취소·prefetch·뉴스/수급 캐시·정적 서빙(화이트리스트)
auto-trader.js    자동매매 엔진. 골든크로스+RSI 신호, 손절/익절, 일일 손실 한도,
                  포지션 소유권 분리(botPositions), 미체결 가드, KST 시간대, 공휴일
kis-realtime.js   KIS WebSocket 클라이언트 (RFC6455 직접 구현) → SSE 팬아웃.
                  무수신 watchdog(90초), LRU 구독 한도(40), 체결통보 AES 복호화, 유휴 피드 정리
auth.js           멀티유저 인증 (users·sessions = SQLite/node:sqlite, WAL). scrypt 해시(**비동기** —
                  로그인/가입 폭주에도 이벤트루프 비블로킹, 해시는 DB 트랜잭션 밖에서 계산), 세션 토큰
                  SHA-256 저장(원본키 폴백 없음), 동시 가입/로그인 무손실(트랜잭션). AES-256-GCM으로
                  유저별 KIS 설정 암호화(user-configs/ 파일 유지). DB=auth.db (env AUTH_DB). 레거시 JSON 자동 이관.
order-journal.js  주문 저널 (SQLite/node:sqlite, WAL). 접수/부분체결/체결/취소, 잔고 대조 reconcile,
                  userId 격리. 각 연산이 단일 SQL/트랜잭션 → 멀티유저 동시 쓰기에도 기록 유실 없음.
                  DB=order-journal.db (env JOURNAL_DB로 재정의, 테스트는 임시 DB). 레거시 JSON 자동 1회 이관.
data-fallback.js  "빈 화면 금지" 폴백. lastGood 영속 캐시(data-cache.json), 합성 호가 사다리, 환율 폴백.
                  cached 응답에 asOf(마지막 정상시각) 동봉 → 프론트 신선도 라벨("합성호가"/"마감·N분 전")
app.html          단일 파일 프론트 (~4,600줄). 토스 모티브 다크 UI, Pretendard+tabular-nums. 라이트테마 토글, PWA
tests/            engine(71)·realtime(23)·fallback(23)·journal(26)·auth(18) = 161개. node tests/xxx-test.js
```

## 2. 우분투 실행

```bash
# Node 22+ 설치 후
git clone https://github.com/yeodh10/KoreanInvestment.git && cd KoreanInvestment
chmod +x start.sh
./start.sh            # 또는 node proxy-server.js → http://localhost:3000
# 테스트 (71개 전부 통과해야 정상)
node tests/engine-test.js && node tests/realtime-test.js && node tests/fallback-test.js && node tests/journal-test.js
```

**⚠️ git에 없는 민감 파일 — 옛 PC에서 수동 복사 필요 (.gitignore 목록):**
`auth.db`(계정·세션 SQLite) · `.enckey`(암호화 키 — **이거 없으면 user-configs 복호화 불가**) ·
`user-configs/`(유저별 KIS 키·자동매매 상태·**botPositions**) · `order-journal.db`(주문 기록 SQLite) ·
`data-cache.json`(캐시 워밍). 안 가져오면: 재가입(첫 가입자=admin) + KIS 키 재입력 + botPositions 재등록 필요.
(WAL 사용 — 백업 시 `auth.db`/`order-journal.db`의 `-wal`·`-shm` 사이드카도 함께, 또는 서버 정지 후 복사.)

서버 타임존 무관하게 동작하도록 설계됨(KST는 epoch+9h 계산). 단 콘솔 로그의 `toLocaleTimeString`은
서버 로컬시간으로 찍히므로 보기 편하려면 `TZ=Asia/Seoul node proxy-server.js` 권장.

## 3. 핵심 설계 결정 (변경 시 주의)

- **포지션 소유권 분리**: 엔진은 자기가 매수한 수량(`state.botPositions`)만 매도. 수동 매수분 불가침.
  설정 `safety.protectManual`(기본 ON). 계좌 갱신 때 실보유와 대조해 봇 지분 자동 축소.
  배경: 사용자가 수동으로 산 삼성전자를 엔진이 RSI 과매수로 팔아버린 사고.
- **위험종목 자동매수 차단**: `safety.avoidWarnStocks`(기본 ON). BUY 후보에 한해 매수 직전
  `deps.getStockFlags`(proxy `fetchStockFlags`→inquire-price)로 관리/투자경고·위험/거래정지/정리매매 판정,
  blocked면 매수 스킵(`🚫` 로그). 조회 실패 시엔 막지 않음(과차단 방지 — KIS 주문거부가 2차 게이트).
- **휴장일/단축장**: `auto-trader.js` `KRX_HOLIDAYS`(2026·2027) + `SHORTENED_SESSIONS`(수능 등 늦장개장
  10:00~16:30). `isMarketOpen`이 `marketHours(date)`로 개장시간 판정 → 개장 전 헛주문 방지. ⚠️음력 기반
  (설·부처님·추석)은 ±1일 오차 가능 — 매년 KRX 공식 캘린더로 확정. 테이블이 올해 미만이면 부팅 시 경고.
- **멀티유저 격리**: 요청별 userId는 `AsyncLocalStorage`(proxy-server 상단 `_als`). 전역 변수 금지.
  cfg 객체에 `__userId` 각인 → `saveConfig`가 컨텍스트 없이도 올바른 유저 파일에 저장.
  저널은 userId 정확 일치만 매칭(레거시 무소유 엔트리는 전역 컨텍스트에서만 보임).
- **KIS 호출 규율**: 모든 시세 호출은 `kisProxy`(우선순위 큐, 기본 'high', 백그라운드만 'low' 명시).
  주문/취소는 `kisPost`(큐 우회 + 600ms 간격 + EGW00201 재시도). 토큰은 1분 1회 제한 →
  메모리 미러(`_tokenIssue[].token`)로 만료 겹침에도 주문 불가 구간 없음.
- **SWR 캐시**: price/account/vol/market/news/investor 전부 "캐시 즉시 응답 + 백그라운드 갱신".
  `/api/prices`는 캐시 없는 종목 중 6개만 동기, 나머지 백그라운드(타임아웃 방지, 점진 표시).
  가격·일봉 캐시는 `data-cache.json`에 영속(`persist:price`, `persist:chart`) → 재시작도 즉시.
- **실시간**: 피드는 appKey당 1개. 콜백은 클라이언트별 Map(덮어쓰기 금지). MAX_REG=40
  (시총30 시세표+호가 수용). 90초 무수신이면 죽은 연결로 보고 강제 재연결. 캐시 자정 삭제는 KST 자정.
- **주문 안전장치(프론트)**: confirm(모의/실전 표시)+중복제출 가드+수량 검증. XSS는 `esc()`/`safeUrl()`
  필수(외부 문자열 innerHTML 직전). 마지막 본 종목은 localStorage `lastStock`.

## 4. 지금까지의 작업 (2026-06-04~05, 커밋 순)

1. **전수 코드리뷰** — `코드리뷰-디버깅-20260604.md` 참고 (CRITICAL 6·HIGH 22·MEDIUM 다수)
2. **1차 보안**: 로그인 우회 원복·XSS 전면 이스케이프·주문 확인창·unit=0 무한루프 차단
3. **2차 안정화**: WS watchdog·주문 예외 가드·미체결 연동(중복매도 차단)·priority 기본 high·소스 노출 차단
4. **3차 기능**: 자동매매 30종목(우량주)·체결/뉴스/수급 즉시응답·공휴일 캘린더(2026)·토큰 미러·부분체결 보존
5. **대시보드 개편**: 시총TOP30 시세탭(2열 실시간)·총자산+평가손익(수익률%) 통합·보유종목 토스식 리스트
   (매입금액 메인)·호가창 현재가 중앙·뉴스 균일 행+시장뉴스 7:3 혼합·Pretendard 폰트·캐시 첫 페인트
6. **포지션 소유권 분리** (위 3절)
7. **멀티유저 하드닝 M1~M5** (위 3절) + 리눅스 호환(KST 자정)
8. **고정 주소 전환 (06-06)**: Cloudflare quick tunnel → **Tailscale Funnel** `https://kis.tail8eca6a.ts.net`.
   `clientIp()` 신뢰 헤더를 `TRUSTED_PROXY` env로 분기(기본 tailscale=XFF) — Tailscale 뒤에서
   CF-Connecting-IP는 방문자 위조가 그대로 통과함을 실측 확인하고 수정. DEPLOY.md 참고.
9. **출시 전 최종 리뷰 (06-07)**: 5영역 전수 리뷰 → CRITICAL 4·HIGH 다수 수정, 테스트 71→99.
   핵심: 매도 봇지분·실현손익을 **잔고 대조(실제 체결) 시점으로 일원화**(접수≠체결, 손절은 시장가),
   보유 손절은 실시간가로 판정, 실시간 WS connecting 고착 해제, 멀티탭 체결통보 단일 확정.
   `QA-최종점검-20260607.md` 참고. ⚠️ 실전 전 모의에서 부분체결·급락 시나리오 검증 권장.
10. **운영 상시화 + 기능 (06-07)**: systemd(autotrade.service) 상시 운영·자동재시작, 평일 09:05·10:00
    장중 자동 점검(autotrade-check.timer + market-check.js), users·sessions·주문저널 SQLite(WAL) 전환,
    SWR 캐시(stockinfo/ob/tick)·계좌 종합 패널·매수가능조회·정렬·약관.
11. **출시 최종 검증 (06-08)**: 6영역 심층+적대적 재검증 → 테스트 99→131. 저널 userId WHERE(odno충돌),
    unhandledRejection, 유령손익(_sellPending) 차단, 반응속도(prefetch 워밍·선페인트·병렬), 서버 입력검증.
    `QA-최종검증-20260608.md` 참고.
12. **기능 추가 (06-08~09, 커밋)**: AI 세팅 비서(claude CLI, 추가비용 0)·라이트(화이트) 테마 토글·
    포트폴리오 테이블 정렬·종목당 한도 500만·봇 한 종목 1회 진입(분할 몰빵 차단)·안드로이드 PWA.
    **전수조사 1~5차**: 체결통보 다중체결 유실(CRITICAL)·주문 중복체결 방지·총자산 출렁·거래내역 시장가
    체결가 ₩0 표시 보정 등. 테스트 131→151.
13. **백로그 6종 일괄 처리 (06-10)**: ⓐ scrypt **비동기** 전환(이벤트루프 비블로킹) ⓑ 위험종목 자동매수
    차단(avoidWarnStocks) ⓒ 호가 신선도 라벨(asOf·합성/마감) ⓓ 휴장일 2027 + 단축장(늦장개장) 메커니즘 +
    갱신 경고 ⓔ 약관 제7조(로그·기록 보존) ⓕ 거래 페이지 슬림화(뉴스/수급 중복 탭 제거→대시보드 일원화,
    /api/investor 백그라운드 부하 감소). 테스트 151→**161**. (장중 작업 — **장마감 후 배포** 원칙)

## 5. 백로그 (우선순위순)

1. **휴장일 음력 추정 확정**: 2027 설(2/5·2/8)·부처님오신날(5/13)·추석(9/14~16)은 윤달 ±1일 오차 가능 —
   KRX 공식 캘린더 공개 시 확정. 단축장(수능 2026-11-19 등) 실제 날짜·시간도 공식 발표로 재확인.
2. 휴장일 테이블 연 1회 갱신(2028~). 임시휴장(거래소 조치)은 여전히 미반영(KIS 주문거부가 2차 방어).
3. 거래 페이지에서 떼어낸 `loadNews`/`loadInvestor`(app.html)는 호출처 없는 고아 함수 — 추후 정리 가능.

> ✅ **2026-06-10 백로그 6종 전부 처리됨** (위 4절 13번): scrypt 비동기·위험종목 필터·신선도 라벨·
>   휴장일2027/단축장·약관 제7조(로그보존)·거래페이지 슬림화. 약관(제1~6조)·투자위험 고지·가입 동의는
>   06-07~08에 이미 구현돼 있었음(M6의 로그 보존 조항만 06-10에 보강).
> ✅ 9번(매도 접수=체결, 5분 묵은 손절, 부분체결 오삭감, 15:20 알림)·실시간 connecting 고착·
>   멀티탭 체결통보·htsId·세션 폴백 등은 2026-06-07 최종 리뷰에서 수정됨 (`QA-최종점검-20260607.md`).

## 6. 운영 체크리스트 (장 시작 전)

```
1. node proxy-server.js → 배너 확인, "포트 사용 중" 없을 것
2. [실시간] 🟢 WebSocket 연결 로그 확인
3. 대시보드 시세탭 가격 움직임 + /api/debug(관리자)로 큐 적체(high<10) 확인
4. 자동매매 ON 확인 (전략 설정), 보유종목 봇 지분 확인
```

## 7. 작업 스타일 (사용자 선호)

- 커밋은 매 수정마다 X — **큰 단위 마무리 때 한 번**, 커밋 권할 땐 명령어 같이 제시
- 검증 명령은 사용자 셸 확인: PowerShell `;` / cmd·bash `&&`
- UI는 토스(Toss) 모티브: 숫자 강조, 수익=빨강·손실=파랑, 즉시 페인트, 빈 화면 금지
- 수정 후 가능하면 브라우저로 직접 확인(스크린샷)하고 보고
- 사용자는 빠른 실행을 선호하지만 **해석이 갈리는 요구는 먼저 한 줄로 확인**하고 진행할 것
