#!/usr/bin/env bash
# go-live.sh — 서버 + Cloudflare 터널을 함께 띄워 공개 URL을 만든다.
#  - 서버는 127.0.0.1에만 바인딩(직접 노출 차단), 외부 접속은 HTTPS 터널로만.
#  - 무계정 quick tunnel: 실행할 때마다 랜덤 *.trycloudflare.com 주소가 새로 발급된다.
# 중지: Ctrl+C  (서버·터널 모두 종료)
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-3000}"
SRV_LOG="/tmp/kis-server.log"
TUN_LOG="/tmp/kis-tunnel.log"

cleanup() { echo; echo "🛑 종료 중..."; kill "${SRV_PID:-0}" "${TUN_PID:-0}" 2>/dev/null || true; }
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

echo "▶ Cloudflare 터널 시작..."
cloudflared tunnel --url "http://127.0.0.1:$PORT" >"$TUN_LOG" 2>&1 &
TUN_PID=$!

# 공개 URL 추출 (최대 30초 대기)
URL=""
for i in $(seq 1 60); do
  URL=$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUN_LOG" | head -1 || true)
  [ -n "$URL" ] && break
  sleep 0.5
done

echo
echo "════════════════════════════════════════════════════"
if [ -n "$URL" ]; then
  echo "  🌐 공개 주소:  $URL"
  echo "  ⚠️  첫 가입자가 admin이 됩니다 — 접속 즉시 본인 계정부터 가입하세요!"
else
  echo "  ❌ URL 추출 실패 — $TUN_LOG 확인"
fi
echo "  중지: Ctrl+C"
echo "════════════════════════════════════════════════════"

wait
