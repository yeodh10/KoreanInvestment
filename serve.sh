#!/usr/bin/env bash
# 감시(supervisor) — 서버와 '단 하나의' 터널을 항상 살아있게 유지한다.
#  - 서버가 죽으면 재기동.
#  - 터널이 0개거나 2개 이상이면 모두 정리하고 정확히 1개만 재기동(중복 방지).
#  - 터널이 새로 뜨면 run-tunnel.sh가 CURRENT-URL.txt를 자동 갱신.
#  - 전원이 켜져 있는 동안 동작(부팅 자동시작은 아님).
# 사용:  setsid bash ./serve.sh >/tmp/kis-serve.log 2>&1 < /dev/null &
# 중지:  pkill -f serve.sh; pkill -f run-tunnel.sh; pkill -f 'cloudflared tunnel'; pkill -f proxy-server.js
cd "$(dirname "$0")"
export TZ=Asia/Seoul HOST=127.0.0.1 PORT=3000

# 중복 실행 차단 — 감시 루프가 2개 돌면 서로 죽이고 살리는 전쟁이 난다.
LOCK="/tmp/kis-serve.lock"
if [ -f "$LOCK" ] && kill -0 "$(cat "$LOCK" 2>/dev/null)" 2>/dev/null; then
  echo "[serve] 이미 실행 중(PID $(cat "$LOCK")) — 중복 기동 취소"; exit 0
fi
echo $$ > "$LOCK"
trap 'rm -f "$LOCK"' EXIT

server_up() {
  node -e "require('http').get('http://127.0.0.1:3000/api/auth/me',r=>process.exit(0)).on('error',()=>process.exit(1))" 2>/dev/null
}

while true; do
  if ! server_up; then
    echo "[serve] 서버 기동..."
    nohup /usr/bin/node proxy-server.js >/tmp/kis-server.log 2>&1 &
    sleep 4
  fi
  cnt=$(pgrep -fc "cloudflared tunnel")
  if [ "${cnt:-0}" -ne 1 ]; then
    echo "[serve] 터널 정리 후 재기동 (현재 ${cnt:-0}개)"
    pkill -f "cloudflared tunnel" 2>/dev/null
    pkill -f "run-tunnel.sh" 2>/dev/null
    sleep 2
    nohup bash ./run-tunnel.sh >/tmp/kis-runtunnel.log 2>&1 &
    sleep 9
  fi
  sleep 15
done
