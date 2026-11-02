// adport.dev behaviour shared by every page: header state, tabs, copy buttons,
// and the waitlist forms. Page-specific scripts (home.js) load alongside.

// Read lazily: this file also runs in a window-less test sandbox (scripts/website/test-provider-pages.mjs).
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const header = document.querySelector(".site-header");
if (header) {
  let queued = false;
  const update = () => {
    header.dataset.scrolled = String(window.scrollY > 8);
    queued = false;
  };
  window.addEventListener("scroll", () => {
    if (!queued) { queued = true; requestAnimationFrame(update); }
  }, { passive: true });
  update();
}

// Header previews: hovering (or focusing) a nav link opens one floating panel that
// resizes and slides between destinations. Clicking the link still navigates.
const navPreview = header?.querySelector(".nav-preview");
if (navPreview) initNavPreview(header, navPreview);

function initNavPreview(bar, preview) {
  const canHover = window.matchMedia("(hover: hover) and (pointer: fine) and (min-width: 52rem)");
  const panes = new Map([...preview.querySelectorAll(".nav-pane")].map((pane) => [pane.dataset.pane, pane]));
  const order = [...panes.keys()];
  const triggers = [...bar.querySelectorAll("[data-preview]")];
  let current = null;
  let openTimer = 0;
  let closeTimer = 0;

  preview.querySelectorAll(".mini-logos li, .mini-rules li, .mini-term span").forEach((item) => {
    item.style.setProperty("--i", [...item.parentElement.children].indexOf(item));
  });

  const show = (trigger) => {
    const name = trigger.dataset.preview;
    const pane = panes.get(name);
    const opening = !preview.classList.contains("is-open");
    const barBox = bar.getBoundingClientRect();
    const linkBox = trigger.getBoundingClientRect();
    const width = pane.offsetWidth;
    const center = linkBox.left + linkBox.width / 2 - barBox.left;
    const x = Math.min(Math.max(center - width / 2, 16), barBox.width - width - 16);
    // A fresh open appears in place; only moves between links animate.
    if (opening) preview.classList.add("is-instant");
    preview.style.setProperty("--x", `${x}px`);
    preview.style.setProperty("--ax", `${center - x}px`);
    preview.style.setProperty("--w", `${width}px`);
    preview.style.setProperty("--h", `${pane.offsetHeight}px`);
    const target = order.indexOf(name);
    panes.forEach((other, key) => {
      const index = order.indexOf(key);
      other.classList.toggle("is-active", key === name);
      other.dataset.side = index < target ? "before" : index > target ? "after" : "";
    });
    triggers.forEach((link) => link.classList.toggle("is-previewing", link === trigger));
    if (opening) {
      preview.getBoundingClientRect();
      preview.classList.remove("is-instant");
    }
    preview.classList.add("is-open");
    current = name;
  };

  const hide = () => {
    preview.classList.remove("is-open");
    triggers.forEach((link) => link.classList.remove("is-previewing"));
    current = null;
  };
  const scheduleHide = () => {
    window.clearTimeout(openTimer);
    window.clearTimeout(closeTimer);
    closeTimer = window.setTimeout(hide, 160);
  };

  triggers.forEach((trigger) => {
    trigger.addEventListener("pointerenter", () => {
      if (!canHover.matches) return;
      window.clearTimeout(closeTimer);
      window.clearTimeout(openTimer);
      // Small intent delay on first open; instant once the panel is already showing.
      openTimer = window.setTimeout(() => show(trigger), current ? 0 : 90);
    });
    trigger.addEventListener("pointerleave", scheduleHide);
    trigger.addEventListener("focus", () => { if (canHover.matches && trigger.matches(":focus-visible")) show(trigger); });
    trigger.addEventListener("blur", scheduleHide);
    trigger.addEventListener("click", hide);
  });
  bar.querySelectorAll(".header-meta a:not([data-preview]), .brand-lockup").forEach((link) => link.addEventListener("pointerenter", scheduleHide));
  preview.addEventListener("pointerenter", () => window.clearTimeout(closeTimer));
  preview.addEventListener("pointerleave", scheduleHide);
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") hide(); });
  window.addEventListener("resize", hide);
}

// Agent setup tabs. Without JavaScript every panel stays visible and the tab list stays hidden.
document.querySelectorAll("[data-agent-tabs]").forEach((setup) => {
  const list = setup.querySelector('[role="tablist"]');
  const tabs = [...list.querySelectorAll('[role="tab"]')];
  const panels = [...setup.querySelectorAll('[role="tabpanel"]')];
  const select = (tab, focus) => {
    tabs.forEach((other) => {
      const selected = other === tab;
      other.setAttribute("aria-selected", String(selected));
      other.tabIndex = selected ? 0 : -1;
    });
    panels.forEach((panel) => { panel.hidden = panel.id !== tab.getAttribute("aria-controls"); });
    if (focus) tab.focus();
  };
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => select(tab, false));
    tab.addEventListener("keydown", (event) => {
      const target = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: tabs.length - 1 }[event.key];
      if (target === undefined) return;
      event.preventDefault();
      select(tabs[(target + tabs.length) % tabs.length], true);
    });
  });
  list.hidden = false;
  select(tabs.find((tab) => tab.getAttribute("aria-selected") === "true") ?? tabs[0], false);
});

document.querySelectorAll("[data-copy-command]").forEach((button) => {
  const label = button.querySelector(".copy-label");
  const original = label.innerHTML;
  let reset = 0;
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(button.dataset.copyCommand);
      label.textContent = "Copied";
    } catch {
      label.textContent = "Select it to copy";
    }
    window.clearTimeout(reset);
    reset = window.setTimeout(() => { label.innerHTML = original; }, 2000);
  });
});

// The hero pill slides open into the email form: the orange pill travels right and
// becomes the submit button while the field is uncovered behind it, so the action
// keeps its place. Joining turns the whole form into the confirmation.
const signup = document.querySelector(".hero-signup");
if (signup) {
  const trigger = signup.querySelector(".hero-signup-trigger");
  const form = signup.querySelector("form");
  const surface = form.querySelector(".hero-signup-surface");
  const submit = form.querySelector("button[type=submit]");
  const label = submit.querySelector(".waitlist-button-label");
  const input = form.querySelector("input[type=email]");
  const later = [input, form.querySelector(".hero-signup-meta")];
  const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
  let from = null;
  let running = [];

  const morph = (opening) => {
    running.forEach((animation) => animation.cancel());
    const field = surface.getBoundingClientRect();
    const button = submit.getBoundingClientRect();
    const shut = `inset(0 ${field.width - from.width}px 0 0 round 999px)`;
    const open = "inset(0 0px 0 0 round 999px)";
    const timing = { duration: 560, easing: EASE, fill: "both", direction: opening ? "normal" : "reverse" };
    running = [
      surface.animate([{ clipPath: shut }, { clipPath: open }], timing),
      submit.animate([
        { width: `${from.width}px`, transform: `translateX(${from.left - button.left}px)` },
        { width: `${button.width}px`, transform: "none" },
      ], timing),
      label.animate([{ opacity: 0 }, { opacity: 0, offset: 0.35 }, { opacity: 1 }], timing),
      ...later.map((element) => element.animate([{ opacity: 0, transform: "translateX(-0.5rem)" }, { opacity: 0, offset: 0.3 }, { opacity: 1, transform: "none" }], timing)),
    ];
    return running[0].finished.catch(() => {});
  };

  trigger.addEventListener("click", async (event) => {
    event.preventDefault();
    from = trigger.getBoundingClientRect();
    trigger.hidden = true;
    trigger.setAttribute("aria-expanded", "true");
    signup.classList.add("is-open");
    form.hidden = false;
    input.focus({ preventScroll: true });
    if (!reducedMotion()) await morph(true);
    running.forEach((animation) => animation.cancel());
    running = [];
  });

  const collapse = async () => {
    if (submit.disabled) return;
    if (!reducedMotion() && from) await morph(false);
    running.forEach((animation) => animation.cancel());
    running = [];
    form.hidden = true;
    signup.classList.remove("is-open");
    trigger.hidden = false;
    trigger.setAttribute("aria-expanded", "false");
    trigger.focus({ preventScroll: true });
  };
  form.querySelector(".hero-signup-close").addEventListener("click", collapse);
  form.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); collapse(); }
  });

  // Joined: the field folds into the button, which widens into the confirmation.
  form.addEventListener("waitlist:joined", () => {
    const before = submit.getBoundingClientRect();
    form.dataset.joined = "true";
    label.textContent = "You’re on the list";
    if (reducedMotion()) return;
    const after = submit.getBoundingClientRect();
    submit.animate([
      { width: `${before.width}px`, transform: `translateX(${before.left - after.left}px)` },
      { width: `${after.width}px`, transform: "none" },
    ], { duration: 520, easing: EASE });
    label.animate([{ opacity: 0, transform: "translateY(0.4rem)" }, { opacity: 1, transform: "none" }], { duration: 360, delay: 140, easing: EASE, fill: "backwards" });
  });
}

const FALLBACK_ERROR = "Couldn’t join right now. Try again, or email yannick@adport.dev.";

document.querySelectorAll(".waitlist-form").forEach((form) => {
  const button = form.querySelector("button[type=submit]");
  const status = form.querySelector(".waitlist-status");
  let busy = false;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy || !form.reportValidity()) return;
    busy = true;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.setAttribute("aria-label", "Joining waitlist");
    status.dataset.error = "false";
    status.textContent = "";
    const fields = new FormData(form);
    try {
      const response = await fetch(form.action, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "omit",
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({ email: fields.get("email"), website: fields.get("website"), consent: true }),
      });
      const result = await response.json().catch(() => ({}));
      if (response.status === 429) throw new Error("Too many attempts. Try again in a minute.");
      if (!response.ok || result.ok !== true) throw new Error(FALLBACK_ERROR);
      status.textContent = "You’re on the list. We’ll email you when early access opens.";
      form.reset();
      form.dispatchEvent(new CustomEvent("waitlist:joined"));
    } catch (error) {
      status.dataset.error = "true";
      status.textContent = error instanceof Error && error.message.startsWith("Too many") ? error.message : FALLBACK_ERROR;
    } finally {
      busy = false;
      button.disabled = false;
      button.removeAttribute("aria-busy");
      button.removeAttribute("aria-label");
    }
  });
});
