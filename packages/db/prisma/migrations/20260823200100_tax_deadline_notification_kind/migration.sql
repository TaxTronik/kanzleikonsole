-- Interne Eskalation, wenn eine automatische Portal-Anforderung zwar
-- angelegt, ihre Mandantenbenachrichtigung aber nicht sicher angenommen wurde.
-- Separates File: PostgreSQL darf einen neuen Enum-Wert nicht zuverlässig im
-- selben Migrationstransaktionsblock verwenden.

ALTER TYPE "notification_kind"
  ADD VALUE IF NOT EXISTS 'TAX_DEADLINE_NOTIFICATION_FAILED';
