# Claude Code community marketplace submission

Public third-party submission target: `claude-community`, Anthropic's reviewed community marketplace. Individual authors submit through https://platform.claude.com/plugins/submit; approved plugins are pinned to a commit in `anthropics/claude-plugins-community`. The separately curated `claude-plugins-official` marketplace has no application process.

## Listing

- **Name:** Adport
- **Repository:** https://github.com/ynnickw/adport
- **Plugin path:** `plugins/adport`
- **Homepage:** https://adport.dev
- **Support:** https://adport.dev/support
- **Description:** Safely analyze and manage paid media across connected advertising platforms.

## Gate

1. Run `claude --plugin-dir ./plugins/adport` and exercise account listing, reporting, preview, explicit approval, and apply.
2. Run `claude plugin validate ./plugins/adport --strict` and resolve every warning.
3. Confirm the remote OAuth flow returns to Claude Code and grants Reader workspaces read-only tools.
4. Confirm approved paid workspaces receive write tools and every mutation still uses the two-call policy gate.
5. Submit through Anthropic's Console form and verify the pinned source commit in `anthropics/claude-plugins-community` after approval and catalog sync.
