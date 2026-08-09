const copyButton = document.querySelector("[data-copy-command]");

if (copyButton) {
  const label = copyButton.querySelector(".copy-label");
  const icon = copyButton.querySelector(".copy-icon");
  let resetTimer;

  copyButton.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(copyButton.dataset.copyCommand);
      label.textContent = "Copied install command";
      icon.textContent = "✓";
    } catch {
      label.textContent = "Could not copy";
      icon.textContent = "!";
    }

    window.clearTimeout(resetTimer);
    resetTimer = window.setTimeout(() => {
      label.textContent = "Copy install command";
      icon.textContent = "⧉";
    }, 2200);
  });
}
