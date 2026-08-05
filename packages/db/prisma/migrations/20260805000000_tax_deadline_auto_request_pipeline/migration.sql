-- Zweistufige Auto-Anforderung aus Steuerterminen (Vorwarnung -> Versand).
--
-- tax_schedule_config:
--   - auto_request: expliziter An/Aus-Schalter je Mandant x Terminart. Vormals
--     war reminder_days_before = 0 der implizite Aus-Schalter — die Semantik
--     wird getrennt (An/Aus vs. Vorlauftage), damit die Tage beim
--     Wiedereinschalten nicht verloren sind.
--   - staff_lead_days: interne Vorwarnung an Zustaendige N Tage vor dem
--     Versandtermin (0 = ohne Vorwarnung sofort am Versandtag).
--
-- tax_deadline (Pipeline-Zustand pro Termin, kein neuer Status-Enum-Wert):
--   - staff_notified_at: Vorwarnung versendet (Stufe 3a).
--   - auto_request_suppressed_at/_by_staff: Mitarbeiter hat den Versand
--     gestoppt (z. B. Unterlagen bereits in Papierform geliefert); aufhebbar.
--     Ohne FK — Muster completed_by_staff.

ALTER TABLE "tax_schedule_config"
  ADD COLUMN "auto_request" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "staff_lead_days" INTEGER NOT NULL DEFAULT 3;

-- Datenmigration: bisheriges "0 = aus" in den neuen Schalter ueberfuehren.
-- Die Vorlauftage landen wieder auf dem Default, damit ein spaeteres
-- Reaktivieren nicht mit 0 Tagen (= sofort faellig) startet.
UPDATE "tax_schedule_config"
  SET "auto_request" = false, "reminder_days_before" = 10
  WHERE "reminder_days_before" = 0;

ALTER TABLE "tax_deadline"
  ADD COLUMN "staff_notified_at" TIMESTAMPTZ(6),
  ADD COLUMN "auto_request_suppressed_at" TIMESTAMPTZ(6),
  ADD COLUMN "auto_request_suppressed_by_staff" UUID;
