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

const MAX_REG = 20;            // 세션당 실시간 등록 한도 (체결+호가 합산, 보수적)
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
        if (this.onopen) this.onopen();
      }
      this._drain();
    });
    this.sock.on('error', e => this._fail(e));
    this.sock.on('close', () => {
      const was = this.open;
      this.open = false;
      if (was && this.onclose) this.onclose();
    });
  }

  _fail(e) {
    if (this.onerror) this.onerror(e);
    try { this.sock.destroy(); } catch (_) {}
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
  if (flag === '1') return { type: 'encrypted', trId, payloadB64: text.slice(p3 + 1) }; // 암호화 TR(체결통보)
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
    this.onPrice = null;        // (code, data) → 서버 가격캐시 갱신 훅
    this.onExecution = null;    // 체결통보 훅 ({odno, code, qty, price, filled})
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
        this.connected = true; this.connecting = false; this._retry = 0;
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
      ws.onmessage = t => this._handle(t);
      ws.onerror = e => { this.log('⚠️ WS 오류: ' + e.message); };
      ws.onclose = () => {
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
      if (!k || !this.onExecution) return;
      try {
        const dec = crypto.createDecipheriv('aes-256-cbc', Buffer.from(k.key, 'utf8'), Buffer.from(k.iv, 'utf8'));
        const txt = Buffer.concat([dec.update(Buffer.from(m.payloadB64, 'base64')), dec.final()]).toString('utf8');
        const f = txt.split('^');
        // 체결통보 필드: [2]주문번호 [8]종목코드 [9]체결수량 [10]체결단가 [13]체결여부('2'=체결)
        this.onExecution({ odno: f[2], code: f[8], qty: parseInt(f[9] || 0), price: parseInt(f[10] || 0), filled: f[13] === '2' });
      } catch (e) { this.log('⚠️ 체결통보 복호화 실패: ' + e.message); }
      return;
    }
    if (m.type === 'price') {
      for (const t of m.ticks) {
        const reg = this.regs.get(`${TR_PRICE}:${t.code}`);
        if (reg) reg.lastUsed = Date.now();
        const data = { price: t.price, chgPct: t.chgPct, sign: t.sign, prev: t.price - t.vrss * (t.sign === '5' || t.sign === '4' ? -1 : 1) };
        if (this.onPrice) try { this.onPrice(t.code, data) } catch (_) {}
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
    for (const c of this.clients) {
      if (event === 'status' || !code || c.codes.has(code) || c.obCode === code) {
        try { c.res.write(line); } catch (_) {}
      }
    }
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

  removeClient(client) { this.clients.delete(client); }
}

// ── 앱키별 피드 ──
const _feeds = {};
function getFeed(cfg) {
  const key = cfg.appKey || '_global';
  if (!_feeds[key]) _feeds[key] = new KisFeed(cfg);
  _feeds[key].cfg = cfg; // 최신 설정 반영
  return _feeds[key];
}

// ════════════════════════════════════════
// SSE 핸들러 — GET /api/stream?codes=005930,000660&ob=005930
// ════════════════════════════════════════
function handleStream(req, res, { cfg, query, onPrice, onExecution }) {
  const codes = (query.codes || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 15);
  const obCode = (query.ob || '').trim() || null;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(': stream open\n\n');

  const feed = getFeed(cfg);
  if (onPrice) feed.onPrice = onPrice;
  if (onExecution) feed.onExecution = onExecution;
  const client = { res, codes: new Set(codes), obCode };
  feed.addClient(client);
  res.write(`event: status\ndata: ${JSON.stringify({ connected: feed.connected })}\n\n`);

  // keep-alive (프록시/브라우저 타임아웃 방지)
  const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch (_) {} }, 15000);
  req.on('close', () => { clearInterval(hb); feed.removeClient(client); });
}

module.exports = { handleStream, getFeed, parseKisMessage, getApprovalKey, MiniWS, _setEndpointOverride };
