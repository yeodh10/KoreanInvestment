/**
 * kis-realtime.js 검증 — 가짜 KIS WebSocket 서버로 전 구간 테스트
 * 실행: node tests/realtime-test.js   (저장소 루트에서, KIS 접속/키 불필요)
 */
const net = require('net');
const crypto = require('crypto');
const path = require('path');
const rt = require(path.join(__dirname, '..', 'kis-realtime.js'));

let pass = 0, fail = 0;
function ok(name, cond) { cond ? (pass++, console.log('  ✅', name)) : (fail++, console.log('  ❌', name)); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ════════ 1. 파서 단위 테스트 ════════
console.log('== 파서 ==');
function mkPriceFrame(code, price, { sign='2', vrss='100', ctrt='0.14', cntg='10', acc='12345' } = {}) {
  const f = Array(46).fill('0');
  f[0]=code; f[1]='090015'; f[2]=String(price); f[3]=sign; f[4]=vrss; f[5]=ctrt; f[12]=cntg; f[13]=acc;
  return '0|H0STCNT0|001|' + f.join('^');
}
function mkObFrame(code) {
  const f = Array(50).fill('0');
  f[0]=code; f[1]='090015'; f[2]='0';
  for (let i=0;i<10;i++){ f[3+i]=String(71000+i*100); f[13+i]=String(70900-i*100); f[23+i]=String(100+i); f[33+i]=String(200+i); }
  f[43]='5000'; f[44]='8000';
  return '0|H0STASP0|001|' + f.join('^');
}
let m = rt.parseKisMessage(mkPriceFrame('005930', 71900));
ok('체결가 파싱 type', m.type === 'price');
ok('체결가 코드/가격', m.ticks[0].code === '005930' && m.ticks[0].price === 71900);
ok('등락율/부호', m.ticks[0].chgPct === 0.14 && m.ticks[0].sign === '2');

m = rt.parseKisMessage(mkObFrame('005930'));
ok('호가 파싱 type', m.type === 'orderbook');
ok('호가 1단 매도/매수', m.ob.asks[0][0] === 71000 && m.ob.bids[0][0] === 70900);
ok('호가 총잔량', m.ob.totAsk === 5000 && m.ob.totBid === 8000);

m = rt.parseKisMessage(JSON.stringify({ header: { tr_id: 'PINGPONG', datetime: '20260604' } }));
ok('PINGPONG 인식', m.type === 'pingpong');
m = rt.parseKisMessage(JSON.stringify({ header: { tr_id: 'H0STCNT0' }, body: { rt_cd: '0', msg1: 'SUBSCRIBE SUCCESS' } }));
ok('구독응답 인식', m.type === 'control' && m.rtCd === '0');

// 2건 멀티레코드
const f2 = mkPriceFrame('005930', 71900).split('|');
const rec2 = Array(46).fill('0'); rec2[0]='000660'; rec2[1]='090016'; rec2[2]='199000'; rec2[3]='5'; rec2[4]='500'; rec2[5]='-0.25';
const multi = `0|H0STCNT0|002|${f2[3]}^${rec2.join('^')}`;
m = rt.parseKisMessage(multi);
ok('멀티레코드 2건', m.type === 'price' && m.ticks.length === 2 && m.ticks[1].code === '000660' && m.ticks[1].price === 199000);

// ════════ 2. 가짜 KIS WS 서버 ════════
// 서버측 RFC6455: 핸드셰이크 응답 + 클라 프레임(마스크) 디코드 + 서버 프레임(비마스크) 인코드
function startFakeKis(onClientMsg) {
  const state = { socks: new Set(), received: [], connections: 0 };
  const server = net.createServer(sock => {
    state.connections++;
    state.socks.add(sock);
    let buf = Buffer.alloc(0), shook = false;
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
      if (!shook) {
        const i = buf.indexOf('\r\n\r\n');
        if (i === -1) return;
        const head = buf.slice(0, i).toString();
        buf = buf.slice(i + 4);
        const km = /Sec-WebSocket-Key:\s*(\S+)/i.exec(head);
        const accept = crypto.createHash('sha1').update(km[1] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        shook = true;
      }
      // 클라 프레임 디코드 (마스크 필수)
      while (buf.length >= 2) {
        const op = buf[0] & 0x0f;
        let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        if (buf.length < off + 4 + len) return;
        const mask = buf.slice(off, off + 4);
        const payload = Buffer.from(buf.slice(off + 4, off + 4 + len).map((v, j) => v ^ mask[j % 4]));
        buf = buf.slice(off + 4 + len);
        if (op === 0x1) { const s = payload.toString(); state.received.push(s); if (onClientMsg) onClientMsg(s, sock); }
      }
    });
    sock.on('close', () => state.socks.delete(sock));
    sock.on('error', () => {});
  });
  state.sendText = (s) => {
    for (const sock of state.socks) {
      const p = Buffer.from(s, 'utf8');
      let h;
      if (p.length < 126) h = Buffer.from([0x81, p.length]);
      else { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 126; h.writeUInt16BE(p.length, 2); }
      sock.write(Buffer.concat([h, p]));
    }
  };
  state.killAll = () => { for (const s of state.socks) s.destroy(); };
  state.server = server;
  return new Promise(res => server.listen(0, '127.0.0.1', () => res(state)));
}

(async () => {
  console.log('== 통합 (가짜 서버) ==');
  const fake = await startFakeKis();
  const port = fake.server.address().port;
  rt._setEndpointOverride({ host: '127.0.0.1', port, skipApproval: true });

  const cfg = { appKey: 'TESTKEY', appSecret: 'S', txMode: 'vts' };
  const feed = rt.getFeed(cfg);
  const sse = []; // 가짜 SSE 클라이언트가 받은 라인들
  let cacheHits = [];
  const client = { id: 1, res: { write: s => sse.push(s) }, codes: new Set(['005930']), obCode: '005930' };
  feed.priceHooks.set(client.id, (code, data) => cacheHits.push({ code, data }));
  feed.addClient(client);

  await sleep(400);
  ok('WS 연결됨', feed.connected === true);
  const subs = fake.received.map(s => JSON.parse(s));
  ok('체결가 구독 요청 발신', subs.some(s => s.body?.input?.tr_id === 'H0STCNT0' && s.body.input.tr_key === '005930' && s.header.tr_type === '1'));
  ok('호가 구독 요청 발신', subs.some(s => s.body?.input?.tr_id === 'H0STASP0' && s.body.input.tr_key === '005930'));

  // PINGPONG 에코
  fake.received.length = 0;
  const ping = JSON.stringify({ header: { tr_id: 'PINGPONG', datetime: '20260604093000' } });
  fake.sendText(ping);
  await sleep(200);
  ok('PINGPONG 동일 에코', fake.received.includes(ping));

  // 체결가 수신 → SSE + 가격캐시 훅
  sse.length = 0; cacheHits = [];
  fake.sendText(mkPriceFrame('005930', 72100));
  await sleep(200);
  ok('SSE price 이벤트 전달', sse.some(s => s.includes('event: price') && s.includes('"price":72100')));
  ok('가격캐시 훅 호출', cacheHits.length === 1 && cacheHits[0].code === '005930' && cacheHits[0].data.price === 72100);

  // 호가 수신
  sse.length = 0;
  fake.sendText(mkObFrame('005930'));
  await sleep(200);
  ok('SSE orderbook 이벤트 전달', sse.some(s => s.includes('event: orderbook') && s.includes('"totBid":8000')));

  // 체결통보 (암호화 TR): 구독응답 key/iv 수신 → AES 복호화 → onExecution 콜백
  const aesKey = '01234567890123456789012345678901', aesIv = '0123456789012345';
  let execGot = null;
  feed.execHooks.set(client.id, ex => { execGot = ex; });
  fake.sendText(JSON.stringify({ header: { tr_id: 'H0STCNI9' }, body: { rt_cd: '0', msg1: 'SUBSCRIBE SUCCESS', output: { key: aesKey, iv: aesIv } } }));
  await sleep(150);
  const ef = Array(20).fill('0');
  ef[2] = '0000099999'; ef[8] = '035720'; ef[9] = '1'; ef[10] = '42000'; ef[13] = '2';
  const ciph = crypto.createCipheriv('aes-256-cbc', Buffer.from(aesKey), Buffer.from(aesIv));
  const encB64 = Buffer.concat([ciph.update(Buffer.from(ef.join('^'), 'utf8')), ciph.final()]).toString('base64');
  fake.sendText('1|H0STCNI9|001|' + encB64);
  await sleep(200);
  ok('체결통보 복호화·파싱', !!execGot && execGot.odno === '0000099999' && execGot.code === '035720' && execGot.price === 42000 && execGot.filled === true);

  // 재연결 + 재구독
  fake.received.length = 0;
  fake.killAll();
  await sleep(1600); // 백오프 1초 + 여유
  ok('재연결 성공', feed.connected === true && fake.connections >= 2);
  const resubs = fake.received.map(s => JSON.parse(s));
  ok('재연결 시 재구독', resubs.some(s => s.body?.input?.tr_key === '005930'));

  // LRU 한도 (MAX_REG=40 초과 시 해제 발신) — 시총30 시세표 + 호가 수용 위해 20→40 상향
  fake.received.length = 0;
  for (let i = 0; i < 43; i++) feed.ensure('H0STCNT0', String(100000 + i));
  await sleep(200);
  const msgs = fake.received.map(s => JSON.parse(s));
  ok('한도 초과 시 LRU 해제 발신', msgs.some(s => s.header.tr_type === '2'));

  // 멀티탭 체결통보 중복 방지 — 피드당 '_journal' 훅 1개만, 클라이언트(탭) 수와 무관하게 1회만 확정
  feed.execHooks.clear();
  let execCalls = 0;
  feed.execHooks.set('_journal', () => execCalls++);
  const tab2 = { id: 777, res: { write() {} }, codes: new Set(['005930']), obCode: null };
  feed.addClient(tab2); // 두 번째 탭 연결
  const ef2 = Array(20).fill('0'); ef2[2]='0000088888'; ef2[8]='005930'; ef2[9]='3'; ef2[10]='71000'; ef2[13]='2';
  const ciph2 = crypto.createCipheriv('aes-256-cbc', Buffer.from(aesKey), Buffer.from(aesIv));
  const enc2 = Buffer.concat([ciph2.update(Buffer.from(ef2.join('^'), 'utf8')), ciph2.final()]).toString('base64');
  fake.sendText('1|H0STCNI9|001|' + enc2);
  await sleep(200);
  ok('멀티탭(탭2개)에서도 체결통보 1회만 확정', execCalls === 1);

  feed._closed = true; try { feed.ws.close(); } catch (_) {}
  fake.server.close();

  // ════════ 재연결 견고성 — 핸드셰이크 전 실패가 connecting을 영구 고착시키지 않음 ════════
  console.log('== 재연결 견고성 ==');
  const tmpSrv = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => r(s)); });
  const deadPort = tmpSrv.address().port;
  await new Promise(r => tmpSrv.close(r)); // 즉시 닫아 ECONNREFUSED 유발
  rt._setEndpointOverride({ host: '127.0.0.1', port: deadPort, skipApproval: true });
  const dead = rt.getFeed({ appKey: 'DEADKEY', appSecret: 'S', txMode: 'vts' });
  const dc = { id: 901, res: { write() {} }, codes: new Set(['005930']), obCode: null };
  dead.addClient(dc); // 연결 시도 → 핸드셰이크 전 실패
  await sleep(400);
  ok('핸드셰이크 전 실패 후 connecting 해제 (영구 고착 방지)', dead.connecting === false);
  ok('연결 실패 상태로 남음 (connected=false)', dead.connected === false);
  dead._closed = true; dead.removeClient(dc); try { dead.ws && dead.ws.close(); } catch (_) {}

  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('테스트 오류:', e); process.exit(2); });
