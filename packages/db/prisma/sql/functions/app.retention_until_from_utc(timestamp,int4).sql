CREATE OR REPLACE FUNCTION app.retention_until_from_utc(p_anchor_utc timestamp without time zone, p_years integer)
 RETURNS timestamp without time zone
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE STRICT
 SET search_path TO 'pg_catalog'
AS $function$
  -- Prisma-TIMESTAMP speichert den Zeitpunkt als UTC-Wanduhrzeit. Der
  -- fachliche Anker gehört zum Berliner Kalenderjahr. Der gespeicherte
  -- Stichtag bleibt der folgende 1. Januar nach vollen Jahren, 00:00 UTC.
  SELECT make_date(
    EXTRACT(YEAR FROM (p_anchor_utc AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin')::integer + p_years + 1,
    1, 1
  )::timestamp without time zone
$function$;
