-- Die separate XRechnung-XML braucht eine echte Provenienzbeziehung zur
-- Rechnung. Eine Suche nach (Mandant, Titel, MIME) konnte ein gleichnamiges
-- fremdes GOBD-XML als kanonisch behandeln oder beim DRAFT-Cleanup ausblenden.

ALTER TABLE "invoice"
  ADD COLUMN "xrechnung_document_id" UUID;

ALTER TABLE "invoice"
  ADD CONSTRAINT "invoice_xrechnung_document_fkey"
  FOREIGN KEY ("xrechnung_document_id") REFERENCES "document"("id")
  ON DELETE SET NULL ON UPDATE NO ACTION;

CREATE UNIQUE INDEX "invoice_xrechnung_document_unique"
  ON "invoice" ("xrechnung_document_id");

-- Kein titelbasierter Legacy-Backfill: Titel und MIME sind fachliche
-- Metadaten, aber kein belastbarer Herkunftsnachweis. Bestehende Zeilen bleiben
-- NULL. Beim ersten kanonischen Zugriff wird die XML entweder gemeinsam mit
-- der PDF erzeugt oder bytegenau aus factur-x.xml der bereits verknuepften
-- Hybrid-PDF extrahiert und danach hier fest verknuepft.

CREATE OR REPLACE FUNCTION app.enforce_invoice_xrechnung_document_scope()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app, pg_temp
AS $$
DECLARE
  v_document_tenant UUID;
  v_document_client UUID;
  v_classification public.document_classification;
  v_mime_type TEXT;
  v_deleted_at TIMESTAMPTZ;
BEGIN
  IF NEW."xrechnung_document_id" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT d."tenant_id", d."client_id", d."classification", d."mime_type", d."deleted_at"
    INTO v_document_tenant,
         v_document_client,
         v_classification,
         v_mime_type,
         v_deleted_at
    FROM public."document" d
   WHERE d."id" = NEW."xrechnung_document_id"
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'XRechnung-Dokument ist nicht vorhanden.'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_document_tenant IS DISTINCT FROM NEW."tenant_id"
     OR v_document_client IS DISTINCT FROM NEW."client_id"
     OR v_classification IS DISTINCT FROM 'GOBD_INVOICE'::public.document_classification
     OR v_mime_type IS DISTINCT FROM 'application/xml'
     OR v_deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'XRechnung-Dokument verletzt Tenant-, Mandanten- oder Archivgrenze.'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION app.enforce_invoice_xrechnung_document_scope()
  OWNER TO CURRENT_USER;
REVOKE ALL ON FUNCTION app.enforce_invoice_xrechnung_document_scope() FROM PUBLIC;

CREATE TRIGGER "invoice_xrechnung_document_scope"
BEFORE INSERT OR UPDATE OF
  "tenant_id", "client_id", "xrechnung_document_id"
ON public."invoice"
FOR EACH ROW EXECUTE FUNCTION app.enforce_invoice_xrechnung_document_scope();

-- Die Pruefung auf der Invoice allein reicht nicht: Ohne reziproken Guard
-- koennte ein spaeteres UPDATE des bereits verknuepften Dokuments den Tenant,
-- Mandanten, MIME-Typ, die Klassifikation oder den Loeschstatus veraendern.
-- SECURITY DEFINER ist hier notwendig, weil die Sicherheitsentscheidung auch
-- unter einer durch RLS eingeschraenkten App-Rolle alle referenzierenden
-- Rechnungen sehen muss. Das Invoice-Linking nimmt oben einen FOR-SHARE-Lock
-- auf dem Dokument; dadurch serialisieren Link und Dokumentaenderung sauber.
CREATE OR REPLACE FUNCTION app.enforce_xrechnung_document_invoice_scope()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app, pg_temp
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public."invoice" i
     WHERE i."xrechnung_document_id" = OLD."id"
       AND (
         NEW."tenant_id" IS DISTINCT FROM i."tenant_id"
         OR NEW."client_id" IS DISTINCT FROM i."client_id"
         OR NEW."classification" IS DISTINCT FROM
              'GOBD_INVOICE'::public.document_classification
         OR NEW."mime_type" IS DISTINCT FROM 'application/xml'
         OR NEW."deleted_at" IS NOT NULL
       )
  ) THEN
    RAISE EXCEPTION 'Referenziertes XRechnung-Dokument darf seine Archivgrenze nicht verlassen.'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION app.enforce_xrechnung_document_invoice_scope()
  OWNER TO CURRENT_USER;
REVOKE ALL ON FUNCTION app.enforce_xrechnung_document_invoice_scope() FROM PUBLIC;

CREATE TRIGGER "xrechnung_document_invoice_scope"
BEFORE UPDATE OF
  "tenant_id", "client_id", "classification", "mime_type", "deleted_at"
ON public."document"
FOR EACH ROW EXECUTE FUNCTION app.enforce_xrechnung_document_invoice_scope();
