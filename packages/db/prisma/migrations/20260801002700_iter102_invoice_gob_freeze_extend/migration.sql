-- =============================================================================
-- iter102 — Festschreibung (GoB) vervollständigen.
--
-- Der Freeze-Trigger app.invoice_protect_update() aus iter85 zählt eine harte
-- Spaltenliste auf und wurde nie nachgezogen, als spätere Migrationen neue
-- geschäftliche Pflichtfelder ergänzten:
--   - service_period_start / service_period_end (iter98, Leistungszeitraum,
--     § 14 Abs. 4 Nr. 6 UStG)
--   - vat_exemption_reason (iter101, USt-Befreiungsgrund, § 14 Abs. 4 UStG)
--   - storno_of_id (iter100, Storno-Verkettung § 14c/§ 17 UStG)
-- Diese Felder blieben dadurch auch bei SENT/PAID DB-seitig veränderbar — die
-- GoBD-Unveränderlichkeitszusage war unvollständig.
--
-- Rein additiv: CREATE OR REPLACE FUNCTION mit identischem Rumpf wie iter85
-- (Freeze-Block + Status-Übergangs-Matrix), erweitert um die vier Felder im
-- Freeze-Block. Der bestehende Trigger nutzt die ersetzte Funktion automatisch,
-- CREATE TRIGGER wird NICHT wiederholt. Kein schema.prisma-Change (Spalten
-- existieren bereits), kein Backfill (nur künftige UPDATE-Versuche betroffen).
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
            (OLD.status = 'OVERDUE' AND NEW.status IN ('PAID', 'CANCELLED'))
        ) THEN
            RAISE EXCEPTION 'Festschreibung: Statuswechsel % → % ist nicht zulässig.', OLD.status, NEW.status
                USING ERRCODE = 'restrict_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
