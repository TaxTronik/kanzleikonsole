CREATE OR REPLACE FUNCTION app.guard_gwg_id_document_scope_and_claim()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
DECLARE
  old_pending UUID;
  old_check_id UUID;
  new_check_id UUID;
  old_document_id UUID;
  new_document_id UUID;
  authorized_document_destruction BOOLEAN := FALSE;
  authorized_check_destruction BOOLEAN := FALSE;
  authorized_document_unlink BOOLEAN := FALSE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_check_id := OLD."gwg_check_id";
    old_document_id := OLD."document_id";
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_check_id := NEW."gwg_check_id";
    new_document_id := NEW."document_id";
  END IF;

  -- Beim Tenant-Cascade koennen Client/Document bereits entfernt sein, waehrend
  -- ein SET-NULL-FK die neue Subject-Referenz am Ausweissnapshot loest. Sobald
  -- der Check keinen noch existierenden Tenant mehr besitzt, ist das keine
  -- fachliche Einzelmutation, sondern ausschliesslich die kontrollierte
  -- Parent-Kaskade. Die normalen FK-Trigger bleiben weiterhin wirksam.
  IF TG_OP <> 'INSERT' AND NOT EXISTS (
    SELECT 1
      FROM public."gwg_check" gc
      JOIN public."tenant" t ON t."id" = gc."tenant_id"
     WHERE gc."id" = old_check_id
  ) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- BEFORE-Trigger laufen vor der FK-Prüfung. Ohne einen eigenen Parent-Lock
  -- könnte ein INSERT den alten, noch nicht vernichteten Zustand lesen, erst
  -- anschließend am FK-KeyShare warten und nach Commit der Vernichtung als
  -- neue Kindzeile in das bereits vernichtete Skelett nachrutschen. Beide
  -- möglichen Parents werden sortiert gelockt, damit auch Reparenting keine
  -- Gegenlock-Reihenfolge erzeugt.
  PERFORM gc."id"
    FROM public."gwg_check" gc
   WHERE gc."id" = old_check_id OR gc."id" = new_check_id
   ORDER BY gc."id"
   FOR SHARE;

  -- Dasselbe gilt für den zweiphasigen Dokument-Claim: Relation und Claim
  -- müssen über denselben Parent-Lock serialisiert werden.
  PERFORM d."id"
    FROM public."document" d
   WHERE d."id" = old_document_id OR d."id" = new_document_id
   ORDER BY d."id"
   FOR SHARE;

  IF TG_OP <> 'INSERT' THEN
    IF old_document_id IS NOT NULL THEN
      SELECT d."id" INTO old_pending
        FROM public."document" d
       WHERE d."id" = old_document_id
          AND d."gwg_destruction_requested_at" IS NOT NULL
          AND d."gwg_destroyed_at" IS NULL;

      authorized_document_destruction := old_pending IS NOT NULL AND COALESCE((
        current_setting('app.gwg_destroy_document_id', TRUE) = old_pending::TEXT
        AND CURRENT_USER = (
          SELECT pg_get_userbyid(p.proowner)
            FROM pg_catalog.pg_proc p
           WHERE p.oid = pg_catalog.to_regprocedure('app.destroy_gwg_document_versions(uuid)')
        )
      ), FALSE);
    END IF;

    authorized_check_destruction := COALESCE((
      current_setting('app.gwg_destroy_check_id', TRUE) = old_check_id::TEXT
      AND CURRENT_USER = (
        SELECT pg_get_userbyid(p.proowner)
          FROM pg_catalog.pg_proc p
         WHERE p.oid = pg_catalog.to_regprocedure('app.destroy_gwg_check(uuid)')
      )
    ), FALSE);
  END IF;

  -- Personenbezogene Ausweis-Snapshots bleiben nach einer Verifizierung auch
  -- im Status EXPIRED unveränderlich. Die Dokumentvernichtung darf lediglich
  -- die konkrete Belegrelation lösen; die Checkvernichtung darf den Snapshot
  -- innerhalb ihrer eng begrenzten SECURITY-DEFINER-Funktion anonymisieren.
  authorized_document_unlink :=
    TG_OP = 'UPDATE'
    AND authorized_document_destruction
    AND NEW."document_id" IS NULL
    AND OLD."document_id" = old_pending
    AND NEW."id" IS NOT DISTINCT FROM OLD."id"
    AND NEW."gwg_check_id" IS NOT DISTINCT FROM OLD."gwg_check_id"
    AND NEW."type" IS NOT DISTINCT FROM OLD."type"
    AND NEW."owner_name" IS NOT DISTINCT FROM OLD."owner_name"
    AND NEW."number" IS NOT DISTINCT FROM OLD."number"
    AND NEW."issued_by" IS NOT DISTINCT FROM OLD."issued_by"
    AND NEW."issue_date" IS NOT DISTINCT FROM OLD."issue_date"
    AND NEW."expiry_date" IS NOT DISTINCT FROM OLD."expiry_date"
    AND NEW."verified_at" IS NOT DISTINCT FROM OLD."verified_at"
    AND NEW."notes" IS NOT DISTINCT FROM OLD."notes"
    AND NEW."created_at" IS NOT DISTINCT FROM OLD."created_at";

  IF EXISTS (
    SELECT 1 FROM public."gwg_check" gc
     WHERE gc."id" IN (old_check_id, new_check_id)
       AND EXISTS (SELECT 1 FROM public."tenant" t WHERE t."id" = gc."tenant_id")
       AND (
         gc."verified_at" IS NOT NULL
         OR gc."status" = 'VERIFIED'
         OR gc."destroyed_at" IS NOT NULL
       )
  ) AND NOT authorized_check_destruction AND NOT authorized_document_unlink THEN
    RAISE EXCEPTION 'Verifizierter GwG-Ausweis-Snapshot ist unveränderlich.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP <> 'DELETE' AND NEW."document_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM public."document" d
      JOIN public."gwg_check" gc ON gc."id" = NEW."gwg_check_id"
     WHERE d."id" = NEW."document_id"
       AND d."tenant_id" = gc."tenant_id"
       AND d."client_id" = gc."client_id"
       AND d."classification" = 'GWG_EVIDENCE'
       AND d."deleted_at" IS NULL
       AND d."gwg_destruction_requested_at" IS NULL
       AND d."gwg_destroyed_at" IS NULL
  ) THEN
    RAISE EXCEPTION 'GwG-ID-Dokument braucht einen verfügbaren GWG_EVIDENCE-Beleg aus demselben Tenant/Mandanten.'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF TG_OP <> 'INSERT' AND old_pending IS NOT NULL THEN
    IF NOT authorized_document_destruction THEN
      RAISE EXCEPTION 'GwG-Nachweis ist zur Vernichtung vorgemerkt; Verknüpfung ist eingefroren.'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  IF TG_OP <> 'DELETE' AND NEW."document_id" IS NOT NULL AND EXISTS (
    SELECT 1 FROM public."document" d
     WHERE d."id" = NEW."document_id"
       AND d."gwg_destruction_requested_at" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'GwG-Nachweis ist zur Vernichtung vorgemerkt; neue Verknüpfung ist unzulässig.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$function$;
