CREATE OR REPLACE FUNCTION app.freeze_submission_schema()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE frozen JSONB;
BEGIN
 IF TG_OP = 'UPDATE' THEN
   IF NEW.schema_snapshot IS DISTINCT FROM OLD.schema_snapshot OR NEW.template_id IS DISTINCT FROM OLD.template_id THEN
     RAISE EXCEPTION 'Frozen submission schema cannot be changed';
   END IF;
   RETURN NEW;
 END IF;
 PERFORM id FROM public.form_template WHERE id = NEW.template_id AND tenant_id = NEW.tenant_id FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Invalid form template scope'; END IF;
 SELECT jsonb_build_object('version', 1, 'name', t.name, 'description', t.description, 'introMd', t.intro_md,
   'fields', COALESCE((SELECT jsonb_agg(jsonb_build_object('id',f.id,'key',f.key,'label',f.label,'type',f.type,
    'required',f.required,'options',f.options,'helpText',f.help_text,'defaultValue',f.default_value,
    'minValue',f.min_value,'maxValue',f.max_value) ORDER BY f.position) FROM public.form_field f WHERE f.template_id=t.id),'[]'::jsonb))
 INTO frozen FROM public.form_template t WHERE t.id = NEW.template_id;
 -- Campaigns may bind an older campaign-frozen revision. Ordinary inserts use the current revision.
 IF NEW.schema_snapshot IS NULL THEN NEW.schema_snapshot := frozen; END IF;
 IF NEW.schema_snapshot->>'version' IS DISTINCT FROM '1' OR jsonb_typeof(NEW.schema_snapshot->'fields') IS DISTINCT FROM 'array' THEN
   RAISE EXCEPTION 'Invalid frozen form schema';
 END IF;
 RETURN NEW;
END $function$;
