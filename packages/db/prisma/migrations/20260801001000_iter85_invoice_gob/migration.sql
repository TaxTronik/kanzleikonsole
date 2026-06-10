-- =============================================================================
-- iter85 — Fakturierung GoB-fest (PS-880-Scope; Befunde 1-3 der Modul-Inventur,
-- vgl. docs/compliance/idw-ps880-pruefungsbereitschaft.md Abschnitt 3.3).
--
-- Teil 1: invoice_number_seq — automatische, lückenlose Rechnungsnummern je
--   Tenant+Jahr (Format YYYY-NNNN). Vergabe atomar unter Advisory-Lock in der
--   Anlage-Transaktion (apps/web/src/server/invoicing/number.ts); die Sequenz
--   zählt nur bei erfolgreichem INSERT hoch → keine Lücken. Storno behält die
--   Nummer (CANCELLED erklärt sie), EXTERNAL-Rechnungen behalten die Nummer
--   des Fremdsystems (manuell, nur Unique-Schutz).
--   Initialisierung pro Jahr aus dem MAX bestehender YYYY-N-Nummern, damit
--   Bestandsdaten nicht kollidieren.
--
-- Teil 2: Festschreibung — nach Verlassen von DRAFT sind die geschäftlichen
--   Felder der Rechnung und ihre Positionen DB-seitig unveränderlich (auch
--   für den Owner; Muster: protect_immutable_document_version, init-Migration).
--   Erlaubt bleiben nur die Lebenszyklus-Felder (status, sent_at, paid_at,
--   document_id, updated_at) — document_id, weil die GoBD-Archivkopie bei
--   Bestandsrechnungen nachträglich verknüpft wird.
--
-- Teil 3: Statusübergangs-Matrix + Löschschutz auf DB-Ebene (die App prüft
--   zusätzlich mit verständlichen Meldungen; der Trigger ist der Backstop):
--     DRAFT   -> SENT | CANCELLED
--     SENT    -> PAID | OVERDUE | CANCELLED
--     OVERDUE -> PAID | CANCELLED
--     PAID, CANCELLED: terminal. DELETE nur für DRAFT.
--   Stabiler Fehlertext-Marker für das App-Mapping: 'Festschreibung'
--   (Vertrag wie der 'GwG-Schranke'-Marker, init/iter5).
-- =============================================================================

-- Teil 1: Nummernkreis ---------------------------------------------------------

CREATE TABLE "invoice_number_seq" (
    "tenant_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "last_no" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "invoice_number_seq_pkey" PRIMARY KEY ("tenant_id", "year"),
    CONSTRAINT "invoice_number_seq_tenant_id_fkey" FOREIGN KEY ("tenant_id")
        REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

ALTER TABLE "invoice_number_seq" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invoice_number_seq" FORCE ROW LEVEL SECURITY;

CREATE POLICY invoice_number_seq_isolation ON "invoice_number_seq"
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());

-- Kein DELETE-Grant: Sequenzzeilen werden nie app-seitig entfernt (Tenant-
-- Cascade läuft über den Owner).
GRANT SELECT, INSERT, UPDATE ON "invoice_number_seq" TO taxtronik_app;

-- Teil 2 + 3: Festschreibung, Übergangs-Matrix, Löschschutz ---------------------

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
            OR NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
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

CREATE TRIGGER invoice_protect_update
    BEFORE UPDATE ON "invoice"
    FOR EACH ROW EXECUTE FUNCTION app.invoice_protect_update();

CREATE OR REPLACE FUNCTION app.invoice_protect_delete() RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status <> 'DRAFT' THEN
        RAISE EXCEPTION 'Festschreibung: Rechnung % darf nicht gelöscht werden (Aufbewahrungspflicht).', OLD.number
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER invoice_protect_delete
    BEFORE DELETE ON "invoice"
    FOR EACH ROW EXECUTE FUNCTION app.invoice_protect_delete();

-- Positionen: nach Festschreibung weder änderbar noch lösch-/erweiterbar.
-- Beim CASCADE-Delete einer DRAFT-Rechnung ist die Eltern-Zeile bereits weg
-- (SELECT liefert NULL) → erlaubt; bei nicht-DRAFT blockiert schon der
-- invoice_protect_delete-Trigger davor.
CREATE OR REPLACE FUNCTION app.invoice_position_protect() RETURNS TRIGGER AS $$
DECLARE
    inv_status "invoice_status";
BEGIN
    SELECT status INTO inv_status FROM "invoice"
        WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id);
    IF inv_status IS NOT NULL AND inv_status <> 'DRAFT' THEN
        RAISE EXCEPTION 'Festschreibung: Positionen einer versendeten Rechnung sind unveränderlich.'
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER invoice_position_protect
    BEFORE INSERT OR UPDATE OR DELETE ON "invoice_position"
    FOR EACH ROW EXECUTE FUNCTION app.invoice_position_protect();
