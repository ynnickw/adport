// adport.dev home: the write-gate simulation (shared behaviour lives in site.js).
// The gate mirrors core/src/policy/engine.ts: default policy (25% budget-delta
// cap, 15-minute pending TTL) and the engine's own error messages.

const gate = document.getElementById("console");
if (gate) initGate(gate);

// The poster is a plain YouTube link until someone presses play; only then is the
// privacy-enhanced player loaded (the CSP allows frames from youtube-nocookie.com only).
document.querySelectorAll(".video-facade").forEach((facade) => {
  facade.addEventListener("click", (event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    const player = document.createElement("iframe");
    player.src = `https://www.youtube-nocookie.com/embed/${facade.dataset.videoId}?autoplay=1&rel=0&playsinline=1`;
    player.title = facade.dataset.videoTitle;
    player.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
    player.allowFullscreen = true;
    player.referrerPolicy = "strict-origin-when-cross-origin";
    facade.replaceWith(player);
    player.focus();
  });
});

function initGate(root) {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const transcript = root.querySelector(".transcript");
  const slot = root.querySelector(".ticket-slot");
  const auditList = root.querySelector(".audit-lines");
  const auditFile = root.querySelector(".audit-file");
  const replay = root.querySelector(".console-replay");
  const scenarioButtons = [...document.querySelectorAll(".scenario")];
  const headlineLines = [...document.querySelectorAll(".headline-line")];

  const ACCOUNT = "8204417795";
  const ACCOUNT_LABEL = "Google Ads 820-441-7795";
  const CAMPAIGN = "21490387612";
  const NAME = "Brand Search US";
  const FROM = 40;
  const CAP_PCT = 25;
  const TTL_SECONDS = 15 * 60;

  const scenarios = {
    approve: {
      ask: "Brand Search is at 4.1× ROAS and capped by budget. Raise it from $40 to $48 a day.",
      to: 48,
      apply: 48,
    },
    cap: {
      ask: "Brand Search is converting well. Double it to $80 a day.",
      to: 80,
    },
    swap: {
      ask: "Raise Brand Search from $40 to $48 a day.",
      to: 48,
      apply: 58,
    },
  };

  let current = "approve";
  let run = 0;
  let countdown = 0;
  let pendingId = "";
  let releaseHold = null;

  const money = (value) => `$${value.toFixed(2)}`;
  const micros = (value) => value * 1_000_000;
  const pct = (to) => ((to - FROM) / FROM) * 100;
  const signedPct = (to) => `${pct(to) >= 0 ? "+" : ""}${pct(to).toFixed(1)}%`;
  const escapeHtml = (text) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const summary = (to) => `Change "${NAME}" daily budget ${micros(FROM)} → ${micros(to)} micros`;
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "7c41e9b2-5d0a-4f6e-9b13-2a8e60c4d1f7");

  const setLit = (count) => {
    headlineLines.forEach((line) => line.classList.toggle("is-lit", Number(line.dataset.line) <= count));
  };

  const animate = () => !reducedMotion.matches;

  function stopCountdown() {
    window.clearInterval(countdown);
    countdown = 0;
  }

  function scrollTranscript() {
    // The console has a fixed height; follow the newest turn inside it without moving the page.
    transcript.scrollTo({ top: transcript.scrollHeight, behavior: animate() ? "smooth" : "auto" });
  }

  function addMessage(who, text) {
    const item = document.createElement("li");
    item.className = `msg msg-${who}${animate() ? " enter" : ""}`;
    item.innerHTML = `<span class="who">${who === "user" ? "You" : "Agent"}</span><p></p>`;
    item.querySelector("p").textContent = text;
    transcript.append(item);
    scrollTranscript();
    return item.querySelector("p");
  }

  function addCall(args, kind, highlight) {
    const item = document.createElement("li");
    item.className = `call is-running${animate() ? " enter" : ""}`;
    item.dataset.kind = kind;
    const json = escapeHtml(JSON.stringify(args, null, 2));
    const body = highlight ? json.replace(`&quot;${highlight}&quot;: ${args[highlight]}`, `&quot;${highlight}&quot;: <mark>${args[highlight]}</mark>`) : json;
    item.innerHTML = `<div class="call-head"><span class="call-tool">google_set_budget</span><span class="call-kind">${kind === "apply" ? "apply" : "preview"}</span></div><pre><code>${body}</code></pre>`;
    transcript.append(item);
    scrollTranscript();
    return item;
  }

  function appendAudit(event, extra) {
    const now = new Date();
    auditFile.textContent = `audit-${now.toISOString().slice(0, 7)}.jsonl`;
    const entry = { ts: now.toISOString(), event, provider: "google", tool: "google_set_budget", accountId: ACCOUNT, ...extra };
    const json = escapeHtml(JSON.stringify(entry)).replace(`&quot;event&quot;:&quot;${event}&quot;`, `&quot;event&quot;:&quot;<span class="ev-${event}">${event}</span>&quot;`);
    const item = document.createElement("li");
    if (animate()) item.className = "enter";
    item.innerHTML = `<code>${json}</code>`;
    auditList.append(item);
    // Append-only, like the real log: older lines scroll out of view, never get removed from the story.
    while (auditList.children.length > 12) auditList.firstElementChild.remove();
  }

  function ticketHead(status, label) {
    return `<header class="ticket-head"><span class="ticket-status"><i aria-hidden="true"></i>${label}</span><span class="ticket-account">${ACCOUNT_LABEL}</span></header>
      <h3 class="ticket-summary">${NAME} daily budget</h3>`;
  }

  function diff(to, over) {
    return `<p class="ticket-diff"><s class="diff-from">${money(FROM)}</s><span class="diff-arrow" aria-hidden="true"></span><span class="sr-only">to</span><ins class="diff-to">${money(to)}</ins><span class="diff-delta"${over ? " data-over" : ""}>${signedPct(to)}</span></p>`;
  }

  function checks(list) {
    return `<ul class="checks">${list.map(([state, html], i) => `<li data-check="${state}" data-i="${i}">${html}</li>`).join("")}</ul>`;
  }

  function renderTicket(status, html) {
    const ticket = document.createElement("article");
    ticket.className = "ticket";
    ticket.dataset.status = status;
    ticket.setAttribute("aria-label", "Write preview");
    ticket.innerHTML = html;
    // Stagger the checks through CSSOM (the CSP forbids inline style attributes).
    ticket.querySelectorAll("[data-i]").forEach((li) => li.style.setProperty("--i", li.dataset.i));
    slot.replaceChildren(ticket);
    return ticket;
  }

  function emptyTicket() {
    const ticket = renderTicket("empty", "<p>Waiting for a write. Previews appear here before anything runs.</p>");
    ticket.removeAttribute("aria-label");
  }

  function pendingTicket(to) {
    const ticket = renderTicket("pending", `${ticketHead("pending", "Preview, not applied")}
      ${diff(to, false)}
      ${checks([
        ["ok", "Account is not protected"],
        ["ok", `${signedPct(to)} is inside the ${CAP_PCT}% change cap`],
        ["ok", "Google <code>validate_only</code> accepted it"],
      ])}
      <footer class="stub">
        <div class="token">
          <span class="token-label">pending_operation_id</span>
          <code class="token-id">${pendingId.slice(0, 18)}…</code>
          <span class="token-ttl">Expires in <time datetime="PT15M">15:00</time></span>
        </div>
        <button class="hold" type="button" aria-describedby="hold-hint"><span class="hold-fill" aria-hidden="true" data-label="Hold to approve"></span><span class="hold-label">Hold to approve</span></button>
        <p class="hold-hint" id="hold-hint">Press and hold. Approval should be deliberate.</p>
      </footer>`);
    if (animate()) ticket.classList.add("is-new");

    const time = ticket.querySelector("time");
    const started = Date.now();
    stopCountdown();
    countdown = window.setInterval(() => {
      const left = Math.max(0, TTL_SECONDS - Math.floor((Date.now() - started) / 1000));
      time.textContent = `${String(Math.floor(left / 60)).padStart(2, "0")}:${String(left % 60).padStart(2, "0")}`;
      time.dateTime = `PT${left}S`;
    }, 1000);

    return new Promise((resolve) => {
      releaseHold = resolve;
      bindHold(ticket.querySelector(".hold"), () => resolve(true));
    });
  }

  function rejectedTicket(to) {
    const ticket = renderTicket("rejected", `${ticketHead("rejected", "Rejected by policy")}
      ${diff(to, true)}
      ${checks([
        ["ok", "Account is not protected"],
        ["fail", `${signedPct(to)} exceeds the ${CAP_PCT}% change cap`],
      ])}
      <p class="refusal"><code>POLICY_VIOLATION</code>Policy violation: ${NAME}: ${pct(to).toFixed(1)}% change exceeds the ${CAP_PCT}% budget-delta cap</p>
      <footer class="stub"><p class="stub-result"><span><strong>No token issued.</strong>Nothing was changed, and there is nothing to approve.</span></p></footer>`);
    if (animate()) ticket.classList.add("is-new");
  }

  function appliedTicket(to) {
    const at = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    renderTicket("applied", `${ticketHead("applied", "Applied")}
      ${diff(to, false)}
      <footer class="stub"><p class="stub-result"><span><strong>Applied at ${at}.</strong>The token is spent and can’t be used again. Resource <code>customers/${ACCOUNT}/campaignBudgets/…</code></span></p></footer>`);
  }

  function mismatchTicket(to) {
    renderTicket("mismatch", `${ticketHead("mismatch", "Apply refused")}
      ${diff(to, false)}
      <p class="refusal"><code>PENDING_MISMATCH</code>The operation differs from what was validated. Re-validate with the exact arguments you intend to apply.</p>
      <footer class="stub"><p class="stub-result"><span><strong>Nothing was changed.</strong>The preview said ${money(to)}. The apply call asked for ${money(scenarios.swap.apply)}.</span></p></footer>`);
  }

  function bindHold(button, onComplete) {
    const DURATION = 900;
    const fill = button.querySelector(".hold-fill");
    const label = button.querySelector(".hold-label");
    let start = 0;
    let frame = 0;
    let holding = false;
    let lastKey = 0;
    let done = false;

    const set = (value) => button.style.setProperty("--hold", value.toFixed(3));
    const tick = (now) => {
      const progress = Math.min(1, (now - start) / DURATION);
      set(progress);
      if (progress < 1) { frame = requestAnimationFrame(tick); return; }
      holding = false;
      done = true;
      button.classList.remove("is-holding");
      button.disabled = true;
      fill.dataset.label = "Approved";
      label.textContent = "Approved";
      navigator.vibrate?.(12);
      onComplete();
    };
    const begin = (event) => {
      if (done || holding || button.disabled) return;
      if (event.type === "keydown") {
        if (event.key !== " " && event.key !== "Enter") return;
        event.preventDefault();
        lastKey = Date.now();
        if (event.repeat) return;
      } else if (event.button !== 0) {
        return;
      } else {
        button.setPointerCapture?.(event.pointerId);
      }
      holding = true;
      button.classList.add("is-holding");
      start = performance.now();
      frame = requestAnimationFrame(tick);
    };
    const cancel = () => {
      if (!holding) return;
      holding = false;
      cancelAnimationFrame(frame);
      button.classList.remove("is-holding");
      set(0); // transitions back via the registered --hold property
    };

    button.addEventListener("pointerdown", begin);
    button.addEventListener("pointerup", cancel);
    button.addEventListener("pointercancel", cancel);
    button.addEventListener("lostpointercapture", cancel);
    button.addEventListener("keydown", begin);
    button.addEventListener("keyup", (event) => { if (event.key === " " || event.key === "Enter") cancel(); });
    button.addEventListener("blur", cancel);
    button.addEventListener("contextmenu", (event) => event.preventDefault());
    // Assistive tech activates buttons with a synthetic click and no key or
    // pointer hold; honour it so the demo stays operable without a hold.
    button.addEventListener("click", (event) => {
      if (event.detail !== 0 || holding || done || Date.now() - lastKey < 1500) return;
      start = performance.now() - DURATION;
      holding = true;
      tick(performance.now());
    });
  }

  async function play(name) {
    const id = ++run;
    const live = () => id === run;
    const wait = (ms) => (animate() ? new Promise((resolve) => window.setTimeout(resolve, ms)) : Promise.resolve());
    const scenario = scenarios[name];

    current = name;
    stopCountdown();
    releaseHold?.(false);
    releaseHold = null;
    root.dataset.scenario = name;
    replay.hidden = true;
    transcript.replaceChildren();
    transcript.scrollTop = 0;
    emptyTicket();
    setLit(1);
    root.dataset.ready = "";
    document.querySelector(".hero")?.setAttribute("data-demo", "");

    await wait(320);
    if (!live()) return;
    const ask = addMessage("user", "");
    if (animate()) {
      const caret = document.createElement("span");
      caret.className = "caret";
      for (let i = 1; i <= scenario.ask.length; i += 2) {
        ask.textContent = scenario.ask.slice(0, i);
        ask.append(caret);
        await wait(16);
        if (!live()) return;
      }
    }
    ask.textContent = scenario.ask;

    await wait(380);
    if (!live()) return;
    addMessage("agent", "I’ll ask adport for a preview first.");

    await wait(420);
    if (!live()) return;
    const previewArgs = { account_id: ACCOUNT, campaign_id: CAMPAIGN, daily_budget_micros: micros(scenario.to) };
    const previewCall = addCall(previewArgs, "preview");
    await wait(950);
    if (!live()) return;
    previewCall.classList.remove("is-running");
    setLit(2);

    if (pct(scenario.to) > CAP_PCT) {
      rejectedTicket(scenario.to);
      appendAudit("rejected", { summary: `${NAME}: ${pct(scenario.to).toFixed(1)}% change exceeds the ${CAP_PCT}% budget-delta cap` });
      await wait(700);
      if (!live()) return;
      addMessage("agent", `That’s over your ${CAP_PCT}% change limit, so nothing changed. I can raise it to ${money(FROM * (1 + CAP_PCT / 100))} instead, or you can change max_budget_delta_pct in your policy.`);
      replay.hidden = false;
      return;
    }

    pendingId = uuid();
    appendAudit("validated", { pendingId, summary: summary(scenario.to) });
    const approval = pendingTicket(scenario.to);
    await wait(500);
    if (!live()) return;
    addMessage("agent", "Here’s the preview. Nothing has changed yet. Approve it when you’re ready.");

    const approved = await approval;
    if (!approved || !live()) return;
    stopCountdown();
    releaseHold = null;

    const swapped = scenario.apply !== scenario.to;
    if (swapped) {
      addMessage("agent", `Applying now. Actually, let’s make it ${money(scenario.apply)}.`);
      await wait(350);
      if (!live()) return;
    }
    const applyArgs = { ...previewArgs, daily_budget_micros: micros(scenario.apply), pending_operation_id: pendingId };
    const applyCall = addCall(applyArgs, "apply", swapped ? "daily_budget_micros" : null);
    await wait(850);
    if (!live()) return;
    applyCall.classList.remove("is-running");

    if (swapped) {
      // The engine throws PENDING_MISMATCH before writing anything, so the audit log stays as it was.
      mismatchTicket(scenario.to);
      await wait(500);
      if (!live()) return;
      addMessage("agent", `adport refused it: the arguments don’t match the preview you approved. I’ll request a new preview for ${money(scenario.apply)} if that’s what you want.`);
    } else {
      appliedTicket(scenario.apply);
      appendAudit("applied", { pendingId, summary: summary(scenario.apply), details: { resourceIds: [`customers/${ACCOUNT}/campaignBudgets/9281734410`] } });
      setLit(3);
      await wait(450);
      if (!live()) return;
      addMessage("agent", `Done. ${NAME} now runs at ${money(scenario.apply)} a day, and the change is in your audit log.`);
    }
    replay.hidden = false;
  }

  scenarioButtons.forEach((button) => {
    button.addEventListener("click", () => {
      scenarioButtons.forEach((other) => other.setAttribute("aria-pressed", String(other === button)));
      play(button.dataset.scenario);
    });
  });
  replay.addEventListener("click", () => play(current));

  // The static markup is the no-JS fallback; start fresh once the console is on screen.
  auditList.replaceChildren();
  transcript.replaceChildren();
  emptyTicket();
  root.dataset.ready = "";
  if (!("IntersectionObserver" in window) || !animate()) {
    play(current);
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    observer.disconnect();
    play(current);
  }, { rootMargin: "0px 0px -12% 0px" });
  observer.observe(root);
}
