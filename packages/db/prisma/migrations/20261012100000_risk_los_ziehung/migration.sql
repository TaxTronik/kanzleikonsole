-- TCMS-SAMPLE-PROOF-001.
--
-- Folgepunkt P-11 (Welle 15): Los-Ziehungen in eine eigene Tabelle.
--
-- Bisher las die Los-Liste (apps/web/src/server/risk/los.ts, listLosZiehungen)
-- ihre fachlichen Daten ausschliesslich aus audit_log (action
-- risk.los.gezogen, Nachweis und Rahmen im after-Payload). Das koppelt eine
-- Fachansicht an das wachsende Audit-Log und an jede kuenftige Kuerzung nach
-- der Archivierung (AUDIT_ARCHIVE_MODE=HARD, bisher nicht implementiert, RF-13).
--
-- Neu: risk_los_ziehung, eine tenantgebundene, unveraenderliche Abbildung der
-- Audit-Ereignisse risk.los.gezogen (Nachweis, Rahmen, Zeitraum, Rahmenart,
-- Review-Aufgaben, Versuchs-/Job-ID). Das Audit-Ereignis bleibt der Nachweis:
--   - Ein AFTER-INSERT-Trigger auf audit_log (nur action = risk.los.gezogen)
--     legt die Zeile in derselben Transaktion an. So bildet die Tabelle auch
--     Ziehungen ab, die ein aelterer Release-Stand nach einem App-Rollback
--     schreibt (Expand/Contract, docs/operations/release.md); kein Code muss
--     zweimal schreiben.
--   - Ein BEFORE-INSERT-Guard verlangt fuer jede Zeile das passende
--     Audit-Ereignis desselben Tenants, Feld fuer Feld
--     (app.risk_los_ziehung_projection). Die App-Rolle braucht INSERT nur fuer
--     den Trigger; eine Ziehung ohne Nachweis kann sie nicht anlegen.
--   - UPDATE, DELETE und TRUNCATE sperrt app.prevent_modification() wie bei
--     audit_log; App- und Owner-Rolle erhalten nur SELECT und INSERT.
--   - Kein Fremdschluessel auf audit_log: Eine kuenftige Kuerzung des
--     Audit-Logs nach der Archivierung soll die Ziehung nicht mitnehmen.
--   - tenant_id mit ON DELETE NO ACTION wie audit_log; RLS wie die
--     Nachbartabellen (ENABLE + FORCE, Isolation-Policy).
--
-- Altbestand: Alle vorhandenen Ereignisse risk.los.gezogen mit vollstaendigem
-- Nachweis werden uebernommen (idempotent per ON CONFLICT, Zaehlpruefung am
-- Ende). Ereignisse ohne Nachweis, Commitment, Stichprobe oder Rahmen zeigte
-- die Liste schon bisher nicht an; sie bleiben nur im Audit-Log (NOTICE mit
-- ihrer Anzahl). Nichts wird geloescht; das alte Release liest weiter aus
-- audit_log. Gegenlauf: scripts/ci/migration-cutoff/los-ziehung-*.sql.
--
-- Erzeugt mit `pnpm db:sql:migration` aus packages/db/prisma/sql
-- (docs/development/kanonische-sql-quellen.md):
--   neu:      functions/app.guard_risk_los_ziehung().sql
--   neu:      functions/app.project_risk_los_ziehung().sql
--   neu:      functions/app.risk_los_ziehung_projection(jsonb).sql
--   neu:      policies/risk_los_ziehung.risk_los_ziehung_isolation.sql
--   neu:      triggers/audit_log.risk_los_ziehung_projection.sql
--   neu:      triggers/risk_los_ziehung.risk_los_ziehung_audit_binding.sql
--   neu:      triggers/risk_los_ziehung.risk_los_ziehung_no_modify.sql
BEGIN;

CREATE TABLE public."risk_los_ziehung" (
  "audit_log_id" BIGINT NOT NULL,
  "tenant_id" UUID NOT NULL,
  "audit_occurred_at" TIMESTAMPTZ(6) NOT NULL,
  "commitment" TEXT NOT NULL,
  "rahmen_typ" TEXT NOT NULL,
  "nachweis" JSONB NOT NULL,
  "rahmen" JSONB NOT NULL,
  "zeitraum" JSONB,
  "review_aufgaben" JSONB NOT NULL,
  "attempt_id" TEXT,
  "job_id" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "risk_los_ziehung_pkey" PRIMARY KEY ("audit_log_id"),
  CONSTRAINT "risk_los_ziehung_rahmen_typ_check" CHECK ("rahmen_typ" IN ('subsumtion', 'audit')),
  CONSTRAINT "risk_los_ziehung_payload_check" CHECK (
    jsonb_typeof("nachweis") = 'object'
    AND jsonb_typeof("rahmen") = 'array'
    AND jsonb_typeof("review_aufgaben") = 'array'
    AND ("zeitraum" IS NULL OR jsonb_typeof("zeitraum") = 'object')
  )
);

ALTER TABLE public."risk_los_ziehung" ADD CONSTRAINT "risk_los_ziehung_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES public."tenant"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Los-Liste: neueste Ziehungen eines Tenants (ORDER BY audit_log_id DESC).
CREATE INDEX "risk_los_ziehung_tenant_id_audit_log_id_idx"
  ON public."risk_los_ziehung"("tenant_id", "audit_log_id");

ALTER TABLE public."risk_los_ziehung" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."risk_los_ziehung" FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION app.guard_risk_los_ziehung()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app'
AS $function$
BEGIN
  -- TCMS-SAMPLE-PROOF-001 (Welle 15): Eine Zeile bildet genau ein vorhandenes
  -- Audit-Ereignis risk.los.gezogen desselben Tenants ab, Feld für Feld. Auch die
  -- App-Rolle kann so keine Ziehung ohne Nachweis in der Hash-Chain anlegen.
  IF NOT EXISTS (
    SELECT 1
      FROM public.audit_log a
     CROSS JOIN LATERAL app.risk_los_ziehung_projection(a.after) p
     WHERE a.id = NEW.audit_log_id
       AND a.tenant_id = NEW.tenant_id
       AND a.action = 'risk.los.gezogen'
       AND a.occurred_at = NEW.audit_occurred_at
       AND (p.commitment, p.rahmen_typ, p.nachweis, p.rahmen, p.zeitraum,
            p.review_aufgaben, p.attempt_id, p.job_id)
           IS NOT DISTINCT FROM
           (NEW.commitment, NEW.rahmen_typ, NEW.nachweis, NEW.rahmen, NEW.zeitraum,
            NEW.review_aufgaben, NEW.attempt_id, NEW.job_id)
  ) THEN
    RAISE EXCEPTION 'risk_los_ziehung % bildet kein Audit-Ereignis risk.los.gezogen ab',
      NEW.audit_log_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION app.project_risk_los_ziehung()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app'
AS $function$
BEGIN
  -- TCMS-SAMPLE-PROOF-001 (Welle 15, P-11): Jede Los-Ziehung entsteht als
  -- Audit-Ereignis (Nachweis in der Hash-Chain) und in derselben Transaktion als
  -- Zeile in risk_los_ziehung, aus der die Los-Liste liest. Der Trigger statt
  -- eines zweiten Schreibaufrufs im Code bildet auch Ziehungen eines älteren
  -- Release-Standes ab (Expand/Contract, docs/operations/release.md).
  INSERT INTO public.risk_los_ziehung (
    audit_log_id, tenant_id, audit_occurred_at, commitment, rahmen_typ,
    nachweis, rahmen, zeitraum, review_aufgaben, attempt_id, job_id
  )
  SELECT NEW.id, NEW.tenant_id, NEW.occurred_at, p.commitment, p.rahmen_typ,
         p.nachweis, p.rahmen, p.zeitraum, p.review_aufgaben, p.attempt_id, p.job_id
    FROM app.risk_los_ziehung_projection(NEW.after) p;
  RETURN NULL;
END
$function$;

CREATE OR REPLACE FUNCTION app.risk_los_ziehung_projection(p_after jsonb)
 RETURNS TABLE(commitment text, rahmen_typ text, nachweis jsonb, rahmen jsonb, zeitraum jsonb, review_aufgaben jsonb, attempt_id text, job_id text)
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $function$
  -- TCMS-SAMPLE-PROOF-001 (Welle 15, P-11): fachliche Felder einer Los-Ziehung
  -- aus dem after-Payload des Audit-Ereignisses risk.los.gezogen. Kein Ergebnis,
  -- wenn Nachweis, Commitment, Stichprobe oder Rahmen fehlen; solche Ereignisse
  -- zeigte die Los-Liste schon bisher nicht an.
  SELECT p_after #>> '{nachweis,rahmen,commitment}',
         CASE WHEN p_after ->> 'rahmenTyp' = 'audit' THEN 'audit' ELSE 'subsumtion' END,
         p_after -> 'nachweis',
         p_after -> 'rahmen',
         NULLIF(p_after -> 'zeitraum', 'null'::jsonb),
         COALESCE(NULLIF(p_after -> 'reviewAufgaben', 'null'::jsonb), '[]'::jsonb),
         p_after ->> 'attemptId',
         p_after ->> 'jobId'
   WHERE jsonb_typeof(p_after) = 'object'
     AND jsonb_typeof(p_after -> 'nachweis') = 'object'
     AND jsonb_typeof(p_after #> '{nachweis,rahmen,commitment}') = 'string'
     AND jsonb_typeof(p_after #> '{nachweis,stichprobe}') = 'array'
     AND jsonb_typeof(p_after -> 'rahmen') = 'array'
     AND COALESCE(jsonb_typeof(p_after -> 'zeitraum'), 'null') IN ('object', 'null')
     AND COALESCE(jsonb_typeof(p_after -> 'reviewAufgaben'), 'null') IN ('array', 'null')
$function$;

CREATE TRIGGER risk_los_ziehung_projection AFTER INSERT ON public.audit_log FOR EACH ROW WHEN ((new.action = 'risk.los.gezogen'::text)) EXECUTE FUNCTION app.project_risk_los_ziehung();

CREATE TRIGGER risk_los_ziehung_audit_binding BEFORE INSERT ON public.risk_los_ziehung FOR EACH ROW EXECUTE FUNCTION app.guard_risk_los_ziehung();

CREATE TRIGGER risk_los_ziehung_no_modify BEFORE DELETE OR UPDATE OR TRUNCATE ON public.risk_los_ziehung FOR EACH STATEMENT EXECUTE FUNCTION app.prevent_modification();

CREATE POLICY risk_los_ziehung_isolation ON public.risk_los_ziehung
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((tenant_id = app.current_tenant_id()))
  WITH CHECK ((tenant_id = app.current_tenant_id()));

-- Die Default-Privilegien geben App- und Owner-Rolle auch UPDATE/DELETE; die
-- Tabelle ist unveraenderlich wie audit_log.
REVOKE ALL ON public."risk_los_ziehung" FROM PUBLIC, taxtronik_app, taxtronik_owner;
GRANT SELECT, INSERT ON public."risk_los_ziehung" TO taxtronik_app;
GRANT SELECT, INSERT ON public."risk_los_ziehung" TO taxtronik_owner;

-- Altbestand (idempotent): jede vollstaendige Ziehung aus audit_log genau einmal.
INSERT INTO public."risk_los_ziehung" (
  audit_log_id, tenant_id, audit_occurred_at, commitment, rahmen_typ,
  nachweis, rahmen, zeitraum, review_aufgaben, attempt_id, job_id
)
SELECT a.id, a.tenant_id, a.occurred_at, p.commitment, p.rahmen_typ,
       p.nachweis, p.rahmen, p.zeitraum, p.review_aufgaben, p.attempt_id, p.job_id
  FROM public."audit_log" a
 CROSS JOIN LATERAL app.risk_los_ziehung_projection(a.after) p
 WHERE a.action = 'risk.los.gezogen'
ON CONFLICT ("audit_log_id") DO NOTHING;

DO $risk_los_ziehung_backfill$
DECLARE
  expected BIGINT;
  projected BIGINT;
  total BIGINT;
  skipped BIGINT;
BEGIN
  SELECT count(*) INTO expected
    FROM public."audit_log" a
   CROSS JOIN LATERAL app.risk_los_ziehung_projection(a.after) p
   WHERE a.action = 'risk.los.gezogen';
  SELECT count(*) INTO projected
    FROM public."risk_los_ziehung" z
    JOIN public."audit_log" a
      ON a.id = z.audit_log_id AND a.tenant_id = z.tenant_id AND a.action = 'risk.los.gezogen';
  SELECT count(*) INTO total FROM public."risk_los_ziehung";
  SELECT count(*) INTO skipped
    FROM public."audit_log" a
   WHERE a.action = 'risk.los.gezogen'
     AND NOT EXISTS (SELECT 1 FROM app.risk_los_ziehung_projection(a.after));
  IF projected <> expected OR total <> expected THEN
    RAISE EXCEPTION 'risk_los_ziehung: % von % Ziehungen uebernommen (Tabelle: %)',
      projected, expected, total;
  END IF;
  IF skipped > 0 THEN
    RAISE NOTICE 'risk_los_ziehung: % Ereignisse risk.los.gezogen ohne vollstaendigen Nachweis bleiben nur im Audit-Log',
      skipped;
  END IF;
END
$risk_los_ziehung_backfill$;

COMMIT;
