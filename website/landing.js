document.querySelectorAll("[data-agent-tabs]").forEach((setup) => {
  const tabList = setup.querySelector('[role="tablist"]');
  const tabs = Array.from(tabList.querySelectorAll('[role="tab"]'));
  const panels = Array.from(setup.querySelectorAll('[role="tabpanel"]'));
  const selectTab = (selected) => {
    tabs.forEach((tab) => {
      const active = tab === selected;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    panels.forEach((panel) => { panel.hidden = panel.id !== selected.getAttribute("aria-controls"); });
  };
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => selectTab(tab));
    tab.addEventListener("keydown", (event) => {
      let next;
      if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
      else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = tabs.length - 1;
      else return;
      event.preventDefault();
      selectTab(tabs[next]);
      tabs[next].focus();
    });
  });
  selectTab(tabs[0]);
  tabList.hidden = false;
});

document.querySelectorAll("[data-copy-command]").forEach((copyButton) => {
  const label = copyButton.querySelector(".copy-label");
  const originalLabel = label.textContent;
  let resetTimer;

  copyButton.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(copyButton.dataset.copyCommand);
      label.textContent = "Copied ✓";
    } catch {
      label.textContent = "Select and copy above";
    }

    window.clearTimeout(resetTimer);
    resetTimer = window.setTimeout(() => {
      label.textContent = originalLabel;
    }, 2200);
  });
});

const heroSignup = document.querySelector(".hero-signup");
if (heroSignup) {
  const trigger = heroSignup.querySelector(".hero-signup-trigger");
  const form = heroSignup.querySelector("form");
  const close = heroSignup.querySelector(".hero-signup-close");
  trigger.addEventListener("click", (event) => {
    event.preventDefault();
    const initialWidth = trigger.getBoundingClientRect().width;
    trigger.hidden = true;
    trigger.setAttribute("aria-expanded", "true");
    heroSignup.classList.add("is-open");
    form.hidden = false;
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const surface = form.querySelector(".hero-signup-surface");
      surface.animate([
        { transform: `scaleX(${initialWidth / surface.getBoundingClientRect().width})`, backgroundColor: "#1d1d1f" },
        { transform: "scaleX(1)", backgroundColor: "#fff" },
      ], { duration: 360, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
      form.querySelectorAll("input, button, p").forEach((element) => {
        element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260 });
      });
    }
    form.querySelector("input[type=email]").focus({ preventScroll: true });
  });
  const collapse = () => {
    if (form.querySelector("button[type=submit]").disabled) return;
    form.hidden = true;
    heroSignup.classList.remove("is-open");
    trigger.hidden = false;
    trigger.setAttribute("aria-expanded", "false");
    trigger.focus({ preventScroll: true });
  };
  close.addEventListener("click", collapse);
  form.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); collapse(); }
  });
}

document.querySelectorAll(".waitlist-form").forEach((waitlistForm) => {
  const button = waitlistForm.querySelector("button[type=submit]");
  const status = waitlistForm.querySelector(".waitlist-status");
  let submitting = false;

  waitlistForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submitting || !waitlistForm.reportValidity()) return;
    submitting = true;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.setAttribute("aria-label", "Joining waitlist");
    status.dataset.error = "false";
    status.textContent = "";
    const fields = new FormData(waitlistForm);
    try {
      const response = await fetch(waitlistForm.action, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "omit",
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({ email: fields.get("email"), website: fields.get("website"), consent: true }),
      });
      const result = await response.json();
      if (!response.ok || result.ok !== true) {
        throw new Error(response.status === 429
          ? "Too many attempts. Please try again in a minute."
          : "Couldn’t join right now. Please try again, or email yannick@adport.dev.");
      }
      status.textContent = "You’re on the list. We’ll email you when early access opens.";
      waitlistForm.reset();
    } catch (error) {
      status.dataset.error = "true";
      status.textContent = error instanceof Error && error.message.startsWith("Too many")
        ? error.message : "Couldn’t join right now. Please try again, or email yannick@adport.dev.";
    } finally {
      submitting = false;
      button.disabled = false;
      button.removeAttribute("aria-busy");
      button.removeAttribute("aria-label");
    }
  });
});
