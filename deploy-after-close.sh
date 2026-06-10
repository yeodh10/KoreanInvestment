#!/bin/sh
# 장마감 후 1회 배포 — autotrade.service 재시작 + 헬스체크. systemd-run 트랜지언트 타이머로 호출.
# 결과는 deploy-after-close.log에 기록(무인 실행이라 콘솔 대신 파일로 보고).
cd /home/ydh/KoreanInvestment || exit 1
LOG=/home/ydh/KoreanInvestment/deploy-after-close.log
TS=$(TZ=Asia/Seoul date '+%Y-%m-%d %H:%M:%S KST')
{
  echo "===== [$TS] 배포 시작 (백로그 6종) ====="
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
  echo "  /auth/me: $(curl -s -o /dev/null -w '%{http_code}' localhost:3000/auth/me)"
  echo "  /api/orderbook(005930) head: $(curl -s 'localhost:3000/api/orderbook?code=005930' | head -c 160)"
  echo "  WS 최근로그: $(journalctl -u autotrade.service -n 40 --no-pager 2>/dev/null | grep -o 'WebSocket 연결됨' | tail -1)"
  echo "===== 배포 종료 ====="
  echo
} >> "$LOG" 2>&1
