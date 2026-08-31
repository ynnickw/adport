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

const waitlistForm = document.querySelector(".waitlist-form");
if (waitlistForm) {
  const button = waitlistForm.querySelector("button[type=submit]");
  const status = document.querySelector("#waitlist-status");
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
}
