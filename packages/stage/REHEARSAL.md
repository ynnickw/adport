# Rehearsal: adport.dev scenes

Gold: `subscriptions` for GateHero (a system story with two places, the agent session and Approvals, and no cursor); `static-card` for the workflow cards.

Beats (GateHero): the agent asks in its session, the preview lands in Approvals with nothing changed, the exact apply call runs and reaches History. Each loop names the next platform and assistant and drives the headline's rotators (`adport:scenario`). About 10s per loop; the card and new rows close and the session clears behind a fade, so no data rewinds in view.

Captured: 1440 and 390 on the real page under `website/vercel.json`'s CSP, loop contact sheets, the `diff` and `reset` marks, workflow cards at both widths.

Film lines left standing, each judged on its frame:
- `kit override: .ss-check__fill`: the kit's own rule; film reads the bundled `stage.css` as demo CSS.
- `uneven inset: .ss-window__bar`: the kit's title bar with lights only.
- `near aligned` / `loose stack` on the pending card: a card header over its body, nested on purpose.
- `framing:` on the compact hero: film reads the session window as the hero; it is a deliberate stack of session over window.
- `jump: ss-term__cmd`: typing, one character per step.

Not checked: Safari and Firefox, touch devices, live frame pacing, reduced motion on the real page.
