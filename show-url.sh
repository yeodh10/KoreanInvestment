#!/usr/bin/env bash
# 현재 살아있는 공개 주소를 출력한다. (URL이 바뀌어도 이 명령으로 항상 최신 주소 확인)
cd "$(dirname "$0")"
if [ -s CURRENT-URL.txt ]; then
  echo "🌐 현재 공개 주소:  $(cat CURRENT-URL.txt)"
else
  echo "아직 URL이 준비되지 않았습니다. 잠시 후 다시 실행하세요."
  echo "(감시 스크립트가 안 떠 있으면:  ./serve.sh &  로 다시 시작)"
fi
