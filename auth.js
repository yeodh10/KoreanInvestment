/**
 * 멀티유저 인증 모듈
 * - 회원가입/로그인 (비밀번호 해시)
 * - 세션 토큰 관리
 * - 유저별 KIS 설정 분리 + 간단 암호화
 * Node.js 빌트인 crypto만 사용
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const USERS_FILE = path.join(__dirname, 'users.json');
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');
const USER_CONFIG_DIR = path.join(__dirname, 'user-configs');

// 유저 설정 폴더 생성
if (!fs.existsSync(USER_CONFIG_DIR)) {
  try { fs.mkdirSync(USER_CONFIG_DIR); } catch(e) {}
}

// ── 서버 고유 암호화 키 (최초 1회 생성, 파일 저장) ──
const KEY_FILE = path.join(__dirname, '.enckey');
let ENC_KEY;
function getEncKey() {
  if (ENC_KEY) return ENC_KEY;
  try {
    if (fs.existsSync(KEY_FILE)) {
      ENC_KEY = Buffer.from(fs.readFileSync(KEY_FILE, 'utf8'), 'hex');
      return ENC_KEY;
    }
  } catch(e) {}
  ENC_KEY = crypto.randomBytes(32);
  try { fs.writeFileSync(KEY_FILE, ENC_KEY.toString('hex')); } catch(e) {}
  return ENC_KEY;
}

// ── 문자열 암호화/복호화 (AES-256-GCM) ──
function encrypt(text) {
  if (!text) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncKey(), iv);
  const enc = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + tag.toString('hex') + ':' + enc.toString('hex');
}
function decrypt(blob) {
  if (!blob || !blob.includes(':')) return '';
  try {
    const [ivHex, tagHex, dataHex] = blob.split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', getEncKey(), Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
  } catch(e) { return ''; }
}

// ── 비밀번호 해시 (scrypt) ──
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return salt + ':' + hash;
}
function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(test));
}

// ── 유저 저장소 ──
function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch(e) {}
  return {};
}
function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// ── 세션 저장소 ──
function loadSessions() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
  } catch(e) {}
  return {};
}
function saveSessions(s) {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(s));
}

// ── 회원가입 ──
function register(username, password) {
  username = (username || '').trim().toLowerCase();
  if (!username || !password) return { ok:false, message:'아이디와 비밀번호를 입력하세요' };
  if (username.length < 3) return { ok:false, message:'아이디는 3자 이상이어야 합니다' };
  if (password.length < 4) return { ok:false, message:'비밀번호는 4자 이상이어야 합니다' };
  const users = loadUsers();
  if (users[username]) return { ok:false, message:'이미 존재하는 아이디입니다' };
  const userId = 'u_' + crypto.randomBytes(6).toString('hex');
  users[username] = {
    userId, username,
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString(),
    role: Object.keys(users).length === 0 ? 'admin' : 'user' // 첫 가입자가 관리자
  };
  saveUsers(users);
  return { ok:true, userId, username, role: users[username].role };
}

// ── 로그인 ──
function login(username, password) {
  username = (username || '').trim().toLowerCase();
  const users = loadUsers();
  const user = users[username];
  if (!user) return { ok:false, message:'아이디 또는 비밀번호가 틀렸습니다' };
  if (!verifyPassword(password, user.passwordHash)) return { ok:false, message:'아이디 또는 비밀번호가 틀렸습니다' };
  // 세션 발급
  const token = crypto.randomBytes(24).toString('hex');
  const sessions = loadSessions();
  sessions[token] = { userId: user.userId, username, createdAt: Date.now() };
  saveSessions(sessions);
  return { ok:true, token, userId: user.userId, username, role: user.role };
}

// ── 세션 → userId 조회 ──
function getUserBySession(token) {
  if (!token) return null;
  const sessions = loadSessions();
  const s = sessions[token];
  if (!s) return null;
  // 30일 만료
  if (Date.now() - s.createdAt > 30*24*60*60*1000) {
    delete sessions[token]; saveSessions(sessions); return null;
  }
  return s; // { userId, username }
}

// ── 로그아웃 ──
function logout(token) {
  const sessions = loadSessions();
  if (sessions[token]) { delete sessions[token]; saveSessions(sessions); }
  return { ok:true };
}

// ── 유저별 KIS 설정 (API 키는 암호화 저장) ──
function userConfigPath(userId) {
  return path.join(USER_CONFIG_DIR, `${userId}.json`);
}
function loadUserConfig(userId) {
  try {
    const p = userConfigPath(userId);
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      // 복호화해서 반환
      return {
        appKey: decrypt(raw.appKey),
        appSecret: decrypt(raw.appSecret),
        accNo: raw.accNo || '',
        txMode: raw.txMode || 'vts',
        token: raw.token || '',
        tokenExpiry: raw.tokenExpiry || 0,
        telegramToken: decrypt(raw.telegramToken),
        telegramChatId: raw.telegramChatId || ''
      };
    }
  } catch(e) {}
  return { appKey:'', appSecret:'', accNo:'', txMode:'vts', token:'', tokenExpiry:0, telegramToken:'', telegramChatId:'' };
}
function saveUserConfig(userId, cfg) {
  const p = userConfigPath(userId);
  // API 키는 암호화해서 저장
  const toSave = {
    appKey: encrypt(cfg.appKey),
    appSecret: encrypt(cfg.appSecret),
    accNo: cfg.accNo || '',
    txMode: cfg.txMode || 'vts',
    token: cfg.token || '',
    tokenExpiry: cfg.tokenExpiry || 0,
    telegramToken: encrypt(cfg.telegramToken),
    telegramChatId: cfg.telegramChatId || ''
  };
  fs.writeFileSync(p, JSON.stringify(toSave, null, 2));
}

// ── 쿠키 파싱 ──
function parseCookies(req) {
  const out = {};
  const c = req.headers.cookie;
  if (!c) return out;
  c.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx > 0) out[pair.slice(0,idx).trim()] = decodeURIComponent(pair.slice(idx+1).trim());
  });
  return out;
}

module.exports = {
  register, login, logout, getUserBySession,
  loadUserConfig, saveUserConfig,
  loadUsers, parseCookies, encrypt, decrypt
};
