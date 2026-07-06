-- ----------------------------------------------------------------------------
-- iter99: Einspruchs-Statusmodell um Klageweg + Teilabhilfe erweitern.
--
-- Bisher endete das Modell nach der Einspruchsentscheidung (ZURUECKGEWIESEN →
-- RECHTSKRAEFTIG). Damit war die KLAGEFRIST zum Finanzgericht (§ 47 Abs. 1 FGO,
-- 1 Monat ab Bekanntgabe der Einspruchsentscheidung) NICHT überwacht — die
-- gefährlichste Lücke für ein Fristenkontroll-Tool.
--
-- 1. Enum um TEILABHILFE (§ 367 Abs. 2 AO) und KLAGE erweitern.
-- 2. klage_deadline: überwachte Klagefrist (analog appeal_deadline), gesetzt
--    beim Übergang nach ZURUECKGEWIESEN/TEILABHILFE. NULL = keine offene Klage.
-- Additiv, kein Backfill.
-- ----------------------------------------------------------------------------

ALTER TYPE "tax_notice_status" ADD VALUE IF NOT EXISTS 'TEILABHILFE' BEFORE 'ZURUECKGEWIESEN';
ALTER TYPE "tax_notice_status" ADD VALUE IF NOT EXISTS 'KLAGE' BEFORE 'RECHTSKRAEFTIG';

ALTER TABLE "tax_notice" ADD COLUMN "klage_deadline" DATE;
