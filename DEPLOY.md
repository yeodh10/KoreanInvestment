# 공개 배포 가이드 (AutoTrade KR)

서버는 **127.0.0.1에만 바인딩**되고, 외부 접속은 **Tailscale Funnel(HTTPS)** 로만 들어온다.
직접 포트 개방·방화벽 설정이 필요 없고 TLS가 자동 적용된다.

**현재 고정 공개 주소: `https://kis.tail8eca6a.ts.net`** (재시작·재부팅에도 동일)

## ⚠️ 가장 중요한 주의사항
- **첫 가입자가 관리자(admin)가 된다.** 공개 직후 *반드시 본인이 먼저 가입*할 것.
- 공개 전 `users.json`이 없으면(=가입자 0명) 누구든 먼저 가입하면 admin이다.
- KIS App Key/Secret은 가입 후 [설정]에서 입력 — 유저별로 암호화 저장된다.
- 앞단 프록시가 바뀌면 `TRUSTED_PROXY`도 맞출 것 (아래 환경변수). 잘못 맞추면
  IP 기반 가입/로그인 제한이 위조 헤더로 우회된다 (2026-06-06 실측으로 발견·수정).

---

## 1) 평소 운영 — go-live.sh

```bash
cd KoreanInvestment
./go-live.sh
```

- 서버를 띄우고 Funnel 상태를 점검(꺼져 있으면 자동 활성화) 후 고정 주소를 출력한다.
- Ctrl+C 하면 서버만 내려간다. Funnel 설정은 tailscaled에 남아 있어 무해
  (서버가 없으면 502만 뜸).
- 검증됨: 외부 HTTPS 접속·가입·세션 쿠키(Secure)·실제 클라이언트 IP(X-Forwarded-For) 정상.

### Tailscale 1회 초기 설정 (이미 완료 — 새 PC 이전 시에만 필요)
```bash
wget -qO- https://tailscale.com/install.sh | sh
sudo tailscale up                      # 브라우저 로그인 (구글 계정)
sudo tailscale set --hostname=kis      # 주소 앞부분 = 기기명
sudo tailscale funnel --bg 3000        # 처음엔 승인 URL이 떠서 1회 승인 필요
```

## 2) 상시 운영 (재부팅에도 유지)

Funnel은 부팅 시 tailscaled가 자동 복원한다. 서버만 systemd로 등록하면 끝:

`/etc/systemd/system/autotrade.service`:
```ini
[Unit]
Description=AutoTrade KR server
After=network.target tailscaled.service
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
```
**운영 명령**: `systemctl restart autotrade`(코드 수정 반영) · `systemctl status autotrade` · `tail -f /var/log/autotrade.log`
⚠️ 서버를 systemd로 띄운 뒤엔 `./go-live.sh`를 다시 실행하지 말 것(포트 3000 충돌).

### 장중 자동 점검 (선택)
사람·CLI 없이 평일 09:05·10:00 KST에 서버·터널·실시간·응답속도·자동매매 상태를 점검해
`장중점검-YYYYMMDD.md`로 남기고(텔레그램 설정 시 요약 발송) — `market-check.js` + systemd 타이머.
```ini
# /etc/systemd/system/autotrade-check.service
[Service]
Type=oneshot
WorkingDirectory=/home/ydh/KoreanInvestment
Environment=TZ=Asia/Seoul
ExecStart=/usr/bin/node market-check.js
```
```ini
# /etc/systemd/system/autotrade-check.timer
[Timer]
OnCalendar=Mon-Fri *-*-* 09:05:00
OnCalendar=Mon-Fri *-*-* 10:00:00
[Install]
WantedBy=timers.target
```
```bash
sudo systemctl enable --now autotrade-check.timer   # 확인: systemctl list-timers autotrade-check.timer
node market-check.js                                # 수동 즉시 점검
```

## (참고) Cloudflare 터널로 운영할 경우

이전 방식. 무계정 quick tunnel은 주소가 매번 바뀌어 폐기했다. 고정 도메인을 보유하면:
```bash
cloudflared tunnel login && cloudflared tunnel create autotrade
cloudflared tunnel route dns autotrade trade.내도메인.com
TRUSTED_PROXY=cloudflare ./go-live.sh   # ← IP 신뢰 헤더를 CF-Connecting-IP로 전환
```

---

## 환경변수
| 변수 | 기본값 | 설명 |
|------|--------|------|
| `PORT` | `3000` | 수신 포트 |
| `HOST` | `127.0.0.1` | 바인딩 주소. LAN 직접 노출 시 `0.0.0.0` |
| `TZ`   | (시스템) | 로그 시간 표기용. `Asia/Seoul` 권장 |
| `TRUSTED_PROXY` | `tailscale` | 클라이언트 IP 신뢰 헤더. `tailscale`=X-Forwarded-For, `cloudflare`=CF-Connecting-IP |

## 보존해야 할 민감 파일 (.gitignore — 백업 대상)
`users.json` · `sessions.json` · `.enckey`(없으면 user-configs 복호화 불가) ·
`user-configs/` · `order-journal.json` · `data-cache.json`
