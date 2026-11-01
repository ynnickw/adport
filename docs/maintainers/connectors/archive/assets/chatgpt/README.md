# Actual ChatGPT host captures

Captured September 6, 2026, with the in-app browser from real hosted Adport tool
calls. Production merge: `c1f93a0c04d7f4105c7a20b1e462653d58343314`.
All advertising data is explicitly fictional synthetic reviewer data. No live
provider was accessed for these captures. The sidebar was collapsed before
capture to avoid exposing unrelated conversation titles. Images are unedited
browser screenshots, not composited or generated cards.

| File | Prompt / operation | What it proves |
| --- | --- | --- |
| `recommendations.png` | Fresh `audit_run` for demo Europe / last seven days, then `recommendations_list` for open demo findings | Both host cards display one persisted fictional CPA warning. |
| `budget-preview.png` | Read the current synthetic Search budget, then preview EUR 27 without a pending token | Refreshed host template renders EUR 26.25 → EUR 27.00 and Not applied. |
| `report-eur.png` | Report six campaign metrics for demo Europe only / last seven days | Real populated inline bar chart, EUR-only totals and synthetic label. |
| `report-conversions-live.png` | Switch the actual four-metric report to Conversions after a 390 CSS-pixel responsive test | Actual 35 / 21 / 7 bars and 4.50x reported ROAS; unmodified desktop capture after restoring viewport. |
| `budget-preview-precision-before.png` | Fresh current-budget read followed by a 5% preview, no apply | Records the precision defect: 27,562,500 micros rendered as EUR 27.56. Not a final listing asset. |
| `budget-preview-precision-fixed.png` | Same saved response after PR #61 production deployment, connector refresh and conversation reload | Real Before/After table now shows EUR 26.25 to EUR 27.5625 exactly; no new write invocation. |
| `budget-applied-live.png` | Exact pending synthetic apply followed by campaign readback | Partial card and host readback evidence only; the card header is outside this capture. Not a final listing image. |
| `report-usd-conversions-live.png` | Fresh six-metric report for both synthetic accounts, then USD and Conversions selected | Actual USD card shows $154, 791 clicks, 42 conversions, 6.55x ROAS and a 42-conversion bar; EUR remains a separate selectable group. |

These full host captures are evidence sources. They are not yet the final
cropped directory screenshots and do not prove Claude rendering. See
`../../validation-status.md` for the full verification boundaries. Never
substitute these for real-provider performance evidence.
