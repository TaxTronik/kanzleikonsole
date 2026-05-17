-- Iter. 34b — neue Notification-Kinds für Quickwin-Reminders
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'TAX_NOTICE_APPEAL_REMINDER';
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'CLIENT_REMINDER_DUE';
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'PENDING_BINDER_OVERDUE';
