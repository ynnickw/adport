-- Catalog profiles may be installed independently of the base provider schema.
set local lock_timeout = '5s';
do $migration$
begin
  if to_regclass('private.mcp_tool_catalog_settings') is not null then
    alter table private.mcp_tool_catalog_settings
      drop constraint if exists mcp_tool_catalog_settings_providers_check;
    alter table private.mcp_tool_catalog_settings
      add constraint mcp_tool_catalog_settings_providers_check
      check (providers <@ array['gtm','google','meta','tiktok','apple','microsoft','reddit','snapchat','spotify','pinterest','linkedin','x']::text[]);
  end if;
end
$migration$;
