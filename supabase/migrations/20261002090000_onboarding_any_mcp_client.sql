-- The onboarding agent choice "VS Code" is replaced by "Any MCP client" ('mcp').
-- 'vscode' stays valid so rows saved before this release remain readable; the app reads it as 'mcp'.
alter table public.organization_onboarding
  drop constraint if exists organization_onboarding_selected_agent_check;

alter table public.organization_onboarding
  add constraint organization_onboarding_selected_agent_check
  check (selected_agent is null or selected_agent in ('chatgpt', 'codex', 'claude-code', 'claude', 'cursor', 'mcp', 'vscode'));

update public.organization_onboarding set selected_agent = 'mcp' where selected_agent = 'vscode';
