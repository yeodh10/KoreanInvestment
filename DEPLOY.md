# 공개 배포 가이드 (AutoTrade KR)

서버는 **127.0.0.1에만 바인딩**되고, 외부 접속은 **Cloudflare 터널(HTTPS)** 로만 들어온다.
직접 포트 개방·방화벽 설정이 필요 없고 TLS가 자동 적용된다.

## ⚠️ 가장 중요한 주의사항
- **첫 가입자가 관리자(admin)가 된다.** 공개 직후 *반드시 본인이 먼저 가입*할 것.
- 공개 전 `users.json`이 없으면(=가입자 0명) 누구든 먼저 가입하면 admin이다.
- KIS App Key/Secret은 가입 후 [설정]에서 입력 — 유저별로 암호화 저장된다.

---

## 1) 즉시 공개 (테스트·소규모) — quick tunnel

```bash
cd KoreanInvestment
./go-live.sh
```

- 실행하면 `https://<랜덤>.trycloudflare.com` 주소가 출력된다. 그 주소를 공유하면 끝.
- **이 주소는 실행할 때마다 바뀐다.** 터미널을 닫거나 Ctrl+C 하면 내려간다.
- 검증됨: 외부 HTTPS 접속·가입·세션 쿠키(Secure) 정상 동작.

## 2) 상시 운영 (재부팅·터미널 종료에도 유지)

quick tunnel은 임시용이다. 출시용으로는 **고정 도메인 + systemd**를 권장.

### (a) 고정 도메인 터널 (무료 Cloudflare 계정 + 보유 도메인 필요)
```bash
cloudflared tunnel login                      # 브라우저 인증
cloudflared tunnel create autotrade           # 터널 생성
cloudflared tunnel route dns autotrade trade.내도메인.com
# ~/.cloudflared/config.yml 에 ingress 설정 후:
cloudflared tunnel run autotrade
```

### (b) systemd 서비스로 등록 (서버 + 터널 자동 재시작)
`/etc/systemd/system/autotrade.service`:
```ini
[Unit]
Description=AutoTrade KR server
After=network.target
[Service]
WorkingDirectory=/home/ydh/KoreanInvestment
Environment=TZ=Asia/Seoul HOST=127.0.0.1 PORT=3000
ExecStart=/usr/bin/node proxy-server.js
Restart=always
[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl enable --now autotrade
sudo systemctl enable --now cloudflared    # (b-a)로 설치한 경우
```

---

## 환경변수
| 변수 | 기본값 | 설명 |
|------|--------|------|
| `PORT` | `3000` | 수신 포트 |
| `HOST` | `127.0.0.1` | 바인딩 주소. LAN 직접 노출 시 `0.0.0.0` |
| `TZ`   | (시스템) | 로그 시간 표기용. `Asia/Seoul` 권장 |

## 보존해야 할 민감 파일 (.gitignore — 백업 대상)
`users.json` · `sessions.json` · `.enckey`(없으면 user-configs 복호화 불가) ·
`user-configs/` · `order-journal.json` · `data-cache.json`
</content>
