-- =============================================================================
-- iter82 — DSGVO Art. 17: Vernichtungsvermerk für die Mandanten-Anonymisierung.
--
-- client.anonymized_at — Pendant zu gwg_check.destroyed_at (iter81): Gesetzt =
-- die personenbezogenen Stammdaten des Mandanten (natürliche Person, NATPERS)
-- wurden nach Ablauf ALLER Aufbewahrungsfristen anonymisiert (GoBD 10 J. nach
-- § 147 AO, GwG 5 J. nach § 8 Abs. 4 — jeweils ab Jahresende des Mandatsendes;
-- die längste Frist gewinnt). Der Datensatz bleibt als Skelett (id, kind,
-- Mandatsende, Vernichtungsvermerk) erhalten; Name/Adresse/Custom-Felder sind
-- entfernt, verknüpfte Kontakte mit-anonymisiert.
-- Review-Queue: /staff/admin/dsgvo-retention (confirmClientAnonymizationAction).
-- =============================================================================

ALTER TABLE "client" ADD COLUMN "anonymized_at" TIMESTAMP(3);
