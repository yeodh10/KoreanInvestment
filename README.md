# AutoTrade KR — 실행 가이드

## 📁 파일 구성

```
korean-stock-trader/
├── proxy-server.js   ← Node.js 프록시 서버 (KIS API 중계)
├── app.html          ← 웹 대시보드 (브라우저에서 열기)
├── kis-config.json   ← KIS API 설정 (자동 생성)
└── README.md         ← 이 파일
```

---

## 🚀 실행 순서

### 1단계 — 프록시 서버 실행

터미널(cmd / PowerShell / Terminal)에서:

```bash
cd korean-stock-trader
node proxy-server.js
```

성공하면 아래가 출력됩니다:
```
╔════════════════════════════════════════╗
║     AutoTrade KR — 프록시 서버 실행    ║
╠════════════════════════════════════════╣
║  웹 대시보드: http://localhost:3000     ║
...
```

### 2단계 — 브라우저에서 열기

Chrome 또는 Safari에서:
```
http://localhost:3000
```

로그인 화면이 나옵니다.
- **테스트 계정**: `admin` / `1234`

---

## 🔑 KIS API 키 발급 (무료)

1. **한국투자증권 계좌** 개설 (온라인 가능)
2. https://apiportal.koreainvestment.com 접속
3. **앱 등록** → App Key / App Secret 발급
4. 대시보드 **설정 → API 설정** 탭에서 입력 후 저장

> ⚠️ **모의투자 먼저 테스트** 권장  
> 실전투자로 전환 전 반드시 모의투자로 충분히 검증하세요.

---

## 📡 API 엔드포인트

| 경로 | 설명 |
|------|------|
| `GET /api/price?code=005930` | 현재가 조회 |
| `GET /api/chart?code=005930&period=D` | 일봉/주봉/월봉 (D/W/M) |
| `GET /api/volume100` | 거래량 상위 100 |
| `GET /api/orderbook?code=005930` | 호가창 |
| `GET /api/account` | 계좌 잔고 |
| `POST /api/order` | 주문 실행 |
| `POST /api/config` | KIS 설정 저장 |
| `GET /api/config/status` | 연결 상태 확인 |
| `POST /api/token` | 토큰 발급 |

---

## ⚙️ 설정 파일 (kis-config.json)

서버 실행 후 자동 생성됩니다. 직접 편집도 가능합니다:

```json
{
  "appKey": "여기에 App Key",
  "appSecret": "여기에 App Secret",
  "accNo": "12345678-01",
  "txMode": "vts"
}
```

- `txMode`: `"vts"` = 모의투자, `"live"` = 실전투자

---

## ❓ 문제 해결

| 증상 | 해결 |
|------|------|
| `포트 3000 이미 사용 중` | `proxy-server.js` 내 `PORT = 3001` 로 변경 |
| 차트가 안 보임 | 프록시 서버가 실행 중인지 확인 → `node proxy-server.js` |
| API 오류 | App Key/Secret 재확인, 모의투자 모드 먼저 시도 |
| 토큰 만료 | 설정 탭 → "저장 및 토큰 발급" 클릭 |

---

## ⚠️ 주의사항

- **App Key와 App Secret은 절대 공개하지 마세요.**
- `kis-config.json` 파일을 깃허브 등에 업로드하지 마세요.
- 자동매매는 **반드시 모의투자로 충분히 테스트** 후 실전 적용하세요.
- 투자 손실에 대한 책임은 본인에게 있습니다.
