# Tuning Loop Playbook

Use this with `run-tester.mjs`, `diff-report.mjs`, and `visualize.mjs`.

## Loop

1. Run one bill: `node tests/run-tester.mjs --only=<bill>.jpg`
2. Compare: `node tests/diff-report.mjs --only=<billStem>`
3. Inspect `tests/report.html` from `node tests/visualize.mjs` if the diff is unclear.
4. Fix the extraction prompt/schema or normalization logic in `src/server.js`.
5. Re-run the same bill, then run the full suite.

## Common Fix Areas

| Symptom | Likely Cause | Fix in |
|---|---|---|
| Missing products | Gemini extraction prompt is too loose, or expected data needs review | `extractExpenseData()` prompt/schema |
| Wrong total | Receipt has multiple totals, subtotal/tax confused with final total | `extractExpenseData()` prompt |
| Wrong qty | Quantity/unit price/line total are visually ambiguous | prompt and post-processing |
| Wrong payment status/type | Receipt does not show payment details clearly | prompt or UI edit before submit |

Definition of done: one bill passes twice, then the full suite passes without regressions.
