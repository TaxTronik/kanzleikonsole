-- =============================================================================
-- iter106 — Storno einer bereits BEZAHLTEN Rechnung zulassen (QW10).
--
-- Eine fehlerhafte, bereits als PAID markierte Rechnung war bisher gar nicht
-- korrigierbar (PAID terminal). Fachlich ist der Storno-/Korrekturbeleg nach
-- § 14c Abs. 1 i. V. m. § 17 UStG aber gerade dann geboten. Die Statusmatrix
-- des Freeze-Triggers erhält daher den Übergang PAID -> CANCELLED (app-seitig
-- gespiegelt in invoicing/number.ts).
--
-- Bewusste Grenzen (Produktentscheidung): die Rückzahlung des Zahlungseingangs
-- ist KEIN automatischer Zahlungsfluss, sondern wird als Pflicht-Vermerk auf dem
-- Korrekturbeleg dokumentiert; die abgerechneten Zeiteinträge werden bei einem
-- bezahlten Storno NICHT zur Neuabrechnung freigegeben (die Leistung ist bezahlt).
-- Beides in cancelInvoiceAction.
--
-- Rein additiv: CREATE OR REPLACE mit dem Funktionsrumpf aus iter102 (Freeze-
-- Block inkl. iter98/100/101-Felder) plus der neuen Matrix-Zeile. Der bestehende
-- Trigger nutzt die ersetzte Funktion automatisch.
-- =============================================================================

CREATE OR REPLACE FUNCTION app.invoice_protect_update() RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status <> 'DRAFT' THEN
        IF (NEW.number IS DISTINCT FROM OLD.number
            OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
            OR NEW.client_id IS DISTINCT FROM OLD.client_id
            OR NEW.subject IS DISTINCT FROM OLD.subject
            OR NEW.issue_date IS DISTINCT FROM OLD.issue_date
            OR NEW.due_date IS DISTINCT FROM OLD.due_date
            OR NEW.net_amount IS DISTINCT FROM OLD.net_amount
            OR NEW.vat_amount IS DISTINCT FROM OLD.vat_amount
            OR NEW.total_amount IS DISTINCT FROM OLD.total_amount
            OR NEW.vat_rate IS DISTINCT FROM OLD.vat_rate
            OR NEW.format IS DISTINCT FROM OLD.format
            OR NEW.notes IS DISTINCT FROM OLD.notes
            OR NEW.category_id IS DISTINCT FROM OLD.category_id
            OR NEW.created_by_staff IS DISTINCT FROM OLD.created_by_staff
            OR NEW.created_at IS DISTINCT FROM OLD.created_at
            OR NEW.service_period_start IS DISTINCT FROM OLD.service_period_start
            OR NEW.service_period_end IS DISTINCT FROM OLD.service_period_end
            OR NEW.vat_exemption_reason IS DISTINCT FROM OLD.vat_exemption_reason
            OR NEW.storno_of_id IS DISTINCT FROM OLD.storno_of_id) THEN
            RAISE EXCEPTION 'Festschreibung: Rechnung % ist nach dem Versand unveränderlich.', OLD.number
                USING ERRCODE = 'restrict_violation';
        END IF;
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status THEN
        IF NOT (
            (OLD.status = 'DRAFT'   AND NEW.status IN ('SENT', 'CANCELLED')) OR
            (OLD.status = 'SENT'    AND NEW.status IN ('PAID', 'OVERDUE', 'CANCELLED')) OR
            (OLD.status = 'OVERDUE' AND NEW.status IN ('PAID', 'CANCELLED')) OR
            (OLD.status = 'PAID'    AND NEW.status = 'CANCELLED')
        ) THEN
            RAISE EXCEPTION 'Festschreibung: Statuswechsel % → % ist nicht zulässig.', OLD.status, NEW.status
                USING ERRCODE = 'restrict_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
