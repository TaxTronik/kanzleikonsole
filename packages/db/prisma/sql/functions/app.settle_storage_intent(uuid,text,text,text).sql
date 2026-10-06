CREATE OR REPLACE FUNCTION app.settle_storage_intent(p_intent_id uuid, p_storage_bucket text, p_storage_key text, p_storage_version_id text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
DECLARE
  v_tenant_id UUID := app.current_tenant_id();
  v_version_id TEXT := COALESCE(p_storage_version_id, '');
  v_settled INTEGER;
BEGIN
  IF v_tenant_id IS NULL
     OR app.current_actor_type() IS NULL
     OR app.current_actor_type() NOT IN ('STAFF', 'CLIENT_CONTACT', 'SYSTEM') THEN
    RAISE EXCEPTION 'STORAGE_INTENT_CONTEXT: Speicherabsicht nur im Mandantenkontext abschliessbar.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Abschluss nur mit dauerhafter Referenz derselben Transaktion bzw. desselben
  -- Tenants: Eine als REFERENCED geschlossene Absicht wird nie mehr geloescht.
  IF NOT EXISTS (
    SELECT 1
      FROM public.document_version version
      JOIN public.document document ON document.id = version.document_id
     WHERE version.storage_bucket = p_storage_bucket
       AND version.storage_key = p_storage_key
       AND version.storage_version_id IS NOT DISTINCT FROM NULLIF(v_version_id, '')
       AND document.tenant_id = v_tenant_id
  ) THEN
    RAISE EXCEPTION 'STORAGE_INTENT_UNREFERENCED: Speicherabsicht ohne Dokumentversion.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  UPDATE public.storage_orphan journal
     SET storage_version_id = v_version_id,
         resolution = 'REFERENCED',
         cleaned_at = now(),
         cleanup_error = NULL,
         updated_at = now()
   WHERE journal.id = p_intent_id
     AND journal.tenant_id = v_tenant_id
     AND journal.intent
     AND journal.cleaned_at IS NULL
     AND journal.cleanup_claimed_at IS NULL
     AND journal.storage_bucket = p_storage_bucket
     AND journal.storage_key = p_storage_key
     AND journal.storage_version_id IN ('', v_version_id);
  GET DIAGNOSTICS v_settled = ROW_COUNT;
  IF v_settled <> 1 THEN
    RAISE EXCEPTION 'STORAGE_INTENT_NOT_OPEN: Speicherabsicht ist nicht mehr offen.'
      USING ERRCODE = 'restrict_violation';
  END IF;
END;
$function$;
