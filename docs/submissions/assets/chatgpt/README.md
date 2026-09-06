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

These full host captures are evidence sources. They are not yet the final
cropped directory screenshots and do not prove Claude rendering. See
`../../validation-status.md` for the full verification boundaries. Never
substitute these for real-provider performance evidence.
