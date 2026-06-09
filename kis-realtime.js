/**
 * kis-realtime.js — KIS 실시간 시세 (WebSocket → 브라우저 SSE)
 * Phase 2: 폴링 대신 KIS WebSocket 푸시로 현재가/호가를 실시간 전달
 *
 * - Node 빌트인만 사용 (net, https, crypto) — npm 불필요
 * - RFC6455 WebSocket 클라이언트 직접 구현 (KIS는 ws:// 평문 포트 사용)
 * - 실전: ws://ops.koreainvestment.com:21000 / 모의: :31000
 * - 인증: POST /oauth2/Approval (body: grant_type, appkey, secretkey) → approval_key
 * - 구독: {"header":{approval_key,custtype:"P",tr_type:"1","content-type":"utf-8"},
 *          "body":{"input":{"tr_id":"H0STCNT0","tr_key":"005930"}}}   (tr_type "2"=해제)
 * - 데이터: "0|H0STCNT0|001|005930^HHMMSS^현재가^부호^대비^등락율^..." (^구분, 레코드당 46필드)
 * - PINGPONG: 동일 페이로드 그대로 에코 (KIS 공지 기준)
 * - 세션당 등록 한도 보수적으로 20건 → LRU 교체
 */

const net    = require('net');
const https  = require('https');
const crypto = require('crypto');

const WS_HOST = 'ops.koreainvestment.com';
const WS_PORT_REAL = 21000;
const WS_PORT_VTS  = 31000;
const REST_REAL = { hostname: 'openapi.koreainvestment.com',    port: 9443 };
const REST_VTS  = { hostname: 'openapivts.koreainvestment.com', port: 29443 };

const MAX_REG = 40;            // 세션당 실시간 등록 한도 (KIS 41건 한도 내). 시총30 시세표(30) + 호가(2)가
                              //  20을 넘겨 자기 구독을 스스로 LRU 축출하던 문제 → 40으로 상향
const TR_PRICE = 'H0STCNT0';   // 실시간 체결가
const TR_ORDERBOOK = 'H0STASP0'; // 실시간 호가

// 테스트용 엔드포인트 오버라이드 (가짜 서버로 검증할 때 사용)
let _endpointOverride = null; // { host, port, skipApproval }
function _setEndpointOverride(o) { _endpointOverride = o; }

// ════════════════════════════════════════
// approval_key 발급
// ════════════════════════════════════════
function getApprovalKey(cfg) {
  return new Promise((resolve, reject) => {
    const rest = cfg.txMode === 'live' ? REST_REAL : REST_VTS;
    const body = JSON.stringify({
      grant_type: 'client_credentials',
      appkey: cfg.appKey,
      secretkey: cfg.appSecret   // 주의: tokenP와 달리 필드명이 secretkey
    });
    const req = https.request({
      hostname: rest.hostname, port: rest.port,
      path: '/oauth2/Approval', method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.approval_key) return resolve(j.approval_key);
          reject(new Error('approval_key 발급 실패: ' + data.slice(0, 200)));
        } catch (e) { reject(new Error('approval_key 응답 파싱 실패')); }
      });
    });
    req.on('error', reject);
    // 타임아웃 — KIS REST 게이트웨이가 응답 없이 소켓을 잡고 있으면 connecting이 영구 고착됨
    req.setTimeout(10000, () => req.destroy(new Error('approval_key 요청 타임아웃(10초)')));
    req.write(body);
    req.end();
  });
}

// ════════════════════════════════════════
// 최소 WebSocket 클라이언트 (RFC6455, ws:// 전용)
// ════════════════════════════════════════
class MiniWS {
  constructor(host, port) {
    this.host = host; this.port = port;
    this.sock = null;
    this.buf = Buffer.alloc(0);
    this.open = false;
    this._frag = null;          // continuation 프레임 누적
    this.onmessage = null; this.onopen = null; this.onclose = null; this.onerror = null;
  }

  connect() {
    const key = crypto.randomBytes(16).toString('base64');
    const expectAccept = crypto.createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');

    // ★ 연결/핸드셰이크 타임아웃 — SYN 무응답·핸드셰이크 무응답으로 매달려
    //   connecting 플래그가 영구 고착(실시간 전체 정지)되는 것을 막는다.
    this._connectTimer = setTimeout(() => {
      if (!this.open) this._fail(new Error('WS 연결/핸드셰이크 타임아웃(12초)'));
    }, 12000);
    if (this._connectTimer.unref) this._connectTimer.unref();

    this.sock = net.connect(this.port, this.host, () => {
      this.sock.write(
        `GET / HTTP/1.1\r\n` +
        `Host: ${this.host}:${this.port}\r\n` +
        `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    this.sock.setNoDelay(true);

    let handshook = false;
    this.sock.on('data', chunk => {
      this.buf = Buffer.concat([this.buf, chunk]);
      if (!handshook) {
        const idx = this.buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        const head = this.buf.slice(0, idx).toString();
        this.buf = this.buf.slice(idx + 4);
        if (!/^HTTP\/1\.1 101/.test(head)) {
          this._fail(new Error('WS 핸드셰이크 거부: ' + head.split('\r\n')[0]));
          return;
        }
        const m = /sec-websocket-accept:\s*(\S+)/i.exec(head);
        if (m && m[1] !== expectAccept) console.log('[실시간] ⚠️ Accept 키 불일치 (무시하고 진행)');
        handshook = true;
        this.open = true;
        clearTimeout(this._connectTimer);
        if (this.onopen) this.onopen();
      }
      this._drain();
    });
    this.sock.on('error', e => this._fail(e));
    // ★ close는 open 여부와 무관하게 항상 종료 콜백을 1회 보장한다.
    //   핸드셰이크 전 실패(ECONNREFUSED·거부·타임아웃)에서 onclose가 안 불려
    //   재연결이 영원히 트리거되지 않던 버그를 차단.
    this.sock.on('close', () => { this.open = false; this._terminate(); });
  }

  // 종료 콜백 1회 보장 (open 여부 무관)
  _terminate() {
    if (this._done) return;
    this._done = true;
    clearTimeout(this._connectTimer);
    if (this.onclose) this.onclose();
  }

  _fail(e) {
    if (this.onerror) this.onerror(e);
    try { this.sock.destroy(); } catch (_) {}
    this._terminate(); // 소켓이 'close'를 안 낼 수도 있으니 직접 보장(중복은 _done로 무시)
  }

  // 수신 버퍼에서 완성된 프레임을 모두 꺼내 처리
  _drain() {
    while (true) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = !!(b0 & 0x80), opcode = b0 & 0x0f;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2)); off = 10;
      }
      const masked = !!(b1 & 0x80);
      if (masked) off += 4; // 서버→클라는 마스크 없음이 정상이지만 방어적으로 처리
      if (this.buf.length < off + len) return;
      let payload = this.buf.slice(off, off + len);
      if (masked) {
        const mask = this.buf.slice(off - 4, off);
        payload = Buffer.from(payload.map((v, i) => v ^ mask[i % 4]));
      }
      this.buf = this.buf.slice(off + len);

      if (opcode === 0x8) { // close
        try { this.sock.end(); } catch (_) {}
        return;
      }
      if (opcode === 0x9) { this._send(0xA, payload); continue; } // ping → pong
      if (opcode === 0xA) continue; // pong 무시

      if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
        if (opcode !== 0x0) this._frag = { op: opcode, parts: [payload] };
        else if (this._frag) this._frag.parts.push(payload);
        if (fin && this._frag) {
          const full = Buffer.concat(this._frag.parts);
          this._frag = null;
          if (this.onmessage) this.onmessage(full.toString('utf8'));
        }
      }
    }
  }

  _send(opcode, payload) {
    if (!this.sock || this.sock.destroyed) return;
    const mask = crypto.randomBytes(4);
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode; header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode; header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    const maskedPayload = Buffer.from(payload.map((v, i) => v ^ mask[i % 4]));
    this.sock.write(Buffer.concat([header, mask, maskedPayload]));
  }

  sendText(str) { this._send(0x1, Buffer.from(str, 'utf8')); }
  close() { try { this._send(0x8, Buffer.alloc(0)); this.sock.end(); } catch (_) {} }
}

// ════════════════════════════════════════
// KIS 메시지 파서 (단위 테스트 대상)
// ════════════════════════════════════════
const CNT_STRIDE = 46; // H0STCNT0 레코드당 필드 수

function parseKisMessage(text) {
  // JSON 제어 메시지 (구독 응답 / PINGPONG)
  if (text.startsWith('{')) {
    try {
      const j = JSON.parse(text);
      if (j.header?.tr_id === 'PINGPONG') return { type: 'pingpong', raw: text };
      return { type: 'control', rtCd: j.body?.rt_cd, msg: j.body?.msg1, trId: j.header?.tr_id, output: j.body?.output, raw: text };
    } catch (e) { return { type: 'unknown', raw: text }; }
  }
  // 데이터 메시지: flag|trId|count|payload
  const p1 = text.indexOf('|'), p2 = text.indexOf('|', p1 + 1), p3 = text.indexOf('|', p2 + 1);
  if (p1 === -1 || p2 === -1 || p3 === -1) return { type: 'unknown', raw: text };
  const flag = text.slice(0, p1), trId = text.slice(p1 + 1, p2);
  const count = parseInt(text.slice(p2 + 1, p3)) || 1;
  if (flag === '1') return { type: 'encrypted', trId, count, payloadB64: text.slice(p3 + 1) }; // 암호화 TR(체결통보) — count 다중레코드
  const f = text.slice(p3 + 1).split('^');

  if (trId === TR_PRICE) {
    const ticks = [];
    for (let i = 0; i < count; i++) {
      const o = i * CNT_STRIDE;
      if (!f[o]) break;
      ticks.push({
        code: f[o], time: f[o + 1],
        price: parseInt(f[o + 2] || 0),
        sign: f[o + 3] || '3',
        vrss: parseInt(f[o + 4] || 0),
        chgPct: parseFloat(f[o + 5] || 0),
        vol: parseInt(f[o + 12] || 0),     // 체결량
        accVol: parseInt(f[o + 13] || 0)   // 누적거래량
      });
    }
    return { type: 'price', ticks };
  }

  if (trId === TR_ORDERBOOK) {
    // 0=code 1=시간 2=시간구분 3~12=매도호가1~10 13~22=매수호가 23~32=매도잔량 33~42=매수잔량 43/44=총잔량
    const asks = [], bids = [];
    for (let i = 0; i < 10; i++) {
      asks.push([parseInt(f[3 + i] || 0), parseInt(f[23 + i] || 0)]);
      bids.push([parseInt(f[13 + i] || 0), parseInt(f[33 + i] || 0)]);
    }
    return {
      type: 'orderbook',
      ob: { code: f[0], time: f[1], asks, bids,
            totAsk: parseInt(f[43] || 0), totBid: parseInt(f[44] || 0) }
    };
  }

  return { type: 'data', trId, fields: f };
}

// ════════════════════════════════════════
// 피드: 앱키당 1개 WS 연결 + 구독 관리 + SSE 팬아웃
// ════════════════════════════════════════
class KisFeed {
  constructor(cfg) {
    this.cfg = cfg;
    this.ws = null;
    this.connected = false;
    this.connecting = false;
    this.regs = new Map();      // 'TRID:code' → { lastUsed }
    this.clients = new Set();   // SSE 클라이언트 { res, codes:Set, obCode }
    // 콜백을 Set으로 — 매 요청 덮어쓰기로 마지막 호출자 것만 남던 버그(멀티 클라이언트 크로스 배선) 수정.
    // clientId로 묶어 클라이언트 종료 시 정확히 해당 콜백만 해제(죽은 클로저 호출 방지).
    this.priceHooks = new Map();     // clientId → (code, data)
    this.execHooks = new Map();      // clientId → ({odno, code, qty, price, filled})
    this.aes = {};              // 암호화 TR별 AES key/iv (구독 응답에서 수신)
    this._retry = 0;
    this._closed = false;
  }

  log(msg) { console.log(`[실시간] ${msg}`); }

  async connect() {
    if (this.connecting || this.connected || this._closed) return;
    this.connecting = true;
    try {
      const ep = _endpointOverride ||
        { host: WS_HOST, port: this.cfg.txMode === 'live' ? WS_PORT_REAL : WS_PORT_VTS };
      this.approvalKey = (_endpointOverride && _endpointOverride.skipApproval)
        ? 'TEST_KEY' : await getApprovalKey(this.cfg);

      const ws = new MiniWS(ep.host, ep.port);
      this.ws = ws;
      ws.onopen = () => {
        this.connected = true; this.connecting = false;
        this._lastRecv = Date.now();
        // 백오프 리셋은 30초 이상 유지된 연결만 — "연결 직후 끊김" 반복 시 1초 재연결 폭주 방지
        const rt = setTimeout(() => { if (this.connected) this._retry = 0; }, 30000);
        if (rt.unref) rt.unref();
        this._startWatchdog();
        this.log(`🟢 KIS WebSocket 연결됨 (${ep.host}:${ep.port}, ${this.cfg.txMode === 'live' ? '실전' : '모의'})`);
        // 기존 구독 복구
        for (const key of this.regs.keys()) {
          const [trId, code] = key.split(':');
          this._sendSub(trId, code, true);
        }
        // 체결통보 구독 (HTS ID 설정 시) — 체결 즉시 푸시 (모의 H0STCNI9 / 실전 H0STCNI0)
        if (this.cfg.htsId) {
          this._cniId = this.cfg.htsId;
          this._sendSub(this.cfg.txMode === 'live' ? 'H0STCNI0' : 'H0STCNI9', this.cfg.htsId, true);
          this.log(`📨 체결통보 구독 (${this.cfg.htsId})`);
        }
        this._broadcast('status', { connected: true });
      };
      ws.onmessage = t => { this._lastRecv = Date.now(); this._handle(t); };
      ws.onerror = e => { this.log('⚠️ WS 오류: ' + e.message); };
      ws.onclose = () => {
        this._stopWatchdog();
        this.connected = false; this.connecting = false;
        this._broadcast('status', { connected: false });
        if (this._closed) return;
        const delay = Math.min(30000, 1000 * Math.pow(2, this._retry++));
        this.log(`🔄 연결 끊김 — ${Math.round(delay / 1000)}초 후 재연결`);
        setTimeout(() => this.connect(), delay);
      };
      ws.connect();
    } catch (e) {
      this.connecting = false;
      const delay = Math.min(60000, 5000 * (this._retry + 1)); this._retry++;
      this.log(`❌ 연결 실패(${e.message}) — ${Math.round(delay / 1000)}초 후 재시도`);
      setTimeout(() => this.connect(), delay);
    }
  }

  // ── 무수신 watchdog ──
  // TCP half-open(절전·NAT 타임아웃·단선)이면 close 이벤트가 영원히 안 옴 → 시세가 얼어붙은 채 connected=true 유지.
  // KIS는 장중 주기적으로 PINGPONG을 보내므로, 90초 무수신 = 죽은 연결로 판단하고 강제 재연결.
  _startWatchdog() {
    this._stopWatchdog();
    this._wd = setInterval(() => {
      if (!this.connected) return;
      if (Date.now() - (this._lastRecv || 0) > 90000) {
        this.log('🛑 90초 무수신 — 죽은 연결로 판단, 강제 재연결');
        try { this.ws.sock.destroy(); } catch (_) {}
      }
    }, 30000);
    if (this._wd.unref) this._wd.unref();
  }
  _stopWatchdog() { if (this._wd) { clearInterval(this._wd); this._wd = null; } }

  _sendSub(trId, code, subscribe) {
    if (!this.connected) return;
    this.ws.sendText(JSON.stringify({
      header: { approval_key: this.approvalKey, custtype: 'P',
                tr_type: subscribe ? '1' : '2', 'content-type': 'utf-8' },
      body: { input: { tr_id: trId, tr_key: code } }
    }));
  }

  // 구독 보장 (LRU 한도 관리)
  ensure(trId, code) {
    const key = `${trId}:${code}`;
    if (this.regs.has(key)) { this.regs.get(key).lastUsed = Date.now(); return; }
    if (this.regs.size >= MAX_REG) {
      // 가장 오래 안 쓴 등록 해제
      let oldest = null, oldestT = Infinity;
      for (const [k, v] of this.regs) {
        if (v.lastUsed < oldestT) { oldest = k; oldestT = v.lastUsed; }
      }
      if (oldest) {
        const [t, c] = oldest.split(':');
        this.regs.delete(oldest);
        this._sendSub(t, c, false);
        this.log(`↩️ 구독 한도 — LRU 해제: ${c}(${t})`);
      }
    }
    this.regs.set(key, { lastUsed: Date.now() });
    this._sendSub(trId, code, true);
  }

  _handle(text) {
    const m = parseKisMessage(text);
    if (m.type === 'pingpong') { this.ws.sendText(m.raw); return; } // 동일 페이로드 에코
    if (m.type === 'control') {
      // 암호화 TR(체결통보) 구독 응답에 AES key/iv가 담겨 옴 — 보관
      if (m.output && m.output.key && m.output.iv && m.trId) this.aes[m.trId] = { key: m.output.key, iv: m.output.iv };
      if (m.rtCd && m.rtCd !== '0' && !/ALREADY/i.test(m.msg || ''))
        this.log(`⚠️ 구독 응답: ${m.msg || m.raw.slice(0, 120)}`);
      return;
    }
    if (m.type === 'encrypted') {
      // 체결통보 복호화 (AES-256-CBC, base64)
      const k = this.aes[m.trId];
      if (!k || !this.execHooks.size) return;
      try {
        const dec = crypto.createDecipheriv('aes-256-cbc', Buffer.from(k.key, 'utf8'), Buffer.from(k.iv, 'utf8'));
        const txt = Buffer.concat([dec.update(Buffer.from(m.payloadB64, 'base64')), dec.final()]).toString('utf8');
        const f = txt.split('^');
        // ★ KIS는 한 프레임에 다중 체결을 count>1로 묶어 보낸다(데이터 TR과 동일). 한 건만 처리하면
        //   둘째 레코드부터의 체결이 영구 유실되어 보유수량·실현손익이 어긋난다(CRITICAL). count로 분할 처리.
        // 체결통보 필드(레코드 기준): [2]주문번호 [8]종목코드 [9]체결수량 [10]체결단가 [13]체결여부('2'=체결)
        const count = m.count || 1;
        const stride = count > 1 ? Math.floor(f.length / count) : f.length;
        for (let i = 0; i < count; i++) {
          const b = i * stride;
          const odno = f[b + 2];
          if (!odno) continue;
          const ev = { odno, code: f[b + 8], qty: parseInt(f[b + 9] || 0), price: parseInt(f[b + 10] || 0), filled: f[b + 13] === '2' };
          for (const fn of this.execHooks.values()) try { fn(ev); } catch (_) {}
        }
      } catch (e) { this.log('⚠️ 체결통보 복호화 실패: ' + e.message); }
      return;
    }
    if (m.type === 'price') {
      for (const t of m.ticks) {
        const reg = this.regs.get(`${TR_PRICE}:${t.code}`);
        if (reg) reg.lastUsed = Date.now();
        const data = { price: t.price, chgPct: t.chgPct, sign: t.sign,
                       prev: t.price - t.vrss * (t.sign === '5' || t.sign === '4' ? -1 : 1),
                       accVol: t.accVol }; // 누적거래량도 캐시 — volume100 폴백 정렬용
        for (const fn of this.priceHooks.values()) try { fn(t.code, data); } catch (_) {}
        this._broadcast('price', { code: t.code, ...data, accVol: t.accVol, time: t.time });
      }
      return;
    }
    if (m.type === 'orderbook') {
      const reg = this.regs.get(`${TR_ORDERBOOK}:${m.ob.code}`);
      if (reg) reg.lastUsed = Date.now();
      this._broadcast('orderbook', m.ob);
    }
  }

  _broadcast(event, obj) {
    if (!this.clients.size) return;
    const code = obj.code;
    const line = `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`;
    let dead = null;
    for (const c of this.clients) {
      if (event === 'status' || !code || c.codes.has(code) || c.obCode === code) {
        try {
          // write()가 false면 소켓 버퍼 적체(half-open 모바일 단선 등) — 누적되면 좀비로 보고 정리.
          // 안 그러면 장중 틱이 Node 메모리에 무한 버퍼링돼 전체 응답이 느려진다.
          if (c.res.write(line) === false) { c._lag = (c._lag || 0) + 1; if (c._lag > 300) (dead || (dead = [])).push(c); }
          else c._lag = 0;
        } catch (_) { (dead || (dead = [])).push(c); }
      }
    }
    if (dead) for (const c of dead) { try { c.res.destroy(); } catch (_) {} this.removeClient(c); }
  }

  addClient(client) {
    this.clients.add(client);
    for (const code of client.codes) this.ensure(TR_PRICE, code);
    if (client.obCode) {
      this.ensure(TR_PRICE, client.obCode);
      this.ensure(TR_ORDERBOOK, client.obCode);
    }
    // HTS ID가 새로 설정/변경됐고 이미 연결돼 있으면 체결통보 즉시 구독 (재시작 불필요)
    if (this.connected && this.cfg.htsId && this._cniId !== this.cfg.htsId) {
      this._cniId = this.cfg.htsId;
      this._sendSub(this.cfg.txMode === 'live' ? 'H0STCNI0' : 'H0STCNI9', this.cfg.htsId, true);
      this.log(`📨 체결통보 구독 (${this.cfg.htsId})`);
    }
    this.connect(); // 미연결이면 연결 시작
  }

  removeClient(client) {
    this.clients.delete(client);
    if (client.id) { this.priceHooks.delete(client.id); this.execHooks.delete(client.id); }
    // 클라이언트 0명 → 2분 뒤에도 0이면 WS 연결·피드 정리 (유휴 연결·메모리 누수 방지)
    if (this.clients.size === 0) {
      if (this._idleTimer) clearTimeout(this._idleTimer);
      this._idleTimer = setTimeout(() => {
        if (this.clients.size === 0 && !this.cfg.htsId) { // 체결통보 구독(htsId) 중이면 유지
          this._closed = true;
          try { this.ws && this.ws.close(); } catch (_) {}
          this._stopWatchdog && this._stopWatchdog();
          delete _feeds[this._feedKey];
          this.log('💤 클라이언트 없음 — 피드 정리');
        }
      }, 120000);
      if (this._idleTimer.unref) this._idleTimer.unref();
    }
  }
}
let _clientSeq = 0;

// ── 앱키별 피드 ──
const _feeds = {};
function getFeed(cfg) {
  const key = cfg.appKey || '_global';
  if (!_feeds[key]) _feeds[key] = new KisFeed(cfg);
  const f = _feeds[key];
  f.cfg = cfg;          // 최신 설정 반영
  f._feedKey = key;
  f._closed = false;    // 재사용 시 닫힘 플래그 해제
  if (f._idleTimer) { clearTimeout(f._idleTimer); f._idleTimer = null; } // 유휴 정리 예약 취소
  return f;
}

// ════════════════════════════════════════
// SSE 핸들러 — GET /api/stream?codes=005930,000660&ob=005930
// ════════════════════════════════════════
function handleStream(req, res, { cfg, query, onPrice, onExecution }) {
  const codes = (query.codes || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 35); // 시총30 시세표 전체 실시간 구독
  const obCode = (query.ob || '').trim() || null;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(': stream open\n\n');

  const feed = getFeed(cfg);
  const client = { id: ++_clientSeq, res, codes: new Set(codes), obCode };
  // 시세 콜백은 클라이언트별 (종료 시 자기 것만 해제).
  if (onPrice) feed.priceHooks.set(client.id, onPrice);
  // ★ 체결통보→저널 확정은 피드(=앱키=유저)당 단 1개만 등록한다.
  //   클라이언트(탭)마다 등록하면 멀티탭에서 markFilled가 N배 호출돼 부분체결이 조기 '체결' 확정된다.
  //   '_journal' 키로 고정 → 탭이 모두 닫혀도(클라이언트 0) 피드가 살아있는 한 체결통보를 계속 확정(유실 방지).
  if (onExecution && !feed.execHooks.has('_journal')) feed.execHooks.set('_journal', onExecution);
  feed.addClient(client);
  res.write(`event: status\ndata: ${JSON.stringify({ connected: feed.connected })}\n\n`);

  // keep-alive (프록시/브라우저 타임아웃 방지)
  const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch (_) {} }, 15000);
  req.on('close', () => { clearInterval(hb); feed.removeClient(client); });
}

module.exports = { handleStream, getFeed, parseKisMessage, getApprovalKey, MiniWS, _setEndpointOverride };
