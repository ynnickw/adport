// Shared header, setup tabs, and copy buttons. Page-specific scripts load alongside.

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
