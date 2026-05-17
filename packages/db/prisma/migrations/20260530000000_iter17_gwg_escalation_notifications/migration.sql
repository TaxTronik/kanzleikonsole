-- =============================================================================
-- Iter. 17: NotificationKind erweitern für GwG-Eskalation + Ausweis-Ablauf
-- =============================================================================

ALTER TYPE "notification_kind" ADD VALUE 'GWG_EXPIRY_90D' AFTER 'GWG_EXPIRY_SOON';
ALTER TYPE "notification_kind" ADD VALUE 'GWG_EXPIRY_30D' AFTER 'GWG_EXPIRY_90D';
ALTER TYPE "notification_kind" ADD VALUE 'GWG_EXPIRED' AFTER 'GWG_EXPIRY_30D';
ALTER TYPE "notification_kind" ADD VALUE 'GWG_ID_EXPIRY_SOON' AFTER 'GWG_EXPIRED';
ALTER TYPE "notification_kind" ADD VALUE 'GWG_ID_EXPIRED' AFTER 'GWG_ID_EXPIRY_SOON';
