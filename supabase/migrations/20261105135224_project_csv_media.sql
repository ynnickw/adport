-- CSV remains private; extend the existing allowlist without changing access policies.
update storage.buckets
set allowed_mime_types = array_append(allowed_mime_types, 'text/csv')
where id = 'creative-media'
  and allowed_mime_types is not null
  and not ('text/csv' = any(allowed_mime_types));
