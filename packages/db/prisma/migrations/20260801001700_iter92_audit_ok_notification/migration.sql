-- iter92: Positive Benachrichtigung nach manuell erfolgreicher Audit-Chain-Pruefung.
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'SYSTEM_AUDIT_OK' AFTER 'SYSTEM_AUDIT_BREAK';
