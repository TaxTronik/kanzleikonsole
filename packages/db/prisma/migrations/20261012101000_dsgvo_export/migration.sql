-- DSGVO-CONTACT-EXPORT-001, DSGVO-REQUEST-EVIDENCE-001.
--
-- Folgepunkt P-11 (Welle 15): DSGVO-Auskunft bei grossem Bestand im Worker.
--
-- Die Erzeugung des Kontaktpakets (Art. 15/20) lief bisher in einer
-- 15-s-Transaktion des Webprozesses und wuchs linear mit dem Audit-Log.
-- dsgvo_export haelt jeden Auftrag an den Worker dsgvo-export: angefordert
-- (REQUESTED), laeuft (RUNNING), fertig (DONE) oder fehlgeschlagen (FAILED).
-- Ein fertiger Auftrag bindet das Ergebnis im Object Store (Bucket, Schluessel,
-- Objektversion) mit SHA-256 und Groesse; der Download prueft beides. Der
-- Ziel-Schluessel steht vor dem Schreiben im Auftrag (Nachvollziehbarkeit bei
-- Abbruch). object_deleted_at vermerkt das Loeschen ueberholter Pakete.
--
-- Integritaet: Ein Guard verlangt beim Anlegen einen offenen ACCESS- oder
-- PORTABILITY-Antrag desselben Tenants ueber genau diesen Kontakt; Identitaet
-- und ein abgeschlossenes Ergebnis sind unveraenderlich, der Status laeuft nur
-- vorwaerts. Hoechstens ein aktiver Auftrag je Antrag (partieller Unique-Index).
-- RLS wie die Nachbartabellen (ENABLE + FORCE, Isolation-Policy). Die App-Rolle
-- legt Auftraege an und schreibt als Worker im SYSTEM-Kontext den Status; sie
-- loescht nichts. Fristen nach Art. 12 Abs. 3 DSGVO (dsgvo_request.due_date)
-- bleiben unberuehrt.
--
-- Erzeugt mit `pnpm db:sql:migration` aus packages/db/prisma/sql
-- (docs/development/kanonische-sql-quellen.md):
--   neu:      functions/app.guard_dsgvo_export().sql
--   neu:      policies/dsgvo_export.dsgvo_export_isolation.sql
--   neu:      triggers/dsgvo_export.dsgvo_export_guard.sql
BEGIN;

CREATE TYPE public."dsgvo_export_status" AS ENUM ('REQUESTED', 'RUNNING', 'DONE', 'FAILED');

CREATE TABLE public."dsgvo_export" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "request_id" UUID NOT NULL,
  "contact_id" UUID NOT NULL,
  "status" public."dsgvo_export_status" NOT NULL DEFAULT 'REQUESTED',
  "requested_by" UUID NOT NULL,
  "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at" TIMESTAMPTZ(6),
  "finished_at" TIMESTAMPTZ(6),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "error" TEXT,
  "storage_bucket" TEXT,
  "storage_key" TEXT,
  "storage_version_id" TEXT,
  "sha256" BYTEA,
  "size_bytes" BIGINT,
  "object_deleted_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "dsgvo_export_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "dsgvo_export_attempts_check" CHECK ("attempts" >= 0),
  CONSTRAINT "dsgvo_export_sha256_check" CHECK ("sha256" IS NULL OR octet_length("sha256") = 32),
  CONSTRAINT "dsgvo_export_running_check" CHECK ("status" <> 'RUNNING' OR "started_at" IS NOT NULL),
  CONSTRAINT "dsgvo_export_done_check" CHECK (
    "status" <> 'DONE' OR (
      "sha256" IS NOT NULL AND "size_bytes" IS NOT NULL AND "size_bytes" >= 0
      AND "storage_bucket" IS NOT NULL AND "storage_key" IS NOT NULL
      AND "finished_at" IS NOT NULL AND "error" IS NULL
    )
  ),
  CONSTRAINT "dsgvo_export_failed_check" CHECK (
    "status" <> 'FAILED' OR ("error" IS NOT NULL AND "finished_at" IS NOT NULL)
  ),
  CONSTRAINT "dsgvo_export_error_check" CHECK ("error" IS NULL OR length("error") <= 2000)
);

ALTER TABLE public."dsgvo_export" ADD CONSTRAINT "dsgvo_export_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES public."tenant"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE public."dsgvo_export" ADD CONSTRAINT "dsgvo_export_request_id_fkey"
  FOREIGN KEY ("request_id") REFERENCES public."dsgvo_request"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- Letzter Auftrag eines Antrags (Detailseite, Download); traegt den FK request_id.
CREATE INDEX "dsgvo_export_request_id_requested_at_idx"
  ON public."dsgvo_export"("request_id", "requested_at");
-- Tenant-FK und offene Auftraege eines Tenants.
CREATE INDEX "dsgvo_export_tenant_id_status_idx"
  ON public."dsgvo_export"("tenant_id", "status");
-- Hoechstens ein angeforderter oder laufender Auftrag je Antrag.
CREATE UNIQUE INDEX "dsgvo_export_one_active"
  ON public."dsgvo_export"("request_id") WHERE "status" IN ('REQUESTED', 'RUNNING');

ALTER TABLE public."dsgvo_export" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."dsgvo_export" FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION app.guard_dsgvo_export()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app'
AS $function$
BEGIN
  -- DSGVO-CONTACT-EXPORT-001 (Welle 15, P-11): Auftrag der Worker-Erzeugung
  -- eines Kontaktpakets. Er gehört zu genau einem offenen Auskunfts- oder
  -- Portabilitätsantrag desselben Tenants über diesen Kontakt; Identität und
  -- ein fertiges Ergebnis sind unveränderlich, der Status läuft nur vorwärts.
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'REQUESTED' OR NOT EXISTS (
      SELECT 1
        FROM public.dsgvo_request r
       WHERE r.id = NEW.request_id
         AND r.tenant_id = NEW.tenant_id
         AND r.subject_type = 'CLIENT_CONTACT'
         AND r.subject_ref_id = NEW.contact_id
         AND r.type IN ('ACCESS', 'PORTABILITY')
         AND r.status IN ('RECEIVED', 'IN_PROGRESS')
    ) THEN
      RAISE EXCEPTION 'dsgvo_export: kein offener Auskunftsantrag dieses Tenants für den Kontakt'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW.id, NEW.tenant_id, NEW.request_id, NEW.contact_id, NEW.requested_by, NEW.requested_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.request_id, OLD.contact_id, OLD.requested_by, OLD.requested_at) THEN
    RAISE EXCEPTION 'dsgvo_export: Auftragsidentität ist unveränderlich'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT (
    (OLD.status = 'REQUESTED' AND NEW.status IN ('REQUESTED', 'RUNNING', 'FAILED'))
    OR (OLD.status = 'RUNNING' AND NEW.status IN ('RUNNING', 'DONE', 'FAILED'))
    OR (OLD.status IN ('DONE', 'FAILED') AND NEW.status = OLD.status)
  ) THEN
    RAISE EXCEPTION 'dsgvo_export: unzulässiger Statuswechsel % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('DONE', 'FAILED')
     AND (NEW.sha256, NEW.size_bytes, NEW.storage_bucket, NEW.storage_key,
          NEW.storage_version_id, NEW.finished_at, NEW.error)
         IS DISTINCT FROM
         (OLD.sha256, OLD.size_bytes, OLD.storage_bucket, OLD.storage_key,
          OLD.storage_version_id, OLD.finished_at, OLD.error) THEN
    RAISE EXCEPTION 'dsgvo_export: abgeschlossener Auftrag ist unveränderlich'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER dsgvo_export_guard BEFORE INSERT OR UPDATE ON public.dsgvo_export FOR EACH ROW EXECUTE FUNCTION app.guard_dsgvo_export();

CREATE POLICY dsgvo_export_isolation ON public.dsgvo_export
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((tenant_id = app.current_tenant_id()))
  WITH CHECK ((tenant_id = app.current_tenant_id()));

-- Die Default-Privilegien geben der App-Rolle auch DELETE; Auftraege bleiben
-- als Nachweis erhalten (geloescht wird nur mit dem Antrag, per FK).
REVOKE ALL ON public."dsgvo_export" FROM PUBLIC, taxtronik_app;
GRANT SELECT, INSERT, UPDATE ON public."dsgvo_export" TO taxtronik_app;

COMMIT;
