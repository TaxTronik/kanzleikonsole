-- TCMS-NACHWEIS-001.
--
-- kk-tcms-s10nach, Punkt 3: Idempotente Portal-Meldung (TCMS s10).
--
-- Anlass: Blieb der Ausgang einer Ereignismeldung aus dem Portal offen
-- (Zeitlimit, Transport, 5xx, unlesbare Antwort), blieben ihre Anlagen ohne
-- Ereignis-ID gebunden, bis jemand sie in der Datenbank klärte; eine
-- Wiederholung hätte ein zweites Ereignis angelegt. Seit TCMS s10 nimmt der
-- Dienst je Person, Mandant und Idempotenzschlüssel innerhalb von 24 h genau
-- eine Meldung an und liefert bei Wiederholung mit gleichem Inhalt dasselbe
-- Ereignis.
--
-- Änderung:
--   - tcms_document_reference.tcms_report_key: Schlüssel des Meldevorgangs an
--     jeder Anlage (nur EVENT, CHECK tcms_document_reference_report_key_check),
--     ab der Anlage unveränderlich (Guard). Bestehende Zeilen bleiben NULL
--     (Altbestand ohne Schlüssel: ungeklärt, wenn offen ohne Ereignis-ID).
--   - tcms_portal_report: ein Meldevorgang je Absenden (Kontakt, Mandant,
--     Schlüssel). Vor dem Ablegen der Anlagen angelegt (noch nicht gesendet,
--     mit Lease), unmittelbar vor dem ersten Senden mit Sendezeitpunkt und dem
--     zur Wiederholung nötigen Inhalt – nur verschlüsselt (Secret-Box v3, an
--     Tenant, Zeile und Spalte gebunden; CHECK auf das Format, nie Klartext).
--     Nach der Klärung (angenommen: Ereignis-ID an den Anlagen; eindeutig
--     abgelehnt: Anlagen frei) löscht die Anwendung die Zeile samt Inhalt
--     sofort; nach Ablauf des Wiederholungsfensters löscht sie der Worker,
--     die Anlagen bleiben dann gebunden („ungeklärte Anlage“, nie frei).
--   - RLS wie die Nachbartabellen (ENABLE + FORCE, Isolation-Policy),
--     Paarprüfung Tenant/Mandant, Guard (Anlage noch nicht gesendet, Kontakt
--     dieses Mandanten; Bezug, Schlüssel und Anlage unveränderlich,
--     Sendezeitpunkt genau einmal). Eindeutig je Tenant, Kontakt und
--     Schlüssel. Die App-Rolle liest, legt an, ändert und löscht; TRUNCATE,
--     REFERENCES und TRIGGER hat sie nicht (Restore-Invariante).
--
-- Erzeugt mit `pnpm db:sql:migration` aus packages/db/prisma/sql
-- (docs/development/kanonische-sql-quellen.md):
--   geändert: functions/app.guard_tcms_document_reference().sql
--   neu:      functions/app.guard_tcms_portal_report().sql
--   neu:      policies/tcms_portal_report.tcms_portal_report_isolation.sql
--   neu:      triggers/tcms_portal_report.00_tenant_client_pair_integrity.sql
--   neu:      triggers/tcms_portal_report.tcms_portal_report_guard.sql
BEGIN;

ALTER TABLE public."tcms_document_reference"
  ADD COLUMN "tcms_report_key" UUID,
  ADD CONSTRAINT "tcms_document_reference_report_key_check"
    CHECK ("tcms_report_key" IS NULL OR "tcms_subject" = 'EVENT');

-- Anlagen eines Meldevorgangs (Zuordnen, Freigeben, ungeklärte Anlagen).
CREATE INDEX "tcms_document_reference_tenant_id_tcms_report_key_idx"
  ON public."tcms_document_reference"("tenant_id", "tcms_report_key");

CREATE TABLE public."tcms_portal_report" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "client_id" UUID NOT NULL,
  "contact_id" UUID NOT NULL,
  "idempotency_key" UUID NOT NULL,
  "payload_enc" TEXT,
  "sent_at" TIMESTAMPTZ(6),
  "lease_until" TIMESTAMPTZ(6),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "last_attempt_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "tcms_portal_report_pkey" PRIMARY KEY ("id"),
  -- Gesendet genau dann, wenn der Inhalt zur Wiederholung vorliegt (NULL-sicher).
  CONSTRAINT "tcms_portal_report_sent_check"
    CHECK (("payload_enc" IS NULL) = ("sent_at" IS NULL)),
  -- Inhalt nur als Secret-Box-v3-Wert (v3:<kid>:<iv>:<tag>:<ct>), nie Klartext.
  CONSTRAINT "tcms_portal_report_payload_check"
    CHECK ("payload_enc" IS NULL
      OR ("payload_enc" ~ '^v3:[0-9a-f]{16}:[A-Za-z0-9+/]{16}:[A-Za-z0-9+/]{22}==:[A-Za-z0-9+/]+={0,2}$'
          AND octet_length("payload_enc") <= 65536)),
  CONSTRAINT "tcms_portal_report_attempts_check" CHECK ("attempts" >= 0)
);

ALTER TABLE public."tcms_portal_report" ADD CONSTRAINT "tcms_portal_report_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES public."tenant"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE public."tcms_portal_report" ADD CONSTRAINT "tcms_portal_report_client_id_fkey"
  FOREIGN KEY ("client_id") REFERENCES public."client"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
-- Der Schlüssel gilt im Tax-CMS nur für diese Person; ohne sie ist keine
-- Wiederholung möglich, der Inhalt entfällt mit ihr.
ALTER TABLE public."tcms_portal_report" ADD CONSTRAINT "tcms_portal_report_contact_id_fkey"
  FOREIGN KEY ("contact_id") REFERENCES public."client_contact"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- Ein Meldevorgang je Tenant, Kontakt und Schlüssel (trägt den Tenant-FK).
CREATE UNIQUE INDEX "tcms_portal_report_tenant_id_contact_id_idempotency_key_key"
  ON public."tcms_portal_report"("tenant_id", "contact_id", "idempotency_key");
-- Offene Vorgänge eines Kontakts beim Mandanten (trägt den Mandanten-FK).
CREATE INDEX "tcms_portal_report_client_id_contact_id_idx"
  ON public."tcms_portal_report"("client_id", "contact_id");
CREATE INDEX "tcms_portal_report_contact_id_idx"
  ON public."tcms_portal_report"("contact_id");
-- Bereinigung nach Ablauf des Fensters (Worker).
CREATE INDEX "tcms_portal_report_sent_at_idx"
  ON public."tcms_portal_report"("sent_at");

ALTER TABLE public."tcms_portal_report" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."tcms_portal_report" FORCE ROW LEVEL SECURITY;

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
  -- TCMS s7 (Integration): Anlagen einer Ereignismeldung aus dem Portal
  -- (tcms_subject = 'EVENT') binden das Dokument ebenso. Die Ereignis-ID
  -- vergibt das Tax-CMS erst mit der Meldung; sie wird höchstens einmal
  -- gesetzt, der Bezug (Durchführung oder Ereignis) nie geändert.
  -- kk-tcms-s10nach: Der Idempotenzschlüssel der Meldung (tcms_report_key,
  -- nur EVENT) verbindet die Anlagen mit ihrem Meldevorgang
  -- (tcms_portal_report); er steht ab der Anlage fest.
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
      NEW.sha256, NEW.tcms_subject, NEW.tcms_execution_id, NEW.tcms_report_key,
      NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.client_id, OLD.document_id, OLD.document_version_id,
      OLD.sha256, OLD.tcms_subject, OLD.tcms_execution_id, OLD.tcms_report_key,
      OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'tcms_document_reference: Bezug und Inhalt sind unveränderlich'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.tcms_evidence_id IS DISTINCT FROM OLD.tcms_evidence_id
     AND (OLD.tcms_evidence_id IS NOT NULL OR OLD.released_at IS NOT NULL) THEN
    RAISE EXCEPTION 'tcms_document_reference: die Nachweis-ID wird nur einmal gesetzt'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.tcms_event_id IS DISTINCT FROM OLD.tcms_event_id
     AND (OLD.tcms_event_id IS NOT NULL OR OLD.released_at IS NOT NULL) THEN
    RAISE EXCEPTION 'tcms_document_reference: die Ereignis-ID wird nur einmal gesetzt'
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

CREATE OR REPLACE FUNCTION app.guard_tcms_portal_report()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
BEGIN
  -- TCMS-NACHWEIS-001 (kk-tcms-s10nach): Meldevorgang einer Ereignismeldung
  -- aus dem Portal mit Idempotenzschlüssel (TCMS s10). Eine Zeile entsteht vor
  -- dem Ablegen der Anlagen (noch nicht gesendet); unmittelbar vor dem ersten
  -- Senden kommen Sendezeitpunkt und der verschlüsselte Inhalt dazu (CHECK:
  -- beides oder keines, nur im Format der Secret-Box). Kontakt, Mandant,
  -- Schlüssel und Anlage sind unveränderlich, der Sendezeitpunkt wird genau
  -- einmal gesetzt. Gelöscht wird die Zeile nach der Klärung (angenommen,
  -- eindeutig abgelehnt) bzw. nach Ablauf des Wiederholungsfensters.
  IF TG_OP = 'INSERT' THEN
    IF NEW.sent_at IS NOT NULL OR NEW.payload_enc IS NOT NULL
       OR NEW.attempts <> 0 OR NEW.last_attempt_at IS NOT NULL THEN
      RAISE EXCEPTION 'tcms_portal_report: ein neuer Meldevorgang ist noch nicht gesendet'
        USING ERRCODE = 'check_violation';
    END IF;
    PERFORM 1
       FROM public.client_contact c
      WHERE c.id = NEW.contact_id
        AND c.tenant_id = NEW.tenant_id
        AND c.client_id = NEW.client_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'tcms_portal_report: Kontakt gehört nicht zu diesem Mandanten'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW.id, NEW.tenant_id, NEW.client_id, NEW.contact_id, NEW.idempotency_key, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.client_id, OLD.contact_id, OLD.idempotency_key, OLD.created_at) THEN
    RAISE EXCEPTION 'tcms_portal_report: Bezug und Schlüssel sind unveränderlich'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.sent_at IS NOT NULL AND NEW.sent_at IS DISTINCT FROM OLD.sent_at THEN
    RAISE EXCEPTION 'tcms_portal_report: der Sendezeitpunkt wird nur einmal gesetzt'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER "00_tenant_client_pair_integrity" BEFORE INSERT OR UPDATE OF tenant_id, client_id ON public.tcms_portal_report FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant_client_pair_integrity();

CREATE TRIGGER tcms_portal_report_guard BEFORE INSERT OR UPDATE ON public.tcms_portal_report FOR EACH ROW EXECUTE FUNCTION app.guard_tcms_portal_report();

CREATE POLICY tcms_portal_report_isolation ON public.tcms_portal_report
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((tenant_id = app.current_tenant_id()))
  WITH CHECK ((tenant_id = app.current_tenant_id()));

-- Die Default-Privilegien geben der App-Rolle mehr als nötig.
REVOKE ALL ON public."tcms_portal_report" FROM PUBLIC, taxtronik_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public."tcms_portal_report" TO taxtronik_app;

COMMIT;
