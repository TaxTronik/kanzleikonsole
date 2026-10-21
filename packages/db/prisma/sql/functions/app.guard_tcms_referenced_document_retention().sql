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
