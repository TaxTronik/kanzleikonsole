CREATE OR REPLACE FUNCTION app.gwg_onboarding_draft_drop_on_invite_closed()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  -- Widerruf, Ablösung oder Vernichtung: Der Link ist entwertet, der
  -- Zwischenstand lässt sich nie mehr öffnen und enthält Personendaten.
  DELETE FROM public."gwg_onboarding_draft"
   WHERE "invite_id" = NEW."id"
     AND "tenant_id" = NEW."tenant_id";
  RETURN NEW;
END;
$function$;
