#!/usr/bin/env bash
# cloudflared quick tunnel 하나를 실행하고, 발급된 공개 URL을 CURRENT-URL.txt에 기록한다.
# cloudflared가 종료되면 이 스크립트도 종료된다(→ serve.sh가 재기동).
cd "$(dirname "$0")"
URLFILE="$(pwd)/CURRENT-URL.txt"
LOG="/tmp/kis-tunnel.log"
: > "$LOG"
/usr/local/bin/cloudflared tunnel --url http://127.0.0.1:3000 >>"$LOG" 2>&1 &
CFPID=$!
# 최대 60초 동안 로그에서 URL을 찾아 파일에 기록
for i in $(seq 1 60); do
  url=$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1)
  if [ -n "$url" ]; then printf '%s\n' "$url" > "$URLFILE"; break; fi
  sleep 1
done
wait "$CFPID"
