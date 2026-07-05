-- ----------------------------------------------------------------------------
-- iter94: Einspruchsfrist-Backstop korrigieren (§ 355 AO + § 122 Abs. 2 AO).
--
-- Der bisherige Trigger-Default rechnete `notice_date + 33 Tage` (Bekanntgabe-
-- fiktion 3 Tage + pauschal 30 Tage). Das ist zweifach falsch:
--   * § 122 Abs. 2 Nr. 1 AO (Fassung ab 01.01.2025): Bekanntgabefiktion 4 Tage.
--   * § 355 Abs. 1 AO: Einspruchsfrist ein MONAT (kalendarisch, §§ 187/188 BGB),
--     nicht 30 Tage — die Pauschale kann eine SPÄTERE Frist ausweisen als die
--     gesetzliche (Bestandskraft-/Haftungsrisiko).
--
-- Maßgeblich ist die App-Berechnung in @taxtronik/tax (appealDeadline: inkl.
-- Werktagsverschiebung § 108 Abs. 3 AO). Dieser Trigger ist nur ein Backstop,
-- falls appeal_deadline beim Insert NULL bleibt. Er nutzt daher die kalendarisch
-- korrekte Monatsaddition (Postgres `+ INTERVAL '1 month'` behandelt Monatsenden
-- richtig, z. B. 2027-01-31 -> 2027-02-28), ohne Werktagsverschiebung — eine
-- dadurch evtl. auf ein Wochenende fallende Backstop-Frist liegt eher zu früh
-- (fristwahrend), nie zu spät.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.tax_notice_set_appeal_deadline() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.appeal_deadline IS NULL THEN
    NEW.appeal_deadline := (NEW.notice_date + INTERVAL '4 days' + INTERVAL '1 month')::date;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
