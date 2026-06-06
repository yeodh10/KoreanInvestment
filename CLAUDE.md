# AutoTrade KR — 프로젝트 컨텍스트 (Claude 인수인계)

> 한국투자증권(KIS) OpenAPI 기반 주식 자동매매 + 수동매매 웹 서비스.
> 현재 모의투자(VTS)로 운영 검증 중이며 **다중 사용자 서비스 출시 예정**.
> Node.js 빌트인만 사용 (npm 의존성 0). 마지막 갱신: 2026-06-05.

## 1. 아키텍처

```
proxy-server.js   서버 코어 (~2,050줄). HTTP 서버·KIS 프록시·우선순위 큐·SWR 캐시·
                  토큰 관리·주문/취소·자동취소·prefetch·뉴스/수급 캐시·정적 서빙(화이트리스트)
auto-trader.js    자동매매 엔진. 골든크로스+RSI 신호, 손절/익절, 일일 손실 한도,
                  포지션 소유권 분리(botPositions), 미체결 가드, KST 시간대, 공휴일
kis-realtime.js   KIS WebSocket 클라이언트 (RFC6455 직접 구현) → SSE 팬아웃.
                  무수신 watchdog(90초), LRU 구독 한도(40), 체결통보 AES 복호화, 유휴 피드 정리
auth.js           멀티유저 인증. scrypt 해시, AES-256-GCM 설정 암호화, 세션 토큰 SHA-256 저장,
                  원자적 파일 쓰기, 유저별 KIS 설정(user-configs/)
order-journal.js  주문 저널 (SQLite/node:sqlite, WAL). 접수/부분체결/체결/취소, 잔고 대조 reconcile,
                  userId 격리. 각 연산이 단일 SQL/트랜잭션 → 멀티유저 동시 쓰기에도 기록 유실 없음.
                  DB=order-journal.db (env JOURNAL_DB로 재정의, 테스트는 임시 DB). 레거시 JSON 자동 1회 이관.
data-fallback.js  "빈 화면 금지" 폴백. lastGood 영속 캐시(data-cache.json), 합성 호가 사다리, 환율 폴백
app.html          단일 파일 프론트 (~3,900줄). 토스 모티브 다크 UI, Pretendard+tabular-nums
tests/            engine(17)·realtime(20)·fallback(21)·journal(13) = 71개. node tests/xxx-test.js
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
`users.json`(계정) · `sessions.json`(세션) · `.enckey`(암호화 키 — **이거 없으면 user-configs 복호화 불가**) ·
`user-configs/`(유저별 KIS 키·자동매매 상태·**botPositions**) · `order-journal.db`(주문 기록 SQLite) ·
`data-cache.json`(캐시 워밍). 안 가져오면: 재가입(첫 가입자=admin) + KIS 키 재입력 + botPositions 재등록 필요.

서버 타임존 무관하게 동작하도록 설계됨(KST는 epoch+9h 계산). 단 콘솔 로그의 `toLocaleTimeString`은
서버 로컬시간으로 찍히므로 보기 편하려면 `TZ=Asia/Seoul node proxy-server.js` 권장.

## 3. 핵심 설계 결정 (변경 시 주의)

- **포지션 소유권 분리**: 엔진은 자기가 매수한 수량(`state.botPositions`)만 매도. 수동 매수분 불가침.
  설정 `safety.protectManual`(기본 ON). 계좌 갱신 때 실보유와 대조해 봇 지분 자동 축소.
  배경: 사용자가 수동으로 산 삼성전자를 엔진이 RSI 과매수로 팔아버린 사고.
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

## 5. 백로그 (우선순위순)

1. **출시 전 비기능**: 약관·투자 손실 고지·로그 보존 정책 (M6, 미착수)
2. scrypt 동기 실행(로그인 폭주 시 이벤트 루프 블로킹) — 비동기 전환 검토
3. 거래량 상위 자동매수에 투자경고/위험 종목 필터 없음
4. 합성호가·오래된 lastGood 신선도 라벨(asOf) 노출
5. 휴장일 테이블 연 1회 갱신(2027~), 임시휴장·단축장 미반영
6. 주문/거래 페이지 슬림화(중복 탭 제거) — 역할: 정밀 수동주문+주문관리 전용으로 합의됨

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
