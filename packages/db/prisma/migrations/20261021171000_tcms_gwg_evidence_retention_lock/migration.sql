-- TCMS-NACHWEIS-001 / GWG-RETENTION-DESTRUCTION-001.
--
-- RT3D-K-01 (Angriffsdurchlauf kk-tcms-redteam3d), kk-tcms-fix5: Die
-- Steuerfrist eines GwG-Belegs mit (auch freigegebenem) Verweis des Tax-CMS
-- (kk-tcms-s11, Migration 20261021150000) hing an document.created_at und
-- document.retention_until. Beide waren unter der App-Rolle bis zum Vormerken
-- frei änderbar: zurückdatiert und gesenkt, ließ der Claim die Vernichtung der
-- Bytes Jahre vor der Steuerfrist zu. Ab der ersten Bindung gilt jetzt für
-- jede Rolle (einen Wartungsweg gibt es nicht):
--   - Trigger document_tcms_retention_guard: created_at und tenant_id eines
--     Dokuments mit Verweis sind unveränderlich; ein GwG-Beleg mit Verweis
--     bleibt GwG-Beleg und bei seinem Mandanten, sein Aufbewahrungsende sinkt
--     nie, wird nie NULL und ein fehlendes wird nur durch ein Ende ab der
--     Steuerfrist ersetzt (23001).
--   - Trigger tcms_document_reference_no_delete: Verweise werden nie gelöscht,
--     nur freigegeben (bisher durfte die Owner-Rolle löschen); Ausnahmen sind
--     die Tenant-Kaskade und die kontrollierte Vernichtung (freigegebene
--     Verweise in app.destroy_gwg_document_versions).
--   - app.raise_tcms_gwg_evidence_retention hebt zusätzlich auf das Ende der
--     GwG-Frist, wenn das Mandat beendet ist; Trigger
--     client_tcms_gwg_evidence_retention bei jedem neuen Mandatsende. Ein später
--     zurückgenommenes oder früher eingetragenes Mandatsende verkürzt die
--     Aufbewahrung dieser Belege damit nicht mehr.
--   - Trigger document_tcms_gwg_evidence_retention: Wird ein früherer Nachweis
--     nach der Freigabe zum GwG-Beleg, steigt sein Aufbewahrungsende wie bei
--     einer Bindung (bisher hielt nur der Claim die Steuerfrist).
--   - Datenänderung: Altbestand (GwG-Belege mit Verweis) erneut anheben, jetzt
--     einschließlich der GwG-Frist beendeter Mandate.
-- Die Restore-Invariante „App-Rolle ohne DELETE, TRUNCATE, REFERENCES, TRIGGER,
-- MAINTAIN auf tcms_document_reference“ prüft packages/db/src/restore-security.ts.
--
-- Erzeugt mit `pnpm db:sql:migration` aus packages/db/prisma/sql
-- (docs/development/kanonische-sql-quellen.md):
--   neu:      functions/app.guard_tcms_document_reference_delete().sql
--   neu:      functions/app.guard_tcms_referenced_document_retention().sql
--   geändert: functions/app.raise_tcms_gwg_evidence_retention(uuid).sql
--   neu:      functions/app.tcms_gwg_evidence_classification_retention().sql
--   neu:      functions/app.tcms_gwg_evidence_mandate_end_retention().sql
--   neu:      triggers/client.client_tcms_gwg_evidence_retention.sql
--   neu:      triggers/document.document_tcms_gwg_evidence_retention.sql
--   neu:      triggers/document.document_tcms_retention_guard.sql
--   neu:      triggers/tcms_document_reference.tcms_document_reference_no_delete.sql
BEGIN;

CREATE OR REPLACE FUNCTION app.guard_tcms_document_reference_delete()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
BEGIN
  -- TCMS-NACHWEIS-001, GWG-RETENTION-DESTRUCTION-001 (RT3D-K-01, kk-tcms-fix5):
  -- Ein Verweis des Tax-CMS ist der Anker der Lösch-, Versions- und
  -- Umklassifizierungssperre (offen) und der Steuerfrist eines GwG-Belegs
  -- (offen oder freigegeben: Claim, app.raise_tcms_gwg_evidence_retention,
  -- app.guard_tcms_referenced_document_retention). Er wird deshalb nie
  -- gelöscht, nur freigegeben. Die App-Rolle hat ohnehin kein DELETE
  -- (Restore-Invariante); dieser Trigger hält die Regel für jede Rolle.
  -- Ausnahmen:
  --   - die Kaskade beim Löschen des Tenants (der Tenant ist dann nicht mehr
  --     sichtbar, wie in app.guard_gwg_document_invite_and_claim);
  --   - freigegebene Verweise eines GwG-Belegs in seiner kontrollierten
  --     Vernichtung (app.destroy_gwg_document_versions setzt
  --     app.gwg_destroy_document_id und läuft als Eigentümer der Funktion,
  --     nachdem der Claim beide Fristen geprüft hat).
  IF NOT EXISTS (SELECT 1 FROM public.tenant t WHERE t.id = OLD.tenant_id) THEN
    RETURN OLD;
  END IF;
  IF OLD.released_at IS NOT NULL
     AND COALESCE((
       current_setting('app.gwg_destroy_document_id', TRUE) = OLD.document_id::text
       AND CURRENT_USER = (
         SELECT pg_get_userbyid(p.proowner)
           FROM pg_catalog.pg_proc p
          WHERE p.oid = pg_catalog.to_regprocedure('app.destroy_gwg_document_versions(uuid)')
       )
     ), FALSE) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'tcms_document_reference: ein Verweis wird nie gelöscht, nur freigegeben'
    USING ERRCODE = 'restrict_violation';
END
$function$;

CREATE OR REPLACE FUNCTION app.guard_tcms_referenced_document_retention()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
BEGIN
  -- TCMS-NACHWEIS-001, GWG-RETENTION-DESTRUCTION-001 (RT3D-K-01, kk-tcms-fix5):
  -- Die Steuerfrist eines GwG-Belegs mit Verweis des Tax-CMS (kk-tcms-s11)
  -- rechnet der Claim app.assert_gwg_document_destruction_due aus created_at;
  -- Claim und Aktion prüfen zusätzlich retention_until. Beide Spalten waren bis
  -- zum Vormerken unter der App-Rolle frei änderbar: zurückdatiert und gesenkt,
  -- ließ der Claim die Vernichtung Jahre vor der Steuerfrist zu. Ab der ersten
  -- Bindung (ein Verweis in tcms_document_reference, offen oder freigegeben;
  -- Verweise werden nie gelöscht, app.guard_tcms_document_reference_delete)
  -- gilt deshalb für jede Rolle:
  --   - created_at und tenant_id jedes verwiesenen Dokuments sind
  --     unveränderlich: created_at ist der Anker der Steuerfrist, und der Claim
  --     sucht den Verweis im Tenant des Dokuments. Das gilt auch für Nachweise,
  --     die (noch) keine GwG-Belege sind; nach der Freigabe kann ein Nachweis
  --     zum GwG-Beleg werden (app.tcms_gwg_evidence_classification_retention).
  --   - Ein GwG-Beleg mit Verweis bleibt GwG-Beleg (die Ablage lässt die
  --     GwG-Stufe ohnehin nie verlassen, BLOCK_GWG_TIER_CHANGE) und bei seinem
  --     Mandanten, dessen Mandatsende die GwG-Frist bestimmt.
  --   - Sein Aufbewahrungsende sinkt nie und wird nie NULL. Ein fehlendes Ende
  --     (fail closed: keine Vernichtung) ersetzt nur ein Ende ab der Steuerfrist.
  -- Kein Anwendungspfad ändert diese Spalten so (neue Versionen und
  -- app.raise_tcms_gwg_evidence_retention heben nur an); einen Wartungsweg
  -- gibt es nicht.
  IF NOT EXISTS (
    SELECT 1
      FROM public.tcms_document_reference r
     WHERE r.document_id = OLD.id
  ) THEN
    RETURN NEW;
  END IF;
  IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'document: Verweis des Tax-CMS, Anlagedatum unveränderlich'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'document: Verweis des Tax-CMS, Tenantwechsel gesperrt'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.classification = 'GWG_EVIDENCE' THEN
    IF NEW.classification IS DISTINCT FROM OLD.classification THEN
      RAISE EXCEPTION 'document: GwG-Beleg mit Verweis des Tax-CMS, Umklassifizieren gesperrt'
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.client_id IS DISTINCT FROM OLD.client_id THEN
      RAISE EXCEPTION 'document: GwG-Beleg mit Verweis des Tax-CMS, Mandantenwechsel gesperrt'
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.retention_until IS NOT NULL
       AND (NEW.retention_until IS NULL OR NEW.retention_until < OLD.retention_until) THEN
      RAISE EXCEPTION 'document: GwG-Beleg mit Verweis des Tax-CMS, Aufbewahrungsende nie früher'
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.retention_until IS NULL
       AND NEW.retention_until < app.tcms_gwg_evidence_tax_retention_until(OLD.created_at) THEN
      RAISE EXCEPTION 'document: GwG-Beleg mit Verweis des Tax-CMS, Aufbewahrungsende vor der Steuerfrist'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION app.raise_tcms_gwg_evidence_retention(p_document_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
DECLARE
  raised integer;
  ziel timestamp;
BEGIN
  -- TCMS-NACHWEIS-001, GWG-RETENTION-DESTRUCTION-001 (kk-tcms-s11,
  -- Produktentscheidung Rey Koxha, 21.10.2026): Ein GwG-Beleg, auf den ein
  -- Verweis des Tax-CMS zeigt oder zeigte, gilt zugleich als steuerliche
  -- Unterlage. Seine Aufbewahrung (document.retention_until) steigt auf die
  -- GoBD-Frist der Steuerunterlage (app.tcms_gwg_evidence_tax_retention_until)
  -- und sinkt nie. Die GwG-Vernichtung prüft retention_until in Aktion und
  -- Claim; sie ist damit erst fällig, wenn beide Fristen abgelaufen sind, auch
  -- nach der Freigabe der Verknüpfung.
  -- RT3D-K-01 (kk-tcms-fix5): Ist das Mandat beendet, steigt das Ende
  -- zusätzlich auf das Ende der GwG-Frist: 1. Januar des sechsten Jahres nach
  -- dem Jahr des Mandatsendes, wie im Claim (dort in der Zeitzone der Sitzung),
  -- mindestens nach dem deutschen Kalenderjahr. Da retention_until dieser
  -- Belege nie sinkt (app.guard_tcms_referenced_document_retention), verkürzt
  -- ein später zurückgenommenes oder früher eingetragenes Mandatsende die
  -- Aufbewahrung nicht mehr; der Trigger client_tcms_gwg_evidence_retention
  -- hebt bei jedem neuen Mandatsende an.
  -- Nicht angehoben werden: ein fehlendes Aufbewahrungsende (NULL hält die
  -- Vernichtung fail closed gesperrt; ein Datum würde sie später erlauben),
  -- vorgemerkte und vernichtete Belege (deren Felder sind eingefroren,
  -- app.guard_gwg_document_invite_and_claim) – für sie gilt dieselbe Frist über
  -- den Claim (app.assert_gwg_document_destruction_due).
  -- Läuft mit den Rechten des Aufrufers (RLS des Tenants); heben kann sie nur,
  -- verkürzen nie.
  SELECT GREATEST(
           app.tcms_gwg_evidence_tax_retention_until(doc.created_at),
           make_date(
             GREATEST(
               EXTRACT(YEAR FROM c.mandate_ended_at::timestamp),
               EXTRACT(YEAR FROM c.mandate_ended_at AT TIME ZONE 'Europe/Berlin')
             )::integer + 6,
             1,
             1
           )::timestamp
         )
    INTO ziel
    FROM public.document doc
    LEFT JOIN public.client c
      ON c.id = doc.client_id AND c.tenant_id = doc.tenant_id
   WHERE doc.id = p_document_id;
  UPDATE public.document d
     SET retention_until = ziel
   WHERE d.id = p_document_id
     AND d.classification = 'GWG_EVIDENCE'
     AND d.gwg_destruction_requested_at IS NULL
     AND d.gwg_destroyed_at IS NULL
     AND d.retention_until IS NOT NULL
     AND d.retention_until < ziel
     AND EXISTS (
       SELECT 1
         FROM public.tcms_document_reference r
        WHERE r.document_id = d.id
          AND r.tenant_id = d.tenant_id
     );
  GET DIAGNOSTICS raised = ROW_COUNT;
  RETURN raised;
END;
$function$;

CREATE OR REPLACE FUNCTION app.tcms_gwg_evidence_classification_retention()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
BEGIN
  -- TCMS-NACHWEIS-001 (RT3D-K-01, kk-tcms-fix5): Wird ein früherer Nachweis
  -- nach der Freigabe seiner Bindung zum GwG-Beleg (Umklassifizierung der
  -- Ablage mit Re-Store in den GwG-Bucket), gilt er ab dann als steuerliche
  -- Unterlage wie ein gebundener GwG-Beleg: Sein Aufbewahrungsende steigt wie
  -- bei einer Bindung (app.raise_tcms_gwg_evidence_retention); bisher hielt
  -- nur der Claim die Steuerfrist (kk-tcms-s11, offener Punkt 2).
  PERFORM app.raise_tcms_gwg_evidence_retention(NEW.id);
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION app.tcms_gwg_evidence_mandate_end_retention()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
 SET row_security TO 'off'
AS $function$
DECLARE
  d record;
BEGIN
  -- TCMS-NACHWEIS-001, GWG-RETENTION-DESTRUCTION-001 (RT3D-K-01, kk-tcms-fix5):
  -- Mit dem Mandatsende beginnt die GwG-Frist. Für GwG-Belege mit Verweis des
  -- Tax-CMS hält app.raise_tcms_gwg_evidence_retention sie im
  -- Aufbewahrungsende fest, das für diese Belege nie sinkt. Ein später
  -- zurückgenommenes oder auf ein früheres Datum gesetztes Mandatsende
  -- verkürzt die Aufbewahrung dann nicht mehr. Ohne RLS (SECURITY DEFINER):
  -- Jeder solche Beleg des Mandanten wird angehoben, auch wenn die handelnde
  -- Person ihn nicht sieht; die Funktion hebt nur an, nie herab.
  FOR d IN
    SELECT doc.id
      FROM public.document doc
     WHERE doc.client_id = NEW.id
       AND doc.tenant_id = NEW.tenant_id
       AND doc.classification = 'GWG_EVIDENCE'
       AND EXISTS (
         SELECT 1
           FROM public.tcms_document_reference r
          WHERE r.document_id = doc.id
            AND r.tenant_id = doc.tenant_id
       )
     ORDER BY doc.id
  LOOP
    PERFORM app.raise_tcms_gwg_evidence_retention(d.id);
  END LOOP;
  RETURN NULL;
END;
$function$;

CREATE TRIGGER client_tcms_gwg_evidence_retention AFTER UPDATE OF mandate_ended_at ON public.client FOR EACH ROW WHEN (((new.mandate_ended_at IS NOT NULL) AND (old.mandate_ended_at IS DISTINCT FROM new.mandate_ended_at))) EXECUTE FUNCTION app.tcms_gwg_evidence_mandate_end_retention();

CREATE TRIGGER document_tcms_gwg_evidence_retention AFTER UPDATE OF classification ON public.document FOR EACH ROW WHEN (((new.classification = 'GWG_EVIDENCE'::public.document_classification) AND (old.classification IS DISTINCT FROM new.classification))) EXECUTE FUNCTION app.tcms_gwg_evidence_classification_retention();

CREATE TRIGGER document_tcms_retention_guard BEFORE UPDATE ON public.document FOR EACH ROW WHEN (((new.created_at IS DISTINCT FROM old.created_at) OR (new.tenant_id IS DISTINCT FROM old.tenant_id) OR ((old.classification = 'GWG_EVIDENCE'::public.document_classification) AND ((new.classification IS DISTINCT FROM old.classification) OR (new.client_id IS DISTINCT FROM old.client_id) OR (new.retention_until IS DISTINCT FROM old.retention_until))))) EXECUTE FUNCTION app.guard_tcms_referenced_document_retention();

CREATE TRIGGER tcms_document_reference_no_delete BEFORE DELETE ON public.tcms_document_reference FOR EACH ROW EXECUTE FUNCTION app.guard_tcms_document_reference_delete();

-- SECURITY DEFINER nur als Trigger (wie app.mark_mandate_artifact_document).
REVOKE ALL ON FUNCTION app.tcms_gwg_evidence_mandate_end_retention() FROM PUBLIC;

-- Altbestand: GwG-Belege mit (auch freigegebenem) Verweis des Tax-CMS erneut
-- anheben (Steuerfrist und, bei beendetem Mandat, GwG-Frist). Die Meldung nennt
-- nur Anzahlen, keine Kennungen.
DO $migration$
DECLARE
  angehoben integer := 0;
  belege integer := 0;
  d RECORD;
BEGIN
  FOR d IN
    SELECT doc.id
      FROM public.document doc
     WHERE doc.classification = 'GWG_EVIDENCE'
       AND EXISTS (
         SELECT 1
           FROM public.tcms_document_reference r
          WHERE r.document_id = doc.id
            AND r.tenant_id = doc.tenant_id
       )
     ORDER BY doc.id
  LOOP
    belege := belege + 1;
    angehoben := angehoben + app.raise_tcms_gwg_evidence_retention(d.id);
  END LOOP;
  RAISE NOTICE 'RT3D-K-01: % GwG-Belege mit Verweis des Tax-CMS, % Aufbewahrungsenden angehoben.',
    belege, angehoben;
END
$migration$;

COMMIT;
