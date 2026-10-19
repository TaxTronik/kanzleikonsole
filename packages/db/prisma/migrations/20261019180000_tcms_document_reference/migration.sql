-- TCMS-NACHWEIS-001.
--
-- TCMS Stufe 3 (Bereich C): Nachweise einer Kontrolldurchführung im Tax-CMS
-- sind Verweise auf Dokumente der kanzleikonsole (Dokument-ID, SHA-256). Damit
-- ein Dokument, auf das ein Nachweis verweist, nicht still gelöscht wird,
-- hält tcms_document_reference die Verknüpfung: Mandant, Dokument, genau die
-- verwiesene Version mit ihrem SHA-256, die Durchführung und (sobald das
-- Tax-CMS den Nachweis angenommen hat) die Nachweis-ID. Offen ist eine
-- Verknüpfung, solange released_at NULL ist.
--
-- Integrität: Der Guard lässt beim Anlegen nur die neueste, sauber gescannte
-- Version eines nicht gelöschten Dokuments desselben Tenants und Mandanten
-- mit genau diesem SHA-256 zu, ohne GwG-, Personal- oder Lohnbezug; er sperrt
-- die Dokumentzeile geteilt (serialisiert mit dem Soft-Delete). Bezug und
-- Inhalt sind danach unveränderlich, die Nachweis-ID wird höchstens einmal
-- gesetzt, eine Freigabe (Nachweis entfernt bzw. nicht angehängt) ist
-- endgültig. document_tcms_reference_delete_guard weist jedes Soft-Delete
-- eines Dokuments mit offener Verknüpfung ab (Rückfallebene für jeden Pfad;
-- die Ablage prüft vorher selbst). Fremdschlüssel auf Dokument und Version
-- ohne Kaskade verhindern hartes Löschen.
-- RLS wie die Nachbartabellen (ENABLE + FORCE, Isolation-Policy); die
-- App-Rolle legt an und ändert, löscht aber nichts.
--
-- Erzeugt mit `pnpm db:sql:migration` aus packages/db/prisma/sql
-- (docs/development/kanonische-sql-quellen.md):
--   neu:      functions/app.guard_tcms_document_reference().sql
--   neu:      functions/app.guard_tcms_referenced_document().sql
--   neu:      policies/tcms_document_reference.tcms_document_reference_isolation.sql
--   neu:      triggers/document.document_tcms_reference_delete_guard.sql
--   neu:      triggers/tcms_document_reference.00_tenant_client_pair_integrity.sql
--   neu:      triggers/tcms_document_reference.tcms_document_reference_guard.sql
BEGIN;

CREATE TABLE public."tcms_document_reference" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "client_id" UUID NOT NULL,
  "document_id" UUID NOT NULL,
  "document_version_id" UUID NOT NULL,
  "sha256" BYTEA NOT NULL,
  "tcms_execution_id" TEXT NOT NULL,
  "tcms_evidence_id" TEXT,
  "created_by" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "released_at" TIMESTAMPTZ(6),
  "released_by" UUID,
  "release_reason" TEXT,

  CONSTRAINT "tcms_document_reference_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tcms_document_reference_sha256_check" CHECK (octet_length("sha256") = 32),
  CONSTRAINT "tcms_document_reference_execution_id_check"
    CHECK ("tcms_execution_id" ~ '^[a-z0-9]{1,64}$'),
  CONSTRAINT "tcms_document_reference_evidence_id_check"
    CHECK ("tcms_evidence_id" IS NULL OR "tcms_evidence_id" ~ '^[a-z0-9]{1,64}$'),
  CONSTRAINT "tcms_document_reference_release_check" CHECK (
    ("released_at" IS NULL AND "released_by" IS NULL AND "release_reason" IS NULL)
    OR ("released_at" IS NOT NULL AND "released_by" IS NOT NULL
        AND "release_reason" IN ('REMOVED', 'NOT_ATTACHED'))
  )
);

ALTER TABLE public."tcms_document_reference" ADD CONSTRAINT "tcms_document_reference_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES public."tenant"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE public."tcms_document_reference" ADD CONSTRAINT "tcms_document_reference_client_id_fkey"
  FOREIGN KEY ("client_id") REFERENCES public."client"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE public."tcms_document_reference" ADD CONSTRAINT "tcms_document_reference_document_id_fkey"
  FOREIGN KEY ("document_id") REFERENCES public."document"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE public."tcms_document_reference" ADD CONSTRAINT "tcms_document_reference_document_version_id_fkey"
  FOREIGN KEY ("document_version_id") REFERENCES public."document_version"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Löschsperre: offene Verknüpfungen eines Dokuments (trägt den Tenant-FK).
CREATE INDEX "tcms_document_reference_tenant_id_document_id_idx"
  ON public."tcms_document_reference"("tenant_id", "document_id");
-- Verknüpfungen einer Durchführung (Anzeige, Freigabe); trägt den Mandanten-FK.
CREATE INDEX "tcms_document_reference_client_id_tcms_execution_id_idx"
  ON public."tcms_document_reference"("client_id", "tcms_execution_id");
CREATE INDEX "tcms_document_reference_document_version_id_idx"
  ON public."tcms_document_reference"("document_version_id");
-- Höchstens eine offene Verknüpfung je Nachweis des Tax-CMS.
CREATE UNIQUE INDEX "tcms_document_reference_open_evidence"
  ON public."tcms_document_reference"("tenant_id", "tcms_evidence_id")
  WHERE "released_at" IS NULL AND "tcms_evidence_id" IS NOT NULL;

ALTER TABLE public."tcms_document_reference" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."tcms_document_reference" FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION app.guard_tcms_document_reference()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
DECLARE
  neueste RECORD;
BEGIN
  -- TCMS-NACHWEIS-001 (TCMS Stufe 3): Verweis eines Tax-CMS-Nachweises auf ein
  -- Dokument der kanzleikonsole. Angelegt wird er nur für die neueste, sauber
  -- finalisierte Version eines nicht gelöschten Dokuments genau dieses
  -- Mandanten mit genau diesem SHA-256 und ohne GwG-, Personal- oder
  -- Lohnbezug. Danach sind Bezug und Inhalt unveränderlich; die Nachweis-ID
  -- des Tax-CMS wird höchstens einmal gesetzt, die Freigabe ist endgültig.
  IF TG_OP = 'INSERT' THEN
    IF NEW.released_at IS NOT NULL OR NEW.released_by IS NOT NULL
       OR NEW.release_reason IS NOT NULL THEN
      RAISE EXCEPTION 'tcms_document_reference: ein neuer Verweis ist nicht freigegeben'
        USING ERRCODE = 'check_violation';
    END IF;
    -- Die Dokumentzeile wird geteilt gesperrt: Ein paralleles Soft-Delete
    -- (FOR UPDATE der Löschaktion) wartet bzw. lässt diesen Insert scheitern.
    PERFORM 1
       FROM public.document d
      WHERE d.id = NEW.document_id
        AND d.tenant_id = NEW.tenant_id
        AND d.client_id = NEW.client_id
        AND d.deleted_at IS NULL
        AND d.gwg_destroyed_at IS NULL
        AND d.gwg_onboarding_invite_id IS NULL
        AND d.form_submission_id IS NULL
        AND d.requires_payroll_access = FALSE
        AND d.classification NOT IN ('GWG_EVIDENCE', 'PERSONNEL', 'STAFF_PRIVATE')
        FOR SHARE OF d;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'tcms_document_reference: Dokument dieses Mandanten nicht verfügbar'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT v.id, v.sha256, v.scan_status, v.scan_completed_at
      INTO neueste
      FROM public.document_version v
     WHERE v.document_id = NEW.document_id
     ORDER BY v.version_no DESC
     LIMIT 1;
    IF NOT FOUND
       OR neueste.id IS DISTINCT FROM NEW.document_version_id
       OR neueste.sha256 IS DISTINCT FROM NEW.sha256
       OR neueste.scan_status IS DISTINCT FROM 'CLEAN'
       OR neueste.scan_completed_at IS NULL THEN
      RAISE EXCEPTION 'tcms_document_reference: nur die neueste, saubere Version mit diesem SHA-256'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW.id, NEW.tenant_id, NEW.client_id, NEW.document_id, NEW.document_version_id,
      NEW.sha256, NEW.tcms_execution_id, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.client_id, OLD.document_id, OLD.document_version_id,
      OLD.sha256, OLD.tcms_execution_id, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'tcms_document_reference: Bezug und Inhalt sind unveränderlich'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.tcms_evidence_id IS DISTINCT FROM OLD.tcms_evidence_id
     AND (OLD.tcms_evidence_id IS NOT NULL OR OLD.released_at IS NOT NULL) THEN
    RAISE EXCEPTION 'tcms_document_reference: die Nachweis-ID wird nur einmal gesetzt'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.released_at IS NOT NULL
     AND (NEW.released_at, NEW.released_by, NEW.release_reason)
         IS DISTINCT FROM (OLD.released_at, OLD.released_by, OLD.release_reason) THEN
    RAISE EXCEPTION 'tcms_document_reference: eine Freigabe ist endgültig'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION app.guard_tcms_referenced_document()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
BEGIN
  -- TCMS-NACHWEIS-001 (TCMS Stufe 3): Ein Dokument, auf das ein offener
  -- Nachweis-Verweis des Tax-CMS zeigt, wird auf keinem Pfad still gelöscht
  -- (Soft-Delete). Die Löschaktion der Dokumentablage prüft vorher selbst und
  -- nennt den Grund; dieser Trigger ist die Rückfallebene für jeden Pfad.
  IF EXISTS (
    SELECT 1
      FROM public.tcms_document_reference r
     WHERE r.document_id = OLD.id
       AND r.tenant_id = OLD.tenant_id
       AND r.released_at IS NULL
  ) THEN
    RAISE EXCEPTION 'document: als Nachweis im Tax-CMS verknüpft, Löschen gesperrt'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER document_tcms_reference_delete_guard BEFORE UPDATE OF deleted_at ON public.document FOR EACH ROW WHEN (((old.deleted_at IS NULL) AND (new.deleted_at IS NOT NULL))) EXECUTE FUNCTION app.guard_tcms_referenced_document();

CREATE TRIGGER "00_tenant_client_pair_integrity" BEFORE INSERT OR UPDATE OF tenant_id, client_id ON public.tcms_document_reference FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant_client_pair_integrity();

CREATE TRIGGER tcms_document_reference_guard BEFORE INSERT OR UPDATE ON public.tcms_document_reference FOR EACH ROW EXECUTE FUNCTION app.guard_tcms_document_reference();

CREATE POLICY tcms_document_reference_isolation ON public.tcms_document_reference
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((tenant_id = app.current_tenant_id()))
  WITH CHECK ((tenant_id = app.current_tenant_id()));

-- Die Default-Privilegien geben der App-Rolle auch DELETE; Verknüpfungen
-- bleiben als Nachweis erhalten und werden nur freigegeben.
REVOKE ALL ON public."tcms_document_reference" FROM PUBLIC, taxtronik_app;
GRANT SELECT, INSERT, UPDATE ON public."tcms_document_reference" TO taxtronik_app;

COMMIT;
