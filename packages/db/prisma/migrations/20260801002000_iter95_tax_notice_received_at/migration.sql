-- ----------------------------------------------------------------------------
-- iter95: tax_notice.received_at — tatsächlicher Zugangstag des Bescheids.
--
-- § 122 Abs. 2 AO Halbsatz 2: die 4-Tage-Bekanntgabefiktion gilt, "außer wenn
-- der Verwaltungsakt nicht oder zu einem späteren Zeitpunkt zugegangen ist".
-- Kam der Bescheid tatsächlich später an (Postverzögerung, im FA liegen-
-- geblieben), beginnt die Einspruchsfrist (§ 355 AO) erst mit dem echten
-- Zugang. Die App berechnet appeal_deadline aus notice_date + optional
-- received_at (@taxtronik/tax appealDeadline); NULL = Fiktion maßgeblich.
-- ----------------------------------------------------------------------------

ALTER TABLE "tax_notice" ADD COLUMN "received_at" DATE;
