# Claude Code marketplace submission

Public third-party submission target: `claude-community`. Anthropic's `claude-plugins-official` catalog is curated separately and has no direct application path.

## Listing

- **Name:** Adport
- **Repository:** https://github.com/ynnickw/adport
- **Plugin path:** `plugins/adport`
- **Homepage:** https://adport.dev
- **Support:** yannick@adport.dev
- **Description:** Safely analyze and manage paid media across connected advertising platforms.

## Gate

1. Run `claude --plugin-dir ./plugins/adport` and exercise account listing, reporting, preview, explicit approval, and apply.
2. Run `claude plugin validate ./plugins/adport --strict` and resolve every warning.
3. Confirm the remote OAuth flow returns to Claude Code and grants Reader workspaces read-only tools.
4. Confirm approved paid workspaces receive write tools and every mutation still uses the two-call policy gate.
5. Submit through the Anthropic Console plugin form and verify the pinned commit in `anthropics/claude-plugins-community` after approval.
