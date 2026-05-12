# Bill Analyzer Tester

Test harness สำหรับยิงรูปใน `Bill/` เข้า API แล้วเทียบผลกับ `tests/expected/`.

## Usage

Start the app first:

```bash
npm start
```

Set env:

```bash
export ACCESS_CODE='<access code from ID sheet>'
export APP_URL='http://localhost:3000'
export BILL_DIR='Bill'
```

Run:

```bash
node tests/run-tester.mjs
node tests/diff-report.mjs
node tests/visualize.mjs
```

## Engines

- `--engine=analyze` uses `/api/receipts/analyze` and is the default.
- `--engine=ocr` still works as a compatibility alias, but the server now routes it to Gemini too.
- `--both` runs both endpoints and stores both results.

## Expected Data

You can create expected files manually from `tests/expected/_example.json`, or use Gemini draft output:

```bash
node tests/bootstrap-expected.mjs
```

Then review each generated file against the actual receipt image before using it as ground truth.
