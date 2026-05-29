-- Iter. 59 — Notification-Kinds für Vollmachten-Ablaufüberwachung.
-- Worker poa-expiry-check warnt 30 Tage vor Ablauf (SOON) und markiert
-- abgelaufene Vollmachten als EXPIRED (EXPIRED).
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'POA_EXPIRY_SOON';
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'POA_EXPIRED';
