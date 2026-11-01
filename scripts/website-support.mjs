const assets = `\n<!-- support-assets:start -->
<link rel="stylesheet" href="/support.css" />
<script src="/support.js" defer></script>
<!-- support-assets:end -->\n`;

const widget = `\n<!-- support:start -->
<a class="site-support-launcher" href="mailto:yannick@adport.dev?subject=Adport%20support" aria-label="Need help? Message Yannick" aria-haspopup="dialog" aria-controls="site-support-dialog" aria-expanded="false"><img src="/yannick-support.png" alt="" width="36" height="36" decoding="async" /><span>Need help?</span></a>
<dialog class="site-support-dialog" id="site-support-dialog" aria-labelledby="site-support-title">
  <div class="site-support-heading"><h2 id="site-support-title">Message Yannick</h2><button class="site-support-close" type="button" aria-label="Close support"><span aria-hidden="true">×</span></button></div>
  <div class="site-support-person"><img src="/yannick-support.png" alt="Yannick, Adport founder" width="58" height="58" decoding="async" /><div><strong>Hey, I’m Yannick, the founder.</strong><p>Have a question? Send me a message. I read every one.</p></div></div>
  <p class="site-support-error" role="alert" hidden></p><p class="site-support-success" role="status" hidden></p>
  <form class="site-support-form" action="/api/support" method="post">
    <label for="site-support-email">Your email<input id="site-support-email" name="email" type="email" autocomplete="email" maxlength="254" required placeholder="you@company.com" /></label>
    <label for="site-support-kind">Message type<select id="site-support-kind" name="kind"><option value="support">Question</option><option value="feedback">Product feedback</option><option value="bug">Bug report</option></select></label>
    <label for="site-support-message">Your message<textarea id="site-support-message" name="message" rows="4" minlength="10" maxlength="5000" required placeholder="Hi Yannick, I could use a hand with…"></textarea></label>
    <div class="site-support-honeypot" aria-hidden="true"><label>Website<input name="website" tabindex="-1" autocomplete="off" /></label></div>
    <button class="site-support-send" type="submit">Send to Yannick</button>
    <p class="site-support-note">Your email and message are used to reply. <a href="/privacy#support-messages">Privacy</a></p>
  </form>
  <a class="site-support-email" href="mailto:yannick@adport.dev?subject=Adport%20support">Prefer email? yannick@adport.dev ↗</a>
</dialog>
<!-- support:end -->\n`;

export function withSupport(html) {
  const clean = html.replace(/\n?<!-- support-assets:start -->[\s\S]*?<!-- support-assets:end -->\n?/g, '')
    .replace(/\n?<!-- support:start -->[\s\S]*?<!-- support:end -->\n?/g, '');
  return clean.replace('</head>', `${assets}</head>`).replace('</body>', `${widget}</body>`).replace(/[ \t]+$/gm, '');
}
