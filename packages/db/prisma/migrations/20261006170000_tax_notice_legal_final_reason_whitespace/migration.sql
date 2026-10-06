-- TAX-CONTROL-STATUS-001.
--
-- Review-Finding K-05 (Folgepunkt aus dem Kontrollbuch-Umbau). Die Datenbank
-- prüfte die Bestandskraft-Begründung mit btrim() ohne Zeichenliste; das entfernt
-- nur Leerzeichen. Eine Begründung aus Tabs oder Zeilenumbrüchen bestand die
-- Prüfung, die App wertet sie (String.prototype.trim) als leer: Der Bescheid war im
-- Fristenkontrollbuch offen, fehlte aber in „Offen“ und im Tagesabschluss. Die
-- Regel verlangt „eine nachvollziehbare Begründung von mindestens zehn Zeichen“.
--
-- app.legal_final_reason_sufficient entfernt am Rand dieselben Zeichen wie die App
-- und zählt Zeichen; die Kontrollbuch-Vorabfrage nutzt dieselbe Funktion. Für
-- Begründungen, die die App annimmt, ändert sich nichts. Die Constraint bleibt wie
-- bisher NOT VALID (Altbestand); neue und geänderte Zeilen werden geprüft. Bestehende
-- Begründungen ohne zehn sichtbare Zeichen werden nicht verändert, sondern gezählt
-- und als WARNING gemeldet; das Kontrollbuch führt diese Bescheide als offen.
--
-- Erzeugt mit `pnpm db:sql:migration` aus packages/db/prisma/sql
-- (docs/development/kanonische-sql-quellen.md):
--   neu:      functions/app.legal_final_reason_sufficient(text).sql
BEGIN;

CREATE OR REPLACE FUNCTION app.legal_final_reason_sufficient(p_reason text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO 'pg_catalog'
AS $function$
  -- TAX-CONTROL-STATUS-001: Bestandskraft verlangt eine nachvollziehbare
  -- Begründung von mindestens zehn Zeichen. Am Rand entfallen genau die Zeichen,
  -- die String.prototype.trim() in JavaScript entfernt (ECMAScript WhiteSpace
  -- und LineTerminator); length() zählt Zeichen. NULL ist keine Begründung.
  SELECT COALESCE(
    length(
      btrim(
        p_reason,
        E'\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF'
      )
    ) >= 10,
    false
  )
$function$;

ALTER TABLE public."tax_notice"
  DROP CONSTRAINT "tax_notice_legal_final_evidence_check",
  ADD CONSTRAINT "tax_notice_legal_final_evidence_check"
  CHECK (
    (
      "status" = 'BESTANDSKRAEFTIG'::public."tax_notice_status"
      AND "legal_final_at" IS NOT NULL
      AND "legal_final_by" IS NOT NULL
      AND app.legal_final_reason_sufficient("legal_final_reason")
      AND (
        (
          "appeal_filed_at" IS NULL
          AND "deadline_calculation_status" = 'CALCULATED'
          AND NOT "manual_review_required"
          AND "appeal_deadline" IS NOT NULL
          AND "legal_final_at"::date > "appeal_deadline"
          AND "reviewed_at" IS NOT NULL
          AND "reviewed_by" IS NOT NULL
        )
        OR (
          "appeal_filed_at" IS NOT NULL
          AND "appeal_filed_by" IS NOT NULL
          AND (
            "appeal_resolved_at" IS NOT NULL
            OR ("klage_filed_at" IS NOT NULL AND "klage_filed_by" IS NOT NULL)
          )
        )
      )
    )
    OR (
      "status" <> 'BESTANDSKRAEFTIG'::public."tax_notice_status"
      AND "legal_final_reason" IS NULL
    )
  ) NOT VALID;

-- Unter FORCE ROW LEVEL SECURITY sieht nur eine Rolle mit SUPERUSER oder
-- BYPASSRLS den ganzen Bestand; sonst wäre die Zählung ohne Tenant-Kontext 0.
DO $$
DECLARE
  affected bigint;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
     WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
  ) THEN
    SELECT count(*) INTO affected
      FROM public."tax_notice"
     WHERE "status" = 'BESTANDSKRAEFTIG'::public."tax_notice_status"
       AND "legal_final_reason" IS NOT NULL
       AND NOT app.legal_final_reason_sufficient("legal_final_reason");
    IF affected > 0 THEN
      RAISE WARNING 'tax_notice: % bestandskräftige Bescheide mit einer Begründung ohne zehn sichtbare Zeichen; das Fristenkontrollbuch führt sie als offen, eine fachliche Begründung ist nachzutragen.', affected;
    END IF;
  ELSE
    RAISE NOTICE 'tax_notice: Bestandskraft-Begründungen des Altbestands nicht gezählt (Rolle umgeht RLS nicht).';
  END IF;
END
$$;

COMMIT;
