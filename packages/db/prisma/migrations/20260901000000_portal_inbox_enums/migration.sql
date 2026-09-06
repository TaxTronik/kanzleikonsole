-- PORTAL-INBOX-SUBMISSION-001 / ACCESS-SEARCH-SCOPE-001
-- Enum-Erweiterungen stehen bewusst in einer eigenen Migration. PostgreSQL
-- darf neue Enum-Werte erst nach dem Commit sicher in Funktionen verwenden.
ALTER TYPE public.staff_permission_name
  ADD VALUE IF NOT EXISTS 'PORTAL_INBOX_MANAGE';

ALTER TYPE public.notification_kind
  ADD VALUE IF NOT EXISTS 'PORTAL_INBOX_ACTIVITY';
