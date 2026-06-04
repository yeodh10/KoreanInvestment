/**
 * data-fallback.js — "빈 화면 금지" 폴백 계층
 *
 * 원칙: KIS가 빈 응답을 주면(장전·장마감·VTS 제한) 빈 화면 대신
 *       ① 마지막 정상 데이터(디스크 영속 캐시) → ② 합성 데이터(호가 사다리) 순으로 폴백한다.
 *
 * - lastGood: 마지막 정상 응답을 메모리+디스크(data-cache.json)에 보관 → 서버 재시작에도 유지
 * - fetchUsdKrw: KIS 환율 실패 시 공개 API(open.er-api.com, 키 불필요)로 폴백, 1시간 캐시
 * - buildLadder: 호가 데이터가 전혀 없을 때 마지막 체결가 기준 KRX 호가단위 사다리 생성
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const CACHE_FILE = path.join(__dirname, 'data-cache.json');

// ── 마지막 정상 데이터 저장소 (영속) ──
let _store = null;
let _dirty = false;

function _load() {
  if (_store) return _store;
  try { _store = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch (e) { _store = {}; }
  return _store;
}
function get(key) { const e = _load()[key]; return e ? e.v : null; }
function getEntry(key) { return _load()[key] || null; }
function save(key, value) {
  if (value === null || value === undefined) return;
  _load()[key] = { t: Date.now(), v: value };
  _dirty = true;
}
function flush(sync) { // sync=true는 종료 훅/테스트용
  if (!_dirty) return;
  _dirty = false;
  try {
    if (sync) fs.writeFileSync(CACHE_FILE, JSON.stringify(_store));
    // 평상시엔 비동기 — 파일 잠금(동기화 프로그램 등)에 서버가 멈추지 않게
    else fs.promises.writeFile(CACHE_FILE, JSON.stringify(_store)).catch(() => { _dirty = true; });
  } catch (e) {}
}
// 30초마다 변경분만 디스크 기록 (잦은 쓰기 방지)
setInterval(() => flush(false), 30000).unref();
process.on('exit', () => flush(true));

// ── 환율 (USD/KRW) ──
function _httpsGetJson(hostname, p) {
  return new Promise((resolve, reject) => {
    const req = https.get({ hostname, path: p, headers: { 'User-Agent': 'AutoTradeKR' } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('timeout')));
  });
}

let _fxFetcher = null; // 테스트 주입용
function _setFxFetcher(f) { _fxFetcher = f; }

async function fetchUsdKrw() {
  const e = getEntry('fx:USDKRW');
  if (e && Date.now() - e.t < 3600000) return e.v; // 1시간 캐시
  try {
    const j = _fxFetcher ? await _fxFetcher() : await _httpsGetJson('open.er-api.com', '/v6/latest/USD');
    const rate = parseFloat(j?.rates?.KRW || 0);
    if (rate > 0) {
      const v = Math.round(rate * 10) / 10;
      save('fx:USDKRW', v);
      return v;
    }
  } catch (err) {}
  return e ? e.v : null; // 갱신 실패 시 만료된 마지막 값이라도
}

// ── KRX 호가단위 (2023~ 기준) ──
function tickSize(p) {
  if (p < 2000) return 1;
  if (p < 5000) return 5;
  if (p < 20000) return 10;
  if (p < 50000) return 50;
  if (p < 200000) return 100;
  if (p < 500000) return 500;
  return 1000;
}

// 마지막 체결가 기준 호가 사다리 (잔량 0 = 표시상 '—')
// 장전/데이터 부재 시 빈 호가창 대신 가격 구조라도 보여준다.
function buildLadder(price) {
  price = parseInt(price) || 0;
  if (price <= 0) return null;
  const t = tickSize(price);
  const base = Math.round(price / t) * t;
  const out = { stck_prpr: String(price), stck_sdpr: String(price), synthetic: true };
  for (let i = 1; i <= 10; i++) {
    out['askp' + i] = String(base + t * i);
    out['bidp' + i] = String(Math.max(0, base - t * (i - 1)));
    out['askp_rsqn' + i] = '0';
    out['bidp_rsqn' + i] = '0';
  }
  return out;
}

// ── 호가 응답이 실질적으로 비었는지 판정 ──
function isOrderbookEmpty(output1) {
  if (!output1) return true;
  for (let i = 1; i <= 10; i++) {
    if (parseInt(output1['askp' + i] || 0) > 0 || parseInt(output1['bidp' + i] || 0) > 0) return false;
  }
  return true;
}

module.exports = { get, getEntry, save, flush, fetchUsdKrw, tickSize, buildLadder, isOrderbookEmpty, _setFxFetcher };
