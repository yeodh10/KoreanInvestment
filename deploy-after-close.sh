#!/bin/sh
# 장마감 후 1회 배포 — git pull + 테스트 + autotrade.service 재시작 + 헬스체크. systemd-run 트랜지언트 타이머로 호출.
# 결과는 deploy-after-close.log에 기록(무인 실행이라 콘솔 대신 파일로 보고).
cd /home/ubuntu/KoreanInvestment || exit 1
LOG=/home/ubuntu/KoreanInvestment/deploy-after-close.log
TS=$(TZ=Asia/Seoul date '+%Y-%m-%d %H:%M:%S KST')
# 헬스체크 헬퍼 — 운영 호스트에 curl이 없어(curl: not found) 재시작 후 검증이 스킵되던 문제 수정.
# Node 빌트인(http)만 사용. 상태코드가 찍히면 HTTP 서버 응답 중(200/401 무관 = 정상),
# ERR/TIMEOUT만 실제 장애. 5초 타임아웃으로 무인 배포가 멈추지 않게 한다.
hc() {
  node -e 'const http=require("http");const to=setTimeout(()=>{console.log("TIMEOUT");process.exit(0)},5000);http.get(process.argv[1],r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>{clearTimeout(to);console.log(r.statusCode+" "+d.slice(0,120).replace(/\n/g," "));process.exit(0)})}).on("error",e=>{clearTimeout(to);console.log("ERR "+e.code);process.exit(0)})' "$1"
}
{
  echo "===== [$TS] 배포 시작 ====="
  # 0) 최신 코드 받기 — ff-only(충돌·로컬수정·네트워크 실패 시 안전 중단, 기존 코드 유지)
  PULL_OUT=$(git pull --ff-only 2>&1); PULL_RC=$?
  PULL_LAST=$(echo "$PULL_OUT" | tail -1)
  echo "  git pull: $PULL_LAST"
  if [ "$PULL_RC" != "0" ]; then echo "  ❌ git pull 실패(rc=$PULL_RC) — 배포 중단(기존 코드 유지)"; echo "$PULL_OUT"; echo; exit 1; fi
  # 1) 배포 직전 테스트 그린 재확인 — 하나라도 실패하면 재시작 중단(운영 보호)
  FAIL=0
  for t in engine realtime fallback journal auth; do
    R=$(node tests/$t-test.js 2>/dev/null | tail -1)
    echo "  test $t: $R"
    echo "$R" | grep -q "0 실패" || FAIL=1
  done
  if [ "$FAIL" != "0" ]; then
    echo "  ❌ 테스트 실패 감지 — 재시작 중단(기존 코드 유지)"; echo; exit 1
  fi
  # 2) 재시작
  systemctl restart autotrade.service
  sleep 3
  echo "  service: $(systemctl is-active autotrade.service)"
  # 3) 헬스체크
  echo "  /auth/me: $(hc 'http://127.0.0.1:3000/auth/me')"
  echo "  /api/orderbook(005930): $(hc 'http://127.0.0.1:3000/api/orderbook?code=005930')"
  echo "  WS 최근로그: $(journalctl -u autotrade.service -n 40 --no-pager 2>/dev/null | grep -o 'WebSocket 연결됨' | tail -1)"
  echo "===== 배포 종료 ====="
  echo
} >> "$LOG" 2>&1
