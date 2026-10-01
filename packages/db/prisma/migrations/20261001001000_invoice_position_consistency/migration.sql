-- INV-LIFECYCLE-FREEZE-001: serialize every position write with the invoice's
-- DRAFT -> issued transition. Keep existing trigger/function names so restore
-- tooling and the established targeted integration-test cleanup stay valid.
CREATE OR REPLACE FUNCTION app.invoice_position_protect() RETURNS TRIGGER AS $$
DECLARE
    inv_status public.invoice_status;
BEGIN
    IF TG_OP = 'UPDATE' AND (
        NEW.id IS DISTINCT FROM OLD.id OR
        NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
    ) THEN
        RAISE EXCEPTION 'Festschreibung: Identität und Rechnungszuordnung einer Position sind unveränderlich.'
            USING ERRCODE = 'restrict_violation';
    END IF;

    SELECT status INTO inv_status FROM public.invoice
        WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id)
        FOR UPDATE;
    IF inv_status IS NOT NULL AND inv_status <> 'DRAFT' THEN
        RAISE EXCEPTION 'Festschreibung: Positionen einer versendeten Rechnung sind unveränderlich.'
            USING ERRCODE = 'restrict_violation';
    END IF;
    -- A DRAFT invoice's cascade delete sees its already removed parent.
    -- Inserts/updates must never bypass the guard through an invisible parent.
    IF inv_status IS NULL AND TG_OP <> 'DELETE' THEN
        RAISE EXCEPTION 'Festschreibung: Zugehörige Rechnung nicht gefunden.'
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public, app;
