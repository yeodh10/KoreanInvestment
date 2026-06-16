#!/usr/bin/env node
/**
 * AutoTrade KR — 민감 파일 백업 스크립트 (WAL-safe)
 *
 * 백업 대상:
 *   - .enckey            (user-configs 복호화 키 — 없으면 KIS 키/봇포지션 복구 불가)
 *   - auth.db            (계정·세션 SQLite)
 *   - order-journal.db   (주문 저널 SQLite)
 *
 * 사용법:
 *   node scripts/backup.mjs
 *
 * 출력: backups/YYYYMMDD-HHMMSS/ 아래에 위 3개 파일 복사본.
 *
 * SQLite는 WAL 모드로 운영 중이므로 .db 파일만 단순 cp 하면 -wal/-shm 에
 * 머물러 있는 최신 트랜잭션이 빠진 '구버전' 스냅샷이 될 수 있다. 그래서
 * node:sqlite 로 DB를 열어 `VACUUM INTO` 로 WAL 내용까지 합친 일관된
 * 단일 파일 스냅샷을 만든다(서버를 멈추지 않고도 안전). .enckey 는 일반 파일이라 그대로 복사.
 *
 * 보안: 이 스크립트는 어떤 파일의 '내용'도 콘솔에 출력하지 않는다(경로·크기만).
 *
 * 주의: 서버는 같은 DB를 동시에 열고 있어도 무방하다(WAL + busy_timeout).
 *       이 스크립트는 읽기 전용 스냅샷만 만들고 운영 DB를 변경하지 않는다.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// 타임스탬프 폴더 (로컬시간 기준 YYYYMMDD-HHMMSS)
function stamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const destDir = path.join(ROOT, 'backups', stamp());
fs.mkdirSync(destDir, { recursive: true });

let ok = 0, skip = 0, fail = 0;

// 일반 파일 복사 (.enckey 등) — 내용은 출력하지 않음
function copyPlain(name) {
  const src = path.join(ROOT, name);
  if (!fs.existsSync(src)) { console.log(`  - 건너뜀(없음): ${name}`); skip++; return; }
  const dst = path.join(destDir, name);
  fs.copyFileSync(src, dst);
  const sz = fs.statSync(dst).size;
  console.log(`  ✓ ${name}  (${sz} bytes)`);
  ok++;
}

// SQLite WAL-safe 스냅샷 — VACUUM INTO 로 WAL 내용까지 합쳐 일관된 단일 파일 생성
function backupSqlite(name) {
  const src = path.join(ROOT, name);
  if (!fs.existsSync(src)) { console.log(`  - 건너뜀(없음): ${name}`); skip++; return; }
  const dst = path.join(destDir, name);
  let db;
  try {
    // readOnly 로 열어 운영 DB를 절대 변경하지 않는다. VACUUM INTO 는 읽기 연결에서도 동작.
    db = new DatabaseSync(src, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 10000'); // 운영 서버와 락 경합 시 대기
    // SQL 인젝션 여지 없는 고정 파일명이지만, 경로는 작은따옴표 이스케이프 처리.
    const safe = dst.replace(/'/g, "''");
    db.exec(`VACUUM INTO '${safe}'`);
    const sz = fs.statSync(dst).size;
    console.log(`  ✓ ${name}  (WAL-safe 스냅샷, ${sz} bytes)`);
    ok++;
  } catch (e) {
    console.error(`  ✗ ${name} 백업 실패: ${e.message}`);
    fail++;
  } finally {
    try { db && db.close(); } catch (_) {}
  }
}

console.log(`[백업] → ${destDir}`);
copyPlain('.enckey');
backupSqlite('auth.db');
backupSqlite('order-journal.db');

console.log(`[백업] 완료: 성공 ${ok} · 건너뜀 ${skip} · 실패 ${fail}`);
if (fail > 0) process.exitCode = 1;
