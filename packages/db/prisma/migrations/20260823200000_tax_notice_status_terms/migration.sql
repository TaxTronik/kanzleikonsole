-- Fachlich getrennte Verwaltungsakt-/Rechtsbehelfszustände.
--
-- Ein Änderungs-/Teilabhilfebescheid ist keine (Teil-)Einspruchsentscheidung
-- und löst allein keine Klagefrist aus. Für die gerichtliche Folgefrist gibt
-- es deshalb einen eigenen Status. Diese expandierende Enum-Änderung bleibt
-- separat, weil PostgreSQL neue Enum-Werte nicht sicher im selben
-- Migrationstransaktionsblock verwenden lässt.

ALTER TYPE "tax_notice_status"
  ADD VALUE IF NOT EXISTS 'TEILEINSPRUCHSENTSCHEIDUNG' BEFORE 'ZURUECKGEWIESEN';
