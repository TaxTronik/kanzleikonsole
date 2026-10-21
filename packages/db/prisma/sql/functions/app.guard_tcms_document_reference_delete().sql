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
