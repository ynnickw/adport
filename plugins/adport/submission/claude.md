# Claude Code official marketplace submission

Public third-party submission target: `claude-plugins-official`, Anthropic's managed directory. Submit through https://clau.de/plugin-directory-submission; approved third-party plugins are listed under `external_plugins` in `anthropics/claude-plugins-official`.

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
5. Submit through Anthropic's plugin directory submission form and verify the pinned source commit under `external_plugins` in `anthropics/claude-plugins-official` after approval.
