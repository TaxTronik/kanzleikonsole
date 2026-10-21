CREATE OR REPLACE FUNCTION app.tcms_gwg_evidence_tax_retention_until(p_created_at timestamp without time zone)
 RETURNS timestamp without time zone
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO 'pg_catalog'
AS $function$
  -- TCMS-NACHWEIS-001, GWG-RETENTION-DESTRUCTION-001 (kk-tcms-s11,
  -- Produktentscheidung Rey Koxha, 21.10.2026): Ein GwG-Beleg, der als
  -- Nachweis im Tax-CMS gebunden ist oder war, gilt zugleich als steuerliche
  -- Unterlage. Seine Aufbewahrung steigt auf die nächsthöhere Klasse des
  -- vorhandenen Modells (Rang GWG < GOBD, retag-policy.ts): GoBD mit dem
  -- Intervall der Steuerunterlage (GOBD_TAX, zehn Jahre), berechnet wie die
  -- GoBD-Höherstufung der Ablage (retentionUntilForYears(10, Anlage),
  -- packages/storage/src/service.ts): Jahr der Dokumentanlage plus zehn volle
  -- Jahre, Stichtag 1. Januar des Folgejahres, 00:00 UTC. NULL bleibt NULL.
  SELECT make_date(EXTRACT(YEAR FROM p_created_at)::integer + 11, 1, 1)::timestamp without time zone
$function$;
