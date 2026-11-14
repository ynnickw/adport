-- Retain deletion records until outstanding immutable upload grants expire.
alter table private.creative_media add column deleted_at timestamptz;
