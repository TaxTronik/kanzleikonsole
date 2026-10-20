-- TCMS-NACHWEIS-001.
--
-- Härtungshinweis aus kk-tcms-int4 (offener Punkt 1): Ein im Tax-CMS
-- gebundenes Dokument konnte auf Datenbankebene den Mandanten wechseln. Als
-- Owner-Rolle gingen `UPDATE document SET client_id = <anderer Mandant>` und
-- `= NULL` durch; document_tcms_reference_scope_guard deckte client_id und
-- tenant_id nicht ab. Der Verweis des Tax-CMS hätte danach still auf ein
-- Dokument eines anderen Mandanten (bzw. auf ein Kanzleidokument) gezeigt.
-- Kein Anwendungspfad ändert diese Spalten.
--
-- Änderung: Der Trigger feuert zusätzlich bei UPDATE OF client_id, tenant_id
-- (WHEN: Wert geändert); die Funktion weist den Wechsel bei offener
-- Verknüpfung für jede Rolle ab (restrict_violation, Marker „als Nachweis im
-- Tax-CMS verknüpft“, Meldung „Mandantenwechsel gesperrt“;
-- database-error.ts ordnet das als TCMS_EVIDENCE_LOCKED ein). Die übrigen
-- Wechsel (GwG-, Personal-, private Unterlage, Lohn-, Onboarding- und
-- Formularbezug) bleiben mit der bisherigen Meldung gesperrt. Nach der
-- Freigabe der Verknüpfung gilt die Sperre nicht mehr.
-- Daten, RLS und Rechte bleiben unverändert.
--
-- Erzeugt mit `pnpm db:sql:migration` aus packages/db/prisma/sql
-- (docs/development/kanonische-sql-quellen.md):
--   geändert: functions/app.guard_tcms_referenced_document_scope().sql
--   geändert: triggers/document.document_tcms_reference_scope_guard.sql
BEGIN;

DROP TRIGGER document_tcms_reference_scope_guard ON public.document;

CREATE OR REPLACE FUNCTION app.guard_tcms_referenced_document_scope()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
BEGIN
  -- TCMS-NACHWEIS-001 (RT3B-K-01): Ein Dokument, auf das ein offener Verweis
  -- des Tax-CMS zeigt, bleibt in dem Rahmen, in dem es verknüpft werden durfte
  -- (app.guard_tcms_document_reference): keine GwG-, Personal- oder private
  -- Mitarbeiterunterlage, kein Lohnbezug, kein Onboarding- oder
  -- Formularbezug. Sonst liefe ein Nachweis etwa als GwG-Beleg in die
  -- GwG-Pflichtvernichtung. Die Umklassifizierung der Ablage prüft vorher
  -- selbst und nennt den Grund; dieser Trigger ist die Rückfallebene für
  -- jeden Pfad (WHEN des Triggers: nur Wechsel in einen solchen Rahmen).
  -- kk-tcms-s10nach: Ebenso bleibt ein gebundenes Dokument bei seinem
  -- Mandanten und Tenant. Ein Wechsel von client_id (auf einen anderen
  -- Mandanten oder NULL) oder tenant_id ließe den Verweis des Tax-CMS auf ein
  -- Dokument eines anderen Mandanten zeigen; die Auslieferung prüft den
  -- Mandanten, der Verweis wäre aber still gebrochen. Kein Anwendungspfad
  -- ändert diese Spalten; gesperrt ist es für jede Rolle.
  IF EXISTS (
    SELECT 1
      FROM public.tcms_document_reference r
     WHERE r.document_id = OLD.id
       AND r.tenant_id = OLD.tenant_id
       AND r.released_at IS NULL
  ) THEN
    IF NEW.client_id IS DISTINCT FROM OLD.client_id
       OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
      RAISE EXCEPTION 'document: als Nachweis im Tax-CMS verknüpft, Mandantenwechsel gesperrt'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RAISE EXCEPTION 'document: als Nachweis im Tax-CMS verknüpft, Umklassifizieren gesperrt'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER document_tcms_reference_scope_guard BEFORE UPDATE OF classification, requires_payroll_access, gwg_onboarding_invite_id, form_submission_id, client_id, tenant_id ON public.document FOR EACH ROW WHEN (((new.client_id IS DISTINCT FROM old.client_id) OR (new.tenant_id IS DISTINCT FROM old.tenant_id) OR ((new.classification IS DISTINCT FROM old.classification) AND (new.classification = ANY (ARRAY['GWG_EVIDENCE'::public.document_classification, 'PERSONNEL'::public.document_classification, 'STAFF_PRIVATE'::public.document_classification]))) OR (new.requires_payroll_access AND (NOT old.requires_payroll_access)) OR ((new.gwg_onboarding_invite_id IS NOT NULL) AND (new.gwg_onboarding_invite_id IS DISTINCT FROM old.gwg_onboarding_invite_id)) OR ((new.form_submission_id IS NOT NULL) AND (new.form_submission_id IS DISTINCT FROM old.form_submission_id)))) EXECUTE FUNCTION app.guard_tcms_referenced_document_scope();

COMMIT;
