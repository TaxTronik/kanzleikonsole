CREATE OR REPLACE FUNCTION app.check_wiki_context()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE scope UUID;
BEGIN
 IF TG_OP='UPDATE' AND NEW.wiki_article_ids IS NOT DISTINCT FROM OLD.wiki_article_ids THEN RETURN NEW; END IF;
 IF cardinality(NEW.wiki_article_ids)>10 THEN RAISE EXCEPTION 'Too many knowledge links'; END IF;
 IF app.current_actor_type()='CLIENT_CONTACT' AND (TG_OP='UPDATE' OR cardinality(NEW.wiki_article_ids)>0) THEN RAISE EXCEPTION 'Staff context only'; END IF;
 IF TG_TABLE_NAME='workflow_step' THEN SELECT tenant_id INTO scope FROM public.workflow_template WHERE id=NEW.template_id;
 ELSIF TG_TABLE_NAME='workflow_item' THEN SELECT tenant_id INTO scope FROM public.workflow_instance WHERE id=NEW.instance_id;
 ELSE scope := NEW.tenant_id; END IF;
 IF EXISTS (SELECT 1 FROM unnest(NEW.wiki_article_ids) x WHERE NOT EXISTS(SELECT 1 FROM public.kb_article a WHERE a.id=x AND a.tenant_id=scope)) THEN
   RAISE EXCEPTION 'Knowledge article outside tenant';
 END IF;
 RETURN NEW;
END $function$;
