#!/usr/bin/env bash
# go-live.sh — 서버를 띄우고 Tailscale Funnel 고정 주소로 공개한다.
#  - 서버는 127.0.0.1에만 바인딩(직접 노출 차단), 외부 접속은 HTTPS Funnel로만.
#  - 주소는 고정: https://kis.tail8eca6a.ts.net (재시작·재부팅해도 동일)
#  - 사전 1회 설정(이미 완료됨): tailscale up 로그인 + tailscale funnel --bg 3000
#  - 클라이언트 IP는 X-Forwarded-For 신뢰(TRUSTED_PROXY=tailscale 기본).
#    Cloudflare 터널로 되돌리면 TRUSTED_PROXY=cloudflare 로 실행할 것.
# 중지: Ctrl+C (서버만 종료 — Funnel 설정은 tailscaled에 남아 있어 무해)
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-3000}"
SRV_LOG="/tmp/kis-server.log"

cleanup() { echo; echo "🛑 종료 중..."; kill "${SRV_PID:-0}" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

echo "▶ 서버 시작 (127.0.0.1:$PORT, KST)"
TZ=Asia/Seoul HOST=127.0.0.1 PORT="$PORT" node proxy-server.js >"$SRV_LOG" 2>&1 &
SRV_PID=$!

# 서버가 응답할 때까지 대기 (최대 15초)
for i in $(seq 1 30); do
  if node -e "require('http').get('http://127.0.0.1:$PORT/api/auth/me',r=>process.exit(0)).on('error',()=>process.exit(1))" 2>/dev/null; then
    echo "✅ 서버 준비됨"; break
  fi
  sleep 0.5
  if [ "$i" = "30" ]; then echo "❌ 서버가 뜨지 않음 — $SRV_LOG 확인"; cat "$SRV_LOG"; exit 1; fi
done

# Tailscale Funnel 점검 (꺼져 있으면 자동 활성화)
if ! tailscale funnel status 2>/dev/null | grep -q "Funnel on"; then
  echo "▶ Funnel 비활성 — 활성화 시도..."
  tailscale funnel --bg "$PORT" \
    || { echo "❌ Funnel 활성화 실패 — 'tailscale up' 로그인 상태 확인"; exit 1; }
fi

URL=$(tailscale funnel status 2>/dev/null | grep -Eo 'https://[a-z0-9.-]+\.ts\.net' | head -1 || true)
[ -n "$URL" ] && echo "$URL" > CURRENT-URL.txt

echo
echo "════════════════════════════════════════════════════"
if [ -n "$URL" ]; then
  echo "  🌐 고정 공개 주소:  $URL"
else
  echo "  ❌ Funnel 주소 확인 실패 — 'tailscale funnel status' 확인"
fi
echo "  중지: Ctrl+C"
echo "════════════════════════════════════════════════════"

wait
