-- =============================================================================
-- iter89: Notification-Kind fuer eingereichte GwG-Onboarding-Unterlagen.
-- =============================================================================

ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'GWG_ONBOARDING_SUBMITTED';
