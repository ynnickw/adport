-- Existing catalog and creation grants retain their meanings. Transfer delegation
-- binds an owner-attested source advertiser/catalog to one destination BC.
alter table private.tiktok_catalog_access
  drop constraint tiktok_catalog_access_resource_kind_check,
  drop constraint tiktok_catalog_access_access_mode_check,
  drop constraint tiktok_catalog_access_check;
alter table private.tiktok_catalog_access
  add constraint tiktok_catalog_access_resource_kind_check check (resource_kind in ('catalog', 'catalog_creation', 'catalog_migration')),
  add constraint tiktok_catalog_access_access_mode_check check (access_mode in ('none', 'read', 'write', 'create', 'migrate')),
  add constraint tiktok_catalog_access_check check (
    (resource_kind = 'catalog' and access_mode in ('none', 'read', 'write')) or
    (resource_kind = 'catalog_creation' and resource_id = business_id and access_mode in ('none', 'create')) or
    (resource_kind = 'catalog_migration' and access_mode in ('none', 'migrate'))
  );
-- RLS, private-schema placement and backend-only privileges are unchanged.
