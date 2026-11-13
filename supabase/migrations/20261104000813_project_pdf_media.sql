-- PDF sources remain private and checksum-bound, using the same scoped grants.
update storage.buckets
set allowed_mime_types = array_append(allowed_mime_types, 'application/pdf')
where id = 'creative-media'
  and allowed_mime_types is not null
  and not ('application/pdf' = any(allowed_mime_types));
