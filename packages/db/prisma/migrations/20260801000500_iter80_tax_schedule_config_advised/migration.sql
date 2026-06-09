-- iter80: Beratene Erklärungsfrist (§ 149 Abs. 3 AO) pro Schedule-Konfig.
--
-- advised=true → die Steuertermin-Engine berechnet für die Erklärungs-Arten
-- den letzten Tag des Monats Februar des ZWEITEN Folgejahres statt des
-- 31.07. des Folgejahres (Werktagsverschiebung nach § 108 Abs. 3 AO gilt
-- auch hier). Default false = bisheriges Verhalten — bestehende
-- materialisierte Termine ändern sich nicht stillschweigend.

ALTER TABLE "tax_schedule_config" ADD COLUMN "advised" BOOLEAN NOT NULL DEFAULT false;
