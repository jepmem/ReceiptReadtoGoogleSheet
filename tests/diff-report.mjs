#!/usr/bin/env node
/**
 * Diff Report
 * -----------
 * เทียบ tests/results/<bill>.json (actual) กับ tests/expected/<bill>.json (ground truth)
 * แล้ว print รายงานบอกว่าใบไหน field ไหนพลาด พร้อม root-cause hint
 *
 * Usage:
 *   node tests/diff-report.mjs
 *   node tests/diff-report.mjs --engine=analyze (default)
 *   node tests/diff-report.mjs --json           # output JSON แทน text
 *   node tests/diff-report.mjs --only=bill1
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(__dirname, 'results');
const EXPECTED_DIR = path.join(__dirname, 'expected');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const ENGINE = args.engine ?? 'analyze';
const AS_JSON = !!args.json;
const ONLY = args.only;

const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const numEq = (a, b, tol = 0.01) =>
  Number.isFinite(+a) && Number.isFinite(+b) && Math.abs(+a - +b) <= tol;

/** Levenshtein distance for fuzzy product-name match */
function lev(a, b) {
  a = norm(a); b = norm(b);
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m || !n) return Math.max(m, n);
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j-1], dp[i-1][j], dp[i][j-1]);
  return dp[m][n];
}
const sim = (a, b) => {
  const A = norm(a), B = norm(b);
  if (!A && !B) return 1;
  if (!A || !B) return 0;
  return 1 - lev(A, B) / Math.max(A.length, B.length);
};

/** จับคู่สินค้า expected ↔ actual แบบ greedy โดยใช้ similarity */
function matchProducts(expectedItems = [], actualItems = []) {
  const used = new Set();
  const matches = [];
  for (const exp of expectedItems) {
    let bestIdx = -1, bestScore = 0;
    actualItems.forEach((act, i) => {
      if (used.has(i)) return;
      const s = sim(exp.product, act.product);
      if (s > bestScore) { bestScore = s; bestIdx = i; }
    });
    if (bestIdx >= 0 && bestScore >= 0.5) {
      used.add(bestIdx);
      matches.push({ expected: exp, actual: actualItems[bestIdx], score: +bestScore.toFixed(2) });
    } else {
      matches.push({ expected: exp, actual: null, score: +bestScore.toFixed(2) });
    }
  }
  const extras = actualItems.filter((_, i) => !used.has(i)).map((a) => ({ expected: null, actual: a }));
  return { matches, extras };
}

function rootCauseHints(diff, raw) {
  const hints = [];
  const rawLow = norm(raw);
  if (diff.totalIssue) {
    if (rawLow && /(total|amount|balance|grand|sum|due)/.test(rawLow)) {
      hints.push('• total อยู่ใน raw text แต่หาไม่เจอ → ตรวจ regex ใน findTotal()');
    } else {
      hints.push('• raw text ไม่มี keyword total → PaddleOCR อ่านบรรทัดนั้นไม่ออก / lang="en" ไม่รองรับ');
    }
  }
  if (diff.missingProducts.length) {
    hints.push(`• สินค้าหาย ${diff.missingProducts.length} รายการ → เช็ค skipWords regex / row grouping (Y tolerance) / extractProductsFromRows()`);
  }
  if (diff.extraProducts.length) {
    hints.push(`• สินค้าเกิน ${diff.extraProducts.length} รายการ → header/footer ถูก parse เป็นสินค้า → ขยาย skipWords หรือเช็ค price column`);
  }
  if (diff.wrongQty.length) {
    hints.push('• Qty ผิด → parser แยก qty/price ผิด column หรือ rows merge/split พลาด');
  }
  if (diff.wrongPrice.length) {
    hints.push('• Price ผิด → ตรวจ regex จับตัวเลข (decimal, comma) + row column assignment');
  }
  return hints;
}

async function loadJson(p) {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); }
  catch { return null; }
}

async function run() {
  const resultFiles = (await fs.readdir(RESULTS_DIR).catch(() => []))
    .filter((f) => f.endsWith('.json'))
    .filter((f) => !ONLY || f.startsWith(ONLY));

  if (resultFiles.length === 0) {
    console.error(`❌ ไม่พบไฟล์ใน ${RESULTS_DIR} — รัน run-tester.mjs ก่อน`);
    process.exit(1);
  }

  const reports = [];
  for (const rf of resultFiles) {
    const stem = path.basename(rf, '.json');
    const actual = await loadJson(path.join(RESULTS_DIR, rf));
    const expected = await loadJson(path.join(EXPECTED_DIR, rf));
    const engineResult = actual?.results?.[ENGINE]?.body ?? {};
    // ส่วนที่เป็น parsed expense — รองรับทั้ง shape ของ /ocr และ /analyze
    const parsed = engineResult.receipt ?? engineResult.expense ?? engineResult.data ?? engineResult;
    const raw = engineResult.rawText ?? engineResult.text ?? engineResult.ocrText ?? '';

    if (!expected) {
      reports.push({ file: stem, status: 'NO_EXPECTED', parsed, raw });
      continue;
    }

    // Normalize product shape: server returns {name, total, qty} but expected uses {product, price, qty}
    const items = (parsed.products ?? parsed.items ?? []).map((p) => ({
      product: p.product ?? p.name,
      qty: Number(p.qty ?? p.quantity ?? 1),
      price: Number(p.price ?? p.amount ?? p.total ?? 0),
    }));
    const { matches, extras } = matchProducts(expected.products ?? [], items);

    const wrongQty = [];
    const wrongPrice = [];
    const missing = [];
    for (const m of matches) {
      if (!m.actual) { missing.push(m.expected); continue; }
      if (!numEq(m.expected.qty ?? 1, m.actual.qty ?? 1))
        wrongQty.push({ product: m.expected.product, expected: m.expected.qty, actual: m.actual.qty });
      if (!numEq(m.expected.price, m.actual.price, 0.5))
        wrongPrice.push({ product: m.expected.product, expected: m.expected.price, actual: m.actual.price });
    }

    const totalIssue = expected.total != null && !numEq(expected.total, parsed.total, 0.5);

    const diff = {
      totalIssue,
      expectedTotal: expected.total,
      actualTotal: parsed.total,
      missingProducts: missing,
      extraProducts: extras.map((e) => e.actual),
      wrongQty,
      wrongPrice,
    };
    const pass =
      !totalIssue && !missing.length && !extras.length && !wrongQty.length && !wrongPrice.length;

    reports.push({
      file: stem,
      status: pass ? 'PASS' : 'FAIL',
      diff,
      hints: pass ? [] : rootCauseHints(diff, raw),
      raw: raw.slice(0, 500),
    });
  }

  if (AS_JSON) {
    console.log(JSON.stringify(reports, null, 2));
    return;
  }

  let pass = 0, fail = 0, skip = 0;
  for (const r of reports) {
    if (r.status === 'PASS') { pass++; console.log(`✅ ${r.file}`); continue; }
    if (r.status === 'NO_EXPECTED') { skip++; console.log(`⚠️  ${r.file}  — ไม่มี expected/${r.file}.json (ข้าม)`); continue; }
    fail++;
    console.log(`\n❌ ${r.file}`);
    if (r.diff.totalIssue)
      console.log(`   total: expected ${r.diff.expectedTotal}, got ${r.diff.actualTotal}`);
    if (r.diff.missingProducts.length)
      console.log(`   missing: ${r.diff.missingProducts.map((p) => p.product).join(', ')}`);
    if (r.diff.extraProducts.length)
      console.log(`   extra:   ${r.diff.extraProducts.map((p) => p.product).join(', ')}`);
    for (const w of r.diff.wrongQty)
      console.log(`   qty[${w.product}]: expected ${w.expected}, got ${w.actual}`);
    for (const w of r.diff.wrongPrice)
      console.log(`   price[${w.product}]: expected ${w.expected}, got ${w.actual}`);
    for (const h of r.hints) console.log(`   ${h}`);
  }
  console.log(`\n──────── ${pass} pass · ${fail} fail · ${skip} no-expected ────────`);
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(2); });
