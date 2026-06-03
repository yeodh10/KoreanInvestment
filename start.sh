#!/bin/bash
echo ""
echo " AutoTrade KR 서버 시작 중..."
echo ""

if ! command -v node &> /dev/null; then
    echo " [오류] Node.js가 설치되어 있지 않습니다."
    echo " https://nodejs.org 에서 설치 후 다시 실행하세요."
    exit 1
fi

echo " Node.js 확인됨: $(node --version)"
echo " 서버 시작: http://localhost:3000"
echo " 종료하려면 Ctrl+C 를 누르세요."
echo ""

node "$(dirname "$0")/proxy-server.js"
