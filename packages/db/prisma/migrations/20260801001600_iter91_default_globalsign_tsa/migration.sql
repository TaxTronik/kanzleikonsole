-- Bestehende leere TSA-Tenant-Settings auf den sicheren Default heben.
-- Self-Timestamp darf in Production nicht versehentlich aktiv bleiben.
UPDATE "tenant_setting"
   SET "value" = jsonb_set(
     COALESCE("value"::jsonb, '{}'::jsonb),
     '{providerId}',
     '"globalsign"'::jsonb,
     true
   )
 WHERE "key" = 'evidence.tsa'
   AND COALESCE("value"::jsonb ->> 'providerId', '') = '';
