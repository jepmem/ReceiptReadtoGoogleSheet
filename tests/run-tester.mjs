#!/usr/bin/env node
/**
 * Bill Receipt Analyzer Tester
 * ----------------
 * อ่านทุกไฟล์ใน Bill/ แล้วยิงเข้า /api/receipts/ocr (หรือ /analyze)
 * เก็บ raw OCR + parsed result ลง tests/results/<billName>.json
 *
 * Usage:
 *   node tests/run-tester.mjs                  # ทุกไฟล์, engine=ocr
 *   node tests/run-tester.mjs --only=bill1.jpg # เฉพาะไฟล์เดียว
 *   node tests/run-tester.mjs --engine=analyze # ใช้ Gemini แทน
 *   node tests/run-tester.mjs --both           # รันทั้ง 2 engine แล้ว compare
 *
 * Env:
 *   APP_URL          (default http://localhost:3000)
 *   ACCESS_CODE      access code จาก ID sheet (จำเป็น)
 *   BILL_DIR         (default ./Bill)
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const APP_URL = process.env.APP_URL ?? 'http://localhost:3000';
const ACCESS_CODE = process.env.ACCESS_CODE;
const BILL_DIR = path.resolve(ROOT, process.env.BILL_DIR ?? 'Bill');
const RESULTS_DIR = path.join(__dirname, 'results');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);

const ENGINE = args.both ? 'both' : (args.engine ?? 'analyze');
const ONLY = args.only;

if (!ACCESS_CODE) {
  console.error('❌ ENV ACCESS_CODE ไม่ได้ตั้ง — login ไม่ได้');
  process.exit(1);
}

const IMG_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.heic']);

async function login() {
  const res = await fetch(`${APP_URL}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pass: ACCESS_CODE }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) throw new Error('no cookie returned from /api/login');
  // เอาส่วน "name=value" ของ cookie แรกพอ
  return setCookie.split(';')[0];
}

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.heic': 'image/heic',
};

async function ocrOne(filePath, cookie, endpoint) {
  const buf = await fs.readFile(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const blob = new Blob([buf], { type: MIME[ext] ?? 'application/octet-stream' });
  const fd = new FormData();
  fd.append('receipt', blob, path.basename(filePath));

  const t0 = Date.now();
  const res = await fetch(`${APP_URL}${endpoint}`, {
    method: 'POST',
    headers: { Cookie: cookie },
    body: fd,
  });
  const ms = Date.now() - t0;
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  return { status: res.status, ok: res.ok, ms, body: json };
}

async function run() {
  await fs.mkdir(RESULTS_DIR, { recursive: true });

  const files = (await fs.readdir(BILL_DIR))
    .filter((f) => IMG_EXT.has(path.extname(f).toLowerCase()))
    .filter((f) => !ONLY || f === ONLY)
    .sort();

  if (files.length === 0) {
    console.error(`❌ ไม่พบรูปใน ${BILL_DIR}`);
    process.exit(1);
  }

  console.log(`🔐 logging in to ${APP_URL} ...`);
  const cookie = await login();
  console.log(`✓ logged in`);
  console.log(`📂 ${files.length} bill(s), engine=${ENGINE}\n`);

  const summary = [];

  for (const f of files) {
    const filePath = path.join(BILL_DIR, f);
    const stem = path.basename(f, path.extname(f));
    const out = { file: f, results: {} };

    const engines = ENGINE === 'both' ? ['ocr', 'analyze'] : [ENGINE];
    for (const eng of engines) {
      const endpoint = eng === 'ocr' ? '/api/receipts/ocr' : '/api/receipts/analyze';
      process.stdout.write(`▶ ${f}  [${eng}] ... `);
      try {
        const r = await ocrOne(filePath, cookie, endpoint);
        out.results[eng] = r;
        console.log(r.ok ? `OK (${r.ms}ms)` : `FAIL ${r.status}`);
      } catch (e) {
        out.results[eng] = { error: e.message };
        console.log(`ERR ${e.message}`);
      }
    }

    const outPath = path.join(RESULTS_DIR, `${stem}.json`);
    await fs.writeFile(outPath, JSON.stringify(out, null, 2));
    summary.push({ file: f, saved: path.relative(ROOT, outPath) });
  }

  console.log(`\n✓ done — ${summary.length} result file(s) in ${path.relative(ROOT, RESULTS_DIR)}/`);
  console.log(`  ต่อไป: รัน  node tests/diff-report.mjs   เพื่อเทียบกับ expected/`);
}

run().catch((e) => { console.error(e); process.exit(1); });
