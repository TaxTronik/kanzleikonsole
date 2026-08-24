-- Beweisorientiertes Fristen-/Bekanntgabemodell, getrennte technische
-- Benachrichtigungszustände und dokumentierte tägliche Abschlusskontrolle.
--
-- Die Migration erfindet für Altbestand keine Nachweise: bestehende Fristen
-- bleiben LEGACY_UNVERIFIED, bestehende Auto-Request-Mails UNKNOWN.

-- Prisma legt PostgreSQL-Migrationen nicht verlässlich in eine implizite
-- Transaktion. Rename, Backfills, Constraints, Trigger und RLS-Modell müssen
-- deshalb ausdrücklich atomar wirksam werden oder vollständig zurückrollen.
BEGIN;

-- Verwaltungsakte werden bestandskräftig, nicht rechtskräftig. Das Rename
-- liegt bewusst in derselben transaktionalen Migration wie alle Code-/
-- Constraint-Anpassungen: schlägt ein Altbestands-Backfill fehl, bleibt auch
-- der bisherige Enum-Name für das noch laufende alte App-Binary erhalten.
ALTER TYPE "tax_notice_status"
  RENAME VALUE 'RECHTSKRAEFTIG' TO 'BESTANDSKRAEFTIG';

CREATE TYPE "tax_deadline_notification_status" AS ENUM (
  'NOT_REQUIRED',
  'QUEUED',
  'PROVIDER_ACCEPTED',
  'FAILED',
  'PARTIAL_FAILURE',
  'UNKNOWN',
  'NO_RECIPIENT',
  'ESCALATED',
  'ORPHANED'
);

CREATE TYPE "tax_notice_date_basis" AS ENUM (
  'LEGACY_UNVERIFIED',
  'DISPATCH_DATE',
  'PROVISION_DATE',
  'ACTUAL_ACCESS_DETERMINED',
  'DOCUMENT_DATE_RISK_ONLY'
);

CREATE TYPE "tax_notice_evidence_status" AS ENUM (
  'CLAIMED',
  'SUBSTANTIATED',
  'PROFESSIONALLY_DETERMINED'
);

CREATE TYPE "tax_notice_access_status" AS ENUM (
  'UNCONTESTED',
  'NOT_RECEIVED_DISPUTED',
  'EARLIER_RECEIPT_RECORDED',
  'LATER_RECEIPT_CLAIMED',
  'LATER_RECEIPT_DETERMINED'
);

CREATE TYPE "tax_notice_legal_remedy_instruction_status" AS ENUM (
  'WIRKSAM',
  'UNWIRKSAM',
  'UNKLAR'
);

CREATE TYPE "tax_notice_holiday_context_status" AS ENUM (
  'CONFIRMED_FOR_DATE_AND_LOCATION',
  'STATE_LEVEL_ONLY',
  'HISTORICAL_UNVERIFIED',
  'FOREIGN_UNSUPPORTED',
  'UNKNOWN'
);

CREATE TYPE "tax_notice_deadline_calculation_status" AS ENUM (
  'CALCULATED',
  'MANUAL_REVIEW',
  'RISK_ONLY',
  'LEGACY_UNVERIFIED'
);

CREATE TYPE "tax_notice_retrieval_consent_status" AS ENUM (
  'NOT_APPLICABLE',
  'CONFIRMED',
  'NOT_GIVEN',
  'UNKNOWN'
);

CREATE TYPE "tax_notice_postal_request_status" AS ENUM (
  'NOT_APPLICABLE',
  'NONE_EFFECTIVE',
  'EFFECTIVE',
  'UNKNOWN'
);

CREATE TYPE "tax_notice_retrieval_eligibility_status" AS ENUM (
  'NOT_APPLICABLE',
  'CONFIRMED',
  'NOT_MET',
  'UNKNOWN'
);

CREATE TYPE "tax_notice_delivery_notification_status" AS ENUM (
  'NOT_RECORDED',
  'SENT',
  'FAILED',
  'UNKNOWN'
);

-- ---------------------------------------------------------------------------
-- Automatische Anforderung: Portalobjekt und technischer Versand sind zwei
-- getrennte Zustände. Bestehende Verknüpfungen werden bewusst UNKNOWN.
-- ---------------------------------------------------------------------------

ALTER TABLE public."tax_deadline"
  ADD COLUMN "auto_request_notification_status"
    "tax_deadline_notification_status" NOT NULL DEFAULT 'NOT_REQUIRED',
  ADD COLUMN "auto_request_notification_attempt_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "auto_request_notification_last_attempt_at" TIMESTAMPTZ(6),
  ADD COLUMN "auto_request_notification_next_attempt_at" TIMESTAMPTZ(6),
  ADD COLUMN "auto_request_notification_accepted_at" TIMESTAMPTZ(6),
  ADD COLUMN "auto_request_notification_last_error" TEXT,
  ADD COLUMN "auto_request_notification_escalated_at" TIMESTAMPTZ(6);

UPDATE public."tax_deadline"
   SET "auto_request_notification_status" = 'UNKNOWN',
       "auto_request_notification_last_error" =
         'Altbestand: technischer Benachrichtigungszustand nicht nachweisbar.'
 WHERE "request_id" IS NOT NULL;

CREATE INDEX "tax_deadline_notification_retry_idx"
  ON public."tax_deadline" (
    "tenant_id",
    "auto_request_notification_status",
    "auto_request_notification_next_attempt_at"
  );

ALTER TABLE public."tax_deadline"
  ADD CONSTRAINT "tax_deadline_notification_attempt_check"
  CHECK (
    "auto_request_notification_attempt_count" BETWEEN 0 AND 3
    AND (
      (
        "auto_request_notification_attempt_count" = 0
        AND "auto_request_notification_last_attempt_at" IS NULL
      )
      OR (
        "auto_request_notification_attempt_count" > 0
        AND "auto_request_notification_last_attempt_at" IS NOT NULL
      )
    )
  ),
  ADD CONSTRAINT "tax_deadline_notification_state_check"
  CHECK (
    CASE "auto_request_notification_status"
      WHEN 'NOT_REQUIRED' THEN
        "request_id" IS NULL
        AND "auto_request_notification_attempt_count" = 0
        AND "auto_request_notification_next_attempt_at" IS NULL
        AND "auto_request_notification_accepted_at" IS NULL
        AND "auto_request_notification_last_error" IS NULL
        AND "auto_request_notification_escalated_at" IS NULL
      WHEN 'QUEUED' THEN
        "request_id" IS NOT NULL
        AND "auto_request_notification_attempt_count" = 0
        AND "auto_request_notification_next_attempt_at" IS NOT NULL
        AND "auto_request_notification_accepted_at" IS NULL
        AND "auto_request_notification_last_error" IS NULL
        AND "auto_request_notification_escalated_at" IS NULL
      WHEN 'PROVIDER_ACCEPTED' THEN
        "request_id" IS NOT NULL
        AND "auto_request_notification_attempt_count" BETWEEN 1 AND 3
        AND "auto_request_notification_next_attempt_at" IS NULL
        AND "auto_request_notification_accepted_at" IS NOT NULL
        AND "auto_request_notification_last_error" IS NULL
        AND "auto_request_notification_escalated_at" IS NULL
      WHEN 'FAILED' THEN
        "request_id" IS NOT NULL
        AND "auto_request_notification_attempt_count" BETWEEN 1 AND 2
        AND "auto_request_notification_next_attempt_at" IS NOT NULL
        AND "auto_request_notification_accepted_at" IS NULL
        AND "auto_request_notification_last_error" IS NOT NULL
        AND "auto_request_notification_escalated_at" IS NULL
      WHEN 'PARTIAL_FAILURE' THEN
        "request_id" IS NOT NULL
        AND "auto_request_notification_attempt_count" BETWEEN 1 AND 3
        AND "auto_request_notification_next_attempt_at" IS NULL
        AND "auto_request_notification_accepted_at" IS NULL
        AND "auto_request_notification_last_error" IS NOT NULL
        AND "auto_request_notification_escalated_at" IS NOT NULL
      WHEN 'UNKNOWN' THEN
        "request_id" IS NOT NULL
        AND "auto_request_notification_attempt_count" BETWEEN 0 AND 3
        AND "auto_request_notification_next_attempt_at" IS NULL
        AND "auto_request_notification_accepted_at" IS NULL
        AND "auto_request_notification_last_error" IS NOT NULL
      WHEN 'NO_RECIPIENT' THEN
        "request_id" IS NOT NULL
        AND "auto_request_notification_attempt_count" BETWEEN 1 AND 3
        AND "auto_request_notification_next_attempt_at" IS NULL
        AND "auto_request_notification_accepted_at" IS NULL
        AND "auto_request_notification_last_error" IS NOT NULL
        AND "auto_request_notification_escalated_at" IS NOT NULL
      WHEN 'ESCALATED' THEN
        "request_id" IS NOT NULL
        AND "auto_request_notification_attempt_count" = 3
        AND "auto_request_notification_next_attempt_at" IS NULL
        AND "auto_request_notification_accepted_at" IS NULL
        AND "auto_request_notification_last_error" IS NOT NULL
        AND "auto_request_notification_escalated_at" IS NOT NULL
      WHEN 'ORPHANED' THEN
        "request_id" IS NULL
        AND "auto_request_notification_attempt_count" BETWEEN 0 AND 3
        AND "auto_request_notification_next_attempt_at" IS NULL
        AND "auto_request_notification_last_error" IS NOT NULL
        AND (
          "auto_request_notification_accepted_at" IS NULL
          OR "auto_request_notification_attempt_count" > 0
        )
        AND NOT (
          "auto_request_notification_accepted_at" IS NOT NULL
          AND "auto_request_notification_escalated_at" IS NOT NULL
        )
      ELSE FALSE
    END
  );

-- ON DELETE SET NULL und normale Unlink-Operationen dürfen die technische
-- Versandhistorie nicht löschen. ORPHANED kappt nur die weitere Worker-
-- Verarbeitung und bewahrt Versuchs-, Annahme-, Fehler- und Eskalationsdaten.
-- Ein expliziter, vollständig neutralisierter NOT_REQUIRED-Zustand bleibt dem
-- dokumentierten DSGVO-Purge vorbehalten und wird vom Trigger respektiert.
CREATE OR REPLACE FUNCTION app.tax_deadline_guard_notification_history()
RETURNS TRIGGER AS $$
DECLARE
  purge_authorized BOOLEAN;
BEGIN
  -- Custom GUCs sind für jede Session frei setzbar und deshalb allein keine
  -- Autorisierung. Der Purge ist nur über dieselbe Owner-Rolle möglich, der
  -- auch die Tabelle gehört; der Runtime-User kann die Freigabe nicht imitieren.
  purge_authorized :=
    COALESCE(
      current_setting('app.tax_deadline_notification_purge', true),
      ''
    ) = 'on'
    AND current_user = pg_catalog.pg_get_userbyid(
      (
        SELECT relation.relowner
          FROM pg_catalog.pg_class relation
         WHERE relation.oid = 'public.tax_deadline'::regclass
      )
    );

  -- Ein bereits verwaister Historieneintrag ist unveränderlich. Nur derselbe
  -- explizit autorisierte Purge wie beim Request-Delete darf ihn vollständig
  -- neutralisieren; gewöhnliche Updates anderer Deadline-Felder bleiben
  -- möglich, weil der Trigger nur auf die technischen Spalten reagiert.
  IF OLD.auto_request_notification_status = 'ORPHANED' THEN
    IF purge_authorized
       AND NEW.request_id IS NULL
       AND NEW.auto_request_notification_status = 'NOT_REQUIRED'
       AND NEW.auto_request_notification_attempt_count = 0
       AND NEW.auto_request_notification_last_attempt_at IS NULL
       AND NEW.auto_request_notification_next_attempt_at IS NULL
       AND NEW.auto_request_notification_accepted_at IS NULL
       AND NEW.auto_request_notification_last_error IS NULL
       AND NEW.auto_request_notification_escalated_at IS NULL THEN
      RETURN NEW;
    END IF;

    IF ROW(
         NEW.request_id,
         NEW.auto_request_notification_status,
         NEW.auto_request_notification_attempt_count,
         NEW.auto_request_notification_last_attempt_at,
         NEW.auto_request_notification_next_attempt_at,
         NEW.auto_request_notification_accepted_at,
         NEW.auto_request_notification_last_error,
         NEW.auto_request_notification_escalated_at
       ) IS DISTINCT FROM ROW(
         OLD.request_id,
         OLD.auto_request_notification_status,
         OLD.auto_request_notification_attempt_count,
         OLD.auto_request_notification_last_attempt_at,
         OLD.auto_request_notification_next_attempt_at,
         OLD.auto_request_notification_accepted_at,
         OLD.auto_request_notification_last_error,
         OLD.auto_request_notification_escalated_at
       ) THEN
      RAISE EXCEPTION
        'Orphaned tax deadline notification history is immutable'
        USING ERRCODE = '23514',
              CONSTRAINT = 'tax_deadline_notification_orphaned_immutable_check';
    END IF;

    RETURN NEW;
  END IF;

  IF OLD.request_id IS NOT NULL AND NEW.request_id IS NULL THEN
    -- Zwischen persistiertem Claim und eindeutigem Versandabschluss bleibt
    -- die Request-Verknüpfung gesperrt. Andernfalls könnte der externe Versand
    -- nach einem bereits committeten Unlink/Purge und damit ohne belastbare
    -- Historie erfolgen. Ein abgestürzter Claim wird vom Worker eskaliert und
    -- ist danach wieder explizit bearbeitbar.
    IF OLD.auto_request_notification_status = 'UNKNOWN'
       AND OLD.auto_request_notification_attempt_count > 0
       AND OLD.auto_request_notification_last_attempt_at IS NOT NULL
       AND OLD.auto_request_notification_escalated_at IS NULL THEN
      RAISE EXCEPTION
        'Tax deadline notification attempt is in flight; request unlink is blocked'
        USING ERRCODE = '23514',
              CONSTRAINT = 'tax_deadline_notification_unlink_in_flight_check';
    END IF;

    IF purge_authorized THEN
      IF NEW.auto_request_notification_status = 'NOT_REQUIRED'
         AND NEW.auto_request_notification_attempt_count = 0
         AND NEW.auto_request_notification_last_attempt_at IS NULL
         AND NEW.auto_request_notification_next_attempt_at IS NULL
         AND NEW.auto_request_notification_accepted_at IS NULL
         AND NEW.auto_request_notification_last_error IS NULL
         AND NEW.auto_request_notification_escalated_at IS NULL THEN
        RETURN NEW;
      END IF;

      RAISE EXCEPTION
        'Authorized tax deadline notification purge must clear all technical metadata'
        USING ERRCODE = '23514',
              CONSTRAINT = 'tax_deadline_notification_purge_shape_check';
    END IF;

    -- Reguläre Unlinks dürfen über NEW keine Historie umschreiben. Nur der
    -- Scheduler-Zeitpunkt wird entfernt, damit ORPHANED nie versendet wird.
    NEW.auto_request_notification_status := 'ORPHANED';
    NEW.auto_request_notification_attempt_count :=
      OLD.auto_request_notification_attempt_count;
    NEW.auto_request_notification_last_attempt_at :=
      OLD.auto_request_notification_last_attempt_at;
    NEW.auto_request_notification_next_attempt_at := NULL;
    NEW.auto_request_notification_accepted_at :=
      OLD.auto_request_notification_accepted_at;
    NEW.auto_request_notification_escalated_at :=
      OLD.auto_request_notification_escalated_at;
    NEW.auto_request_notification_last_error := concat_ws(
      ' ',
      NULLIF(OLD.auto_request_notification_last_error, ''),
      format(
        'Request-Verknüpfung aufgehoben; vorheriger Benachrichtigungsstatus: %s.',
        OLD.auto_request_notification_status
      )
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER FUNCTION app.tax_deadline_guard_notification_history()
  SET search_path = pg_catalog, public, pg_temp;

CREATE TRIGGER tax_deadline_guard_notification_history_trigger
  BEFORE UPDATE OF
    "request_id",
    "auto_request_notification_status",
    "auto_request_notification_attempt_count",
    "auto_request_notification_last_attempt_at",
    "auto_request_notification_next_attempt_at",
    "auto_request_notification_accepted_at",
    "auto_request_notification_last_error",
    "auto_request_notification_escalated_at"
  ON public."tax_deadline"
  FOR EACH ROW EXECUTE FUNCTION app.tax_deadline_guard_notification_history();

-- Der Worker löst nach einem fachlich terminalen Request nur den technischen
-- Versandpointer. Request.tax_deadline_id bleibt als Herkunftsnachweis bestehen.
-- Diese eine Asymmetrie ist zulässig; aktive Requests und alle anderen
-- technischen Zustände bleiben weiterhin strikt bidirektional gebunden.
CREATE OR REPLACE FUNCTION public.enforce_tax_deadline_request_link()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  current_deadline public."tax_deadline"%ROWTYPE;
  current_request public."request"%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'tax_deadline' THEN
    -- Deferred Trigger müssen den finalen Zeilenzustand erneut lesen: dieselbe
    -- Transaktion kann nach dem auslösenden UPDATE noch die Gegenseite ändern
    -- oder die Zeile löschen (z. B. FK-SET-NULL bei Neu-Materialisierung).
    SELECT * INTO current_deadline
      FROM public."tax_deadline" deadline
     WHERE deadline.id = NEW.id;
    IF NOT FOUND THEN
      RETURN NEW;
    END IF;

    IF current_deadline.request_id IS NULL THEN
      IF EXISTS (
        SELECT 1
          FROM public."request" request_row
         WHERE request_row.tax_deadline_id = current_deadline.id
           AND NOT (
             current_deadline.auto_request_notification_status = 'ORPHANED'
             AND request_row.status IN ('RESPONDED', 'CLOSED', 'CANCELLED')
             AND request_row.tenant_id = current_deadline.tenant_id
             AND request_row.client_id = current_deadline.client_id
           )
      ) THEN
        RAISE EXCEPTION
          'tax_deadline/request pointer mismatch for deadline %',
          current_deadline.id;
      END IF;
    ELSE
      IF NOT EXISTS (
        SELECT 1
          FROM public."request" request_row
         WHERE request_row.id = current_deadline.request_id
           AND request_row.tax_deadline_id = current_deadline.id
           AND request_row.tenant_id = current_deadline.tenant_id
           AND request_row.client_id = current_deadline.client_id
      ) THEN
        RAISE EXCEPTION
          'tax_deadline/request pointer mismatch for deadline %',
          current_deadline.id;
      END IF;
    END IF;
  ELSE
    SELECT * INTO current_request
      FROM public."request" request_row
     WHERE request_row.id = NEW.id;
    IF NOT FOUND THEN
      RETURN NEW;
    END IF;

    IF current_request.tax_deadline_id IS NULL THEN
      IF EXISTS (
        SELECT 1
          FROM public."tax_deadline" deadline
         WHERE deadline.request_id = current_request.id
      ) THEN
        RAISE EXCEPTION
          'request/tax_deadline pointer mismatch for request %',
          current_request.id;
      END IF;
    ELSE
      IF NOT EXISTS (
        SELECT 1
          FROM public."tax_deadline" deadline
         WHERE deadline.id = current_request.tax_deadline_id
           AND deadline.tenant_id = current_request.tenant_id
           AND deadline.client_id = current_request.client_id
           AND (
             deadline.request_id = current_request.id
             OR (
               deadline.request_id IS NULL
               AND deadline.auto_request_notification_status = 'ORPHANED'
               AND current_request.status IN ('RESPONDED', 'CLOSED', 'CANCELLED')
             )
           )
      ) THEN
        RAISE EXCEPTION
          'request/tax_deadline pointer mismatch for request %',
          current_request.id;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Statusänderungen auf der Request-Seite und technische Statusänderungen auf
-- der Deadline-Seite können die eng erlaubte Asymmetrie wieder unzulässig
-- machen und müssen deshalb ebenfalls deferred am Transaktionsende geprüft
-- werden.
DROP TRIGGER IF EXISTS "tax_deadline_request_consistency" ON public."tax_deadline";
CREATE CONSTRAINT TRIGGER "tax_deadline_request_consistency"
AFTER INSERT OR UPDATE OF
  "request_id",
  "tenant_id",
  "client_id",
  "auto_request_notification_status"
ON public."tax_deadline"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.enforce_tax_deadline_request_link();

DROP TRIGGER IF EXISTS "request_tax_deadline_consistency" ON public."request";
CREATE CONSTRAINT TRIGGER "request_tax_deadline_consistency"
AFTER INSERT OR UPDATE OF "tax_deadline_id", "tenant_id", "client_id", "status"
ON public."request"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.enforce_tax_deadline_request_link();

-- Bei einer fristverschiebenden Neu-Materialisierung darf der operative Termin
-- verschwinden, nicht aber sein technischer Benachrichtigungsnachweis. Der
-- minimale, mandantenisolierte Snapshot enthält keine Namen oder Titel und ist
-- für die App unveränderbar. Ein laufender UNKNOWN-Claim bleibt dagegen auch
-- vor DELETE gesperrt: gewinnt der Delete zuerst, scheitert der Worker-CAS;
-- gewinnt der Claim zuerst, wartet der Delete und wird danach abgewiesen.
CREATE TABLE public."tax_deadline_notification_history" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "original_deadline_id" UUID NOT NULL,
  "request_id" UUID NOT NULL,
  "notification_status" public."tax_deadline_notification_status" NOT NULL,
  "notification_attempt_count" INTEGER NOT NULL,
  "notification_last_attempt_at" TIMESTAMPTZ(6),
  "notification_next_attempt_at" TIMESTAMPTZ(6),
  "notification_accepted_at" TIMESTAMPTZ(6),
  "notification_error_recorded" BOOLEAN NOT NULL,
  "notification_last_error_sha256" BYTEA,
  "notification_escalated_at" TIMESTAMPTZ(6),
  "archive_reason" TEXT NOT NULL,
  "archived_at" TIMESTAMPTZ(6) NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT "tax_deadline_notification_history_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tax_deadline_notification_history_deadline_key"
    UNIQUE ("original_deadline_id"),
  CONSTRAINT "tax_deadline_notification_history_tenant_fk"
    FOREIGN KEY ("tenant_id") REFERENCES public."tenant"("id")
    ON DELETE CASCADE ON UPDATE NO ACTION,
  -- Der operative Request bleibt die pseudonyme Herkunft und bestimmt zugleich
  -- die maximale Lebensdauer dieses technischen Hilfsnachweises. Der
  -- Retention-Worker löscht zusätzlich unabhängig davon nach spätestens einem
  -- Jahr ab archived_at; ein früherer Request-Purge entfernt den Nachweis mit.
  CONSTRAINT "tax_deadline_notification_history_request_fk"
    FOREIGN KEY ("request_id") REFERENCES public."request"("id")
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "tax_deadline_notification_history_attempt_check"
    CHECK ("notification_attempt_count" BETWEEN 0 AND 3),
  CONSTRAINT "tax_deadline_notification_history_error_digest_check"
    CHECK (
      "notification_error_recorded"
        = ("notification_last_error_sha256" IS NOT NULL)
      AND (
        "notification_last_error_sha256" IS NULL
        OR octet_length("notification_last_error_sha256") = 32
      )
    ),
  CONSTRAINT "tax_deadline_notification_history_reason_check"
    CHECK (
      "archive_reason" IN (
        'ORPHANED_DEADLINE_REMOVED',
        'TERMINAL_REQUEST_DEADLINE_REMOVED'
      )
    )
);

CREATE INDEX "tax_deadline_notification_history_tenant_archived_idx"
  ON public."tax_deadline_notification_history" ("tenant_id", "archived_at" DESC);
CREATE INDEX "tax_deadline_notification_history_request_idx"
  ON public."tax_deadline_notification_history" ("tenant_id", "request_id");

CREATE OR REPLACE FUNCTION app.tax_deadline_archive_notification_before_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app, pg_temp
AS $$
DECLARE
  historical_request_id UUID := OLD.request_id;
  historical_request_status public."request_status";
BEGIN
  IF OLD.auto_request_notification_status = 'UNKNOWN'
     AND OLD.auto_request_notification_attempt_count > 0
     AND OLD.auto_request_notification_last_attempt_at IS NOT NULL
     AND OLD.auto_request_notification_escalated_at IS NULL THEN
    RAISE EXCEPTION
      'Tax deadline notification attempt is in flight; deadline delete is blocked'
      USING ERRCODE = '23514',
            CONSTRAINT = 'tax_deadline_notification_delete_in_flight_check';
  END IF;

  -- Beim expliziten Tenant-Purge gibt es keinen fortbestehenden fachlichen
  -- Bezug, an den ein Hilfsnachweis gebunden werden könnte. PostgreSQL hat die
  -- Parent-Zeile vor den FK-Cascades bereits entfernt. Ein UNKNOWN-Claim bleibt
  -- durch die vorstehende Prüfung trotzdem auch bei diesem Delete gesperrt.
  IF NOT EXISTS (
    SELECT 1
      FROM public."tenant" tenant_row
     WHERE tenant_row.id = OLD.tenant_id
  ) THEN
    RETURN OLD;
  END IF;

  IF OLD.auto_request_notification_status = 'NOT_REQUIRED' THEN
    RETURN OLD;
  END IF;

  IF historical_request_id IS NULL THEN
    SELECT request_row.id, request_row.status
      INTO historical_request_id, historical_request_status
      FROM public."request" request_row
     WHERE request_row.tax_deadline_id = OLD.id;
  ELSE
    SELECT request_row.status
      INTO historical_request_status
      FROM public."request" request_row
     WHERE request_row.id = historical_request_id
       AND request_row.tax_deadline_id = OLD.id
       AND request_row.tenant_id = OLD.tenant_id
       AND request_row.client_id = OLD.client_id;
  END IF;

  IF historical_request_id IS NULL
     OR COALESCE(historical_request_status::TEXT, '')
       NOT IN ('RESPONDED', 'CLOSED', 'CANCELLED') THEN
    RAISE EXCEPTION
      'Tax deadline notification history requires a terminal request before deadline delete'
      USING ERRCODE = '23514',
            CONSTRAINT = 'tax_deadline_notification_delete_request_terminal_check';
  END IF;

  INSERT INTO public."tax_deadline_notification_history" (
    "tenant_id",
    "original_deadline_id",
    "request_id",
    "notification_status",
    "notification_attempt_count",
    "notification_last_attempt_at",
    "notification_next_attempt_at",
    "notification_accepted_at",
    "notification_error_recorded",
    "notification_last_error_sha256",
    "notification_escalated_at",
    "archive_reason"
  ) VALUES (
    OLD.tenant_id,
    OLD.id,
    historical_request_id,
    OLD.auto_request_notification_status,
    OLD.auto_request_notification_attempt_count,
    OLD.auto_request_notification_last_attempt_at,
    OLD.auto_request_notification_next_attempt_at,
    OLD.auto_request_notification_accepted_at,
    OLD.auto_request_notification_last_error IS NOT NULL,
    CASE
      WHEN OLD.auto_request_notification_last_error IS NULL THEN NULL
      ELSE digest(OLD.auto_request_notification_last_error, 'sha256')
    END,
    OLD.auto_request_notification_escalated_at,
    CASE
      WHEN OLD.auto_request_notification_status = 'ORPHANED'
        THEN 'ORPHANED_DEADLINE_REMOVED'
      ELSE 'TERMINAL_REQUEST_DEADLINE_REMOVED'
    END
  );

  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION app.tax_deadline_archive_notification_before_delete() FROM PUBLIC;

CREATE TRIGGER tax_deadline_archive_notification_before_delete_trigger
  BEFORE DELETE ON public."tax_deadline"
  FOR EACH ROW EXECUTE FUNCTION app.tax_deadline_archive_notification_before_delete();

ALTER TABLE public."tax_deadline_notification_history" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."tax_deadline_notification_history" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tax_deadline_notification_history_select"
  ON public."tax_deadline_notification_history"
  FOR SELECT
  USING (
    "tenant_id" = app.current_tenant_id()
    AND app.current_actor_type() = 'STAFF'
    AND EXISTS (
      SELECT 1
        FROM public."staff_user" staff
        JOIN public."staff_role" role
          ON role.staff_user_id = staff.id
       WHERE staff.id = app.current_actor_id()
         AND staff.tenant_id = "tax_deadline_notification_history"."tenant_id"
         AND staff.active = TRUE
         AND role.role IN ('ADMIN', 'PARTNER')
    )
  );

-- Kein Anwendungs-Caller benötigt diesen internen Retention-Nachweis. Die
-- Policy bleibt als Defense-in-Depth für einen später bewusst eingeführten
-- Adminpfad; ohne Tabellenprivileg ist auch sie nicht erreichbar.
REVOKE ALL ON public."tax_deadline_notification_history" FROM taxtronik_app;

-- ---------------------------------------------------------------------------
-- Bescheid/Bekanntgabe: Ausgangstatsache, Nachweis, Bekanntgabetag,
-- Feiertagsorte und Ergebnisstatus bleiben einzeln reproduzierbar.
-- ---------------------------------------------------------------------------

ALTER TABLE public."tax_notice"
  ADD COLUMN "date_basis" "tax_notice_date_basis"
    NOT NULL DEFAULT 'LEGACY_UNVERIFIED',
  ADD COLUMN "delivery_evidence_status" "tax_notice_evidence_status"
    NOT NULL DEFAULT 'CLAIMED',
  ADD COLUMN "delivery_evidence_note" TEXT,
  ADD COLUMN "legal_remedy_instruction_status"
    "tax_notice_legal_remedy_instruction_status" NOT NULL DEFAULT 'UNKLAR',
  ADD COLUMN "legal_remedy_instruction_note" TEXT,
  ADD COLUMN "access_status" "tax_notice_access_status"
    NOT NULL DEFAULT 'UNCONTESTED',
  ADD COLUMN "access_evidence_status" "tax_notice_evidence_status",
  ADD COLUMN "access_evidence_note" TEXT,
  ADD COLUMN "recipient_name" TEXT,
  ADD COLUMN "recipient_country_code" VARCHAR(2) NOT NULL DEFAULT 'ZZ',
  ADD COLUMN "recipient_region" TEXT,
  ADD COLUMN "recipient_locality" TEXT,
  ADD COLUMN "recipient_local_holiday_dates" DATE[] NOT NULL DEFAULT '{}',
  ADD COLUMN "recipient_bavaria_assumption_applies" BOOLEAN,
  ADD COLUMN "authority_name" TEXT,
  ADD COLUMN "authority_country_code" VARCHAR(2) NOT NULL DEFAULT 'DE',
  ADD COLUMN "authority_region" TEXT,
  ADD COLUMN "authority_locality" TEXT,
  ADD COLUMN "authority_local_holiday_dates" DATE[] NOT NULL DEFAULT '{}',
  ADD COLUMN "authority_bavaria_assumption_applies" BOOLEAN,
  ADD COLUMN "recipient_holiday_context_status" "tax_notice_holiday_context_status"
    NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "authority_holiday_context_status" "tax_notice_holiday_context_status"
    NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "holiday_context_note" TEXT,
  ADD COLUMN "retrieval_consent_status" "tax_notice_retrieval_consent_status"
    NOT NULL DEFAULT 'NOT_APPLICABLE',
  ADD COLUMN "retrieval_postal_request_status" "tax_notice_postal_request_status"
    NOT NULL DEFAULT 'NOT_APPLICABLE',
  ADD COLUMN "retrieval_postal_request_received_at" DATE,
  ADD COLUMN "retrieval_eligibility_2027_status"
    "tax_notice_retrieval_eligibility_status" NOT NULL DEFAULT 'NOT_APPLICABLE',
  ADD COLUMN "retrieval_notification_status"
    "tax_notice_delivery_notification_status" NOT NULL DEFAULT 'NOT_RECORDED',
  ADD COLUMN "retrieval_reinstatement_review_required" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "calculated_notification_date" DATE,
  ADD COLUMN "internal_risk_deadline" DATE,
  ADD COLUMN "alternative_claimed_access_deadline" DATE,
  ADD COLUMN "deadline_calculation_status"
    "tax_notice_deadline_calculation_status" NOT NULL DEFAULT 'LEGACY_UNVERIFIED',
  ADD COLUMN "deadline_calculation_version" TEXT,
  ADD COLUMN "manual_review_required" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "manual_review_reason" TEXT,
  ADD COLUMN "partial_relief_received_at" DATE,
  ADD COLUMN "partial_relief_received_by" UUID,
  ADD COLUMN "legal_final_reason" TEXT;

-- NOT-VALID-Constraints schützen neue/aktualisierte Zeilen, dürfen aber einen
-- konservativen Metadaten-Backfill auf bereits vorhandenem, gerade deshalb
-- noch nicht validiertem Altbestand nicht blockieren. Sie werden anschließend
-- mit der neuen Semantik wieder angelegt. Der Status-Backfill ist eine reine
-- Re-Klassifikation und darf ebenso wenig den operativen Progress-Trigger
-- auslösen.
ALTER TABLE public."tax_notice"
  DROP CONSTRAINT IF EXISTS "tax_notice_notification_evidence_check",
  DROP CONSTRAINT IF EXISTS "tax_notice_decision_deadline_check",
  DROP CONSTRAINT IF EXISTS "tax_notice_appeal_filing_evidence_check",
  DROP CONSTRAINT IF EXISTS "tax_notice_court_filing_evidence_check",
  DROP CONSTRAINT IF EXISTS "tax_notice_legal_final_evidence_check",
  DROP CONSTRAINT IF EXISTS "tax_notice_event_sequence_check";

ALTER TABLE public."tax_notice"
  DISABLE TRIGGER tax_notice_progress_evidence_trigger;

-- Die alte UI verwendete TEILABHILFE ausdrücklich auch für eine
-- Einspruchsentscheidung. Nur Datensätze mit der vollständigen damaligen
-- Entscheidungs-/Klagefristkette werden in den neuen, eindeutigen Status
-- überführt. Für die verbleibenden Teilabhilfen kennt der Altbestand weder
-- einen eindeutig bezeichneten Bekanntgabetag noch die dokumentierende Person.
-- Sie bleiben als historische Teilabhilfen erhalten. Der Paar-Constraint
-- verhindert halbe Nachweise; der spätere Guard verlangt das vollständige Paar
-- bei Neuanlage bzw. Eintritt in TEILABHILFE. Vor dem nächsten Fortschritt
-- fordert der Bedienpfad den Bekanntgabetag ausdrücklich aus der Akte an; die
-- aktuell bestätigende Person wird dabei gespeichert.
UPDATE public."tax_notice"
   SET "status" = 'TEILEINSPRUCHSENTSCHEIDUNG'::public."tax_notice_status",
       "manual_review_reason" =
         'Migrierter Altbestand: Umfang der Teil-Einspruchsentscheidung fachlich prüfen.'
 WHERE "status" = 'TEILABHILFE'::public."tax_notice_status"
   AND "appeal_decision_received_at" IS NOT NULL
   AND "klage_deadline" IS NOT NULL;

ALTER TABLE public."tax_notice"
  ENABLE TRIGGER tax_notice_progress_evidence_trigger;

UPDATE public."tax_notice"
   SET "retrieval_consent_status" =
         CASE
           WHEN "delivery_method" = 'DATA_RETRIEVAL'
            AND "retrieval_issued_at" >= DATE '2026-01-01'
            AND "retrieval_issued_at" < DATE '2027-01-01'
             THEN 'UNKNOWN'::public."tax_notice_retrieval_consent_status"
           ELSE 'NOT_APPLICABLE'::public."tax_notice_retrieval_consent_status"
         END,
       "retrieval_postal_request_status" =
         CASE
           WHEN "delivery_method" = 'DATA_RETRIEVAL'
            AND "retrieval_issued_at" >= DATE '2027-01-01'
             THEN 'UNKNOWN'::public."tax_notice_postal_request_status"
           ELSE 'NOT_APPLICABLE'::public."tax_notice_postal_request_status"
         END,
       "retrieval_eligibility_2027_status" =
         CASE
           WHEN "delivery_method" = 'DATA_RETRIEVAL'
            AND "retrieval_issued_at" >= DATE '2027-01-01'
             THEN 'UNKNOWN'::public."tax_notice_retrieval_eligibility_status"
           ELSE 'NOT_APPLICABLE'::public."tax_notice_retrieval_eligibility_status"
         END,
       "retrieval_notification_status" =
         CASE
           WHEN "delivery_method" = 'DATA_RETRIEVAL'
            AND "retrieval_notification_disputed_or_late"
             THEN 'UNKNOWN'::public."tax_notice_delivery_notification_status"
           WHEN "delivery_method" = 'DATA_RETRIEVAL'
            AND "retrieval_notification_date" IS NOT NULL
             THEN 'SENT'::public."tax_notice_delivery_notification_status"
           ELSE 'NOT_RECORDED'::public."tax_notice_delivery_notification_status"
         END,
       "manual_review_reason" = concat_ws(
         E'\n',
         NULLIF("manual_review_reason", ''),
         'Altbestand: Datum, Nachweis, Belehrung und Feiertagsorte sind nicht strukturiert freigegeben.'
       );

-- Der Legacy-Marker stammt ausschließlich aus dem historischen Backfill. Solange
-- er gesetzt bleibt, dürfen weder die damals bewahrte Altfrist noch neue
-- fristrelevante Tatsachen scheinbar verifiziert werden. Sachfremde Angaben und
-- erläuternde Notizen bleiben änderbar; eine fachliche Korrektur muss den Marker
-- im selben UPDATE entfernen und anschließend alle neuen Constraints erfüllen.
CREATE OR REPLACE FUNCTION app.tax_notice_guard_retrieval_legacy_fallback()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.retrieval_notification_legacy_fallback THEN
    RAISE EXCEPTION 'retrieval_notification_legacy_fallback is reserved for migrated records';
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.retrieval_notification_legacy_fallback
     AND NOT OLD.retrieval_notification_legacy_fallback THEN
    RAISE EXCEPTION 'retrieval_notification_legacy_fallback is reserved for migrated records';
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.retrieval_notification_legacy_fallback
     AND NEW.retrieval_notification_legacy_fallback
     AND (
       NEW.notice_date IS DISTINCT FROM OLD.notice_date
       OR NEW.received_at IS DISTINCT FROM OLD.received_at
       OR NEW.delivery_method IS DISTINCT FROM OLD.delivery_method
       OR NEW.date_basis IS DISTINCT FROM OLD.date_basis
       OR NEW.delivery_evidence_status IS DISTINCT FROM OLD.delivery_evidence_status
       OR NEW.legal_remedy_instruction_valid IS DISTINCT FROM OLD.legal_remedy_instruction_valid
       OR NEW.legal_remedy_instruction_status IS DISTINCT FROM OLD.legal_remedy_instruction_status
       OR NEW.access_status IS DISTINCT FROM OLD.access_status
       OR NEW.access_evidence_status IS DISTINCT FROM OLD.access_evidence_status
       OR NEW.recipient_name IS DISTINCT FROM OLD.recipient_name
       OR NEW.recipient_country_code IS DISTINCT FROM OLD.recipient_country_code
       OR NEW.recipient_region IS DISTINCT FROM OLD.recipient_region
       OR NEW.recipient_locality IS DISTINCT FROM OLD.recipient_locality
       OR NEW.recipient_local_holiday_dates IS DISTINCT FROM OLD.recipient_local_holiday_dates
       OR NEW.recipient_bavaria_assumption_applies IS DISTINCT FROM OLD.recipient_bavaria_assumption_applies
       OR NEW.authority_name IS DISTINCT FROM OLD.authority_name
       OR NEW.authority_country_code IS DISTINCT FROM OLD.authority_country_code
       OR NEW.authority_region IS DISTINCT FROM OLD.authority_region
       OR NEW.authority_locality IS DISTINCT FROM OLD.authority_locality
       OR NEW.authority_local_holiday_dates IS DISTINCT FROM OLD.authority_local_holiday_dates
       OR NEW.authority_bavaria_assumption_applies IS DISTINCT FROM OLD.authority_bavaria_assumption_applies
       OR NEW.recipient_holiday_context_status IS DISTINCT FROM OLD.recipient_holiday_context_status
       OR NEW.authority_holiday_context_status IS DISTINCT FROM OLD.authority_holiday_context_status
       OR NEW.retrieval_issued_at IS DISTINCT FROM OLD.retrieval_issued_at
       OR NEW.retrieval_notification_date IS DISTINCT FROM OLD.retrieval_notification_date
       OR NEW.retrieval_notification_disputed_or_late IS DISTINCT FROM OLD.retrieval_notification_disputed_or_late
       OR NEW.retrieved_at IS DISTINCT FROM OLD.retrieved_at
       OR NEW.retrieval_consent_status IS DISTINCT FROM OLD.retrieval_consent_status
       OR NEW.retrieval_postal_request_status IS DISTINCT FROM OLD.retrieval_postal_request_status
       OR NEW.retrieval_postal_request_received_at IS DISTINCT FROM OLD.retrieval_postal_request_received_at
       OR NEW.retrieval_eligibility_2027_status IS DISTINCT FROM OLD.retrieval_eligibility_2027_status
       OR NEW.retrieval_notification_status IS DISTINCT FROM OLD.retrieval_notification_status
       OR NEW.retrieval_reinstatement_review_required IS DISTINCT FROM OLD.retrieval_reinstatement_review_required
       OR NEW.calculated_notification_date IS DISTINCT FROM OLD.calculated_notification_date
       OR NEW.appeal_deadline IS DISTINCT FROM OLD.appeal_deadline
       OR NEW.internal_risk_deadline IS DISTINCT FROM OLD.internal_risk_deadline
       OR NEW.alternative_claimed_access_deadline IS DISTINCT FROM OLD.alternative_claimed_access_deadline
       OR NEW.deadline_calculation_status IS DISTINCT FROM OLD.deadline_calculation_status
       OR NEW.deadline_calculation_version IS DISTINCT FROM OLD.deadline_calculation_version
       OR NEW.manual_review_required IS DISTINCT FROM OLD.manual_review_required
     ) THEN
    RAISE EXCEPTION
      'legacy data-retrieval facts and preserved deadline are immutable until the fallback marker is removed';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER FUNCTION app.tax_notice_guard_retrieval_legacy_fallback()
  SET search_path = pg_catalog, public, pg_temp;

DROP TRIGGER IF EXISTS tax_notice_00_retrieval_legacy_fallback_guard
  ON public."tax_notice";
CREATE TRIGGER tax_notice_00_retrieval_legacy_fallback_guard
  BEFORE INSERT OR UPDATE ON public."tax_notice"
  FOR EACH ROW EXECUTE FUNCTION app.tax_notice_guard_retrieval_legacy_fallback();

ALTER TABLE public."tax_notice"
  ADD CONSTRAINT "tax_notice_region_code_check"
  CHECK (
    "recipient_country_code" ~ '^[A-Z]{2}$'
    AND "authority_country_code" ~ '^[A-Z]{2}$'
    AND
    ("recipient_region" IS NULL OR "recipient_region" IN (
      'DE-BW','DE-BY','DE-BE','DE-BB','DE-HB','DE-HH','DE-HE','DE-MV',
      'DE-NI','DE-NW','DE-RP','DE-SL','DE-SN','DE-ST','DE-SH','DE-TH'
    ))
    AND
    ("authority_region" IS NULL OR "authority_region" IN (
      'DE-BW','DE-BY','DE-BE','DE-BB','DE-HB','DE-HH','DE-HE','DE-MV',
      'DE-NI','DE-NW','DE-RP','DE-SL','DE-SN','DE-ST','DE-SH','DE-TH'
    ))
    AND ("recipient_country_code" = 'DE' OR "recipient_region" IS NULL)
    AND ("authority_country_code" = 'DE' OR "authority_region" IS NULL)
    AND (
      "recipient_holiday_context_status" <> 'CONFIRMED_FOR_DATE_AND_LOCATION'
      OR (
        "recipient_country_code" = 'DE'
        AND "recipient_region" IS NOT NULL
        AND length(btrim(COALESCE("recipient_locality", ''))) >= 2
        AND ("recipient_region" <> 'DE-BY'
          OR "recipient_bavaria_assumption_applies" IS NOT NULL)
      )
    )
    AND (
      "authority_holiday_context_status" <> 'CONFIRMED_FOR_DATE_AND_LOCATION'
      OR (
        "authority_country_code" = 'DE'
        AND "authority_region" IS NOT NULL
        AND length(btrim(COALESCE("authority_locality", ''))) >= 2
        AND ("authority_region" <> 'DE-BY'
          OR "authority_bavaria_assumption_applies" IS NOT NULL)
      )
    )
    AND (
      "recipient_holiday_context_status" <> 'CONFIRMED_FOR_DATE_AND_LOCATION'
      AND "authority_holiday_context_status" <> 'CONFIRMED_FOR_DATE_AND_LOCATION'
      OR length(btrim(COALESCE("holiday_context_note", ''))) >= 3
    )
  ) NOT VALID,
  ADD CONSTRAINT "tax_notice_notification_evidence_check"
  CHECK (
    (
      "delivery_method" IN ('POST', 'POST_ABROAD', 'ELECTRONIC', 'DATA_RETRIEVAL')
      OR "received_at" IS NOT NULL
    )
    AND ("received_at" IS NULL OR "received_at" >= "notice_date")
    -- Bei ACTUAL_ACCESS_DETERMINED bezeichnen beide Felder denselben fachlich
    -- festgestellten Zugangstag. Abweichende Doppelwahrheiten sind unzulässig;
    -- die Engine verwendet nicht heimlich nur eines der beiden Daten.
    AND (
      "date_basis" <> 'ACTUAL_ACCESS_DETERMINED'
      OR "received_at" = "notice_date"
    )
    AND (
      "delivery_method" <> 'DATA_RETRIEVAL'
      OR (
        "received_at" IS NULL
        AND ("retrieval_notification_date" IS NULL
          OR "retrieval_notification_date" >= "notice_date")
        AND ("retrieved_at" IS NULL OR "retrieved_at" >= "notice_date")
      )
    )
  ) NOT VALID,
  ADD CONSTRAINT "tax_notice_retrieval_field_scope_check"
  CHECK (
    "delivery_method" = 'DATA_RETRIEVAL'
    OR (
      "retrieval_issued_at" IS NULL
      AND "retrieval_notification_date" IS NULL
      AND NOT "retrieval_notification_legacy_fallback"
      AND NOT "retrieval_notification_disputed_or_late"
      AND "retrieved_at" IS NULL
      AND "retrieval_consent_status" = 'NOT_APPLICABLE'
      AND "retrieval_postal_request_status" = 'NOT_APPLICABLE'
      AND "retrieval_postal_request_received_at" IS NULL
      AND "retrieval_eligibility_2027_status" = 'NOT_APPLICABLE'
      AND "retrieval_notification_status" = 'NOT_RECORDED'
      AND NOT "retrieval_reinstatement_review_required"
    )
  ) NOT VALID,
  ADD CONSTRAINT "tax_notice_retrieval_legacy_fallback_check"
  CHECK (
    NOT "retrieval_notification_legacy_fallback"
    OR (
      "delivery_method" = 'DATA_RETRIEVAL'
      AND "date_basis" = 'LEGACY_UNVERIFIED'
      AND "received_at" IS NULL
      AND "retrieval_issued_at" IS NULL
      AND "retrieval_notification_date" IS NULL
      AND NOT "retrieval_notification_disputed_or_late"
      -- Die Vorläufermigration hat ein vormals allgemeines received_at
      -- informationswahrend nach retrieved_at übernommen. Dieser unbeklassifizierte
      -- Altwert darf bestehen bleiben, wird durch den Guard aber eingefroren.
      AND "retrieval_consent_status" = 'NOT_APPLICABLE'
      AND "retrieval_postal_request_status" = 'NOT_APPLICABLE'
      AND "retrieval_postal_request_received_at" IS NULL
      AND "retrieval_eligibility_2027_status" = 'NOT_APPLICABLE'
      AND "retrieval_notification_status" = 'NOT_RECORDED'
      AND NOT "retrieval_reinstatement_review_required"
      AND "calculated_notification_date" IS NULL
      AND "internal_risk_deadline" IS NULL
      AND "alternative_claimed_access_deadline" IS NULL
      AND "deadline_calculation_status" = 'LEGACY_UNVERIFIED'
      AND "deadline_calculation_version" IS NULL
      AND "manual_review_required"
    )
  ) NOT VALID,
  ADD CONSTRAINT "tax_notice_calculation_result_check"
  CHECK (
    (
      "deadline_calculation_status" = 'LEGACY_UNVERIFIED'
      AND "calculated_notification_date" IS NULL
      AND "internal_risk_deadline" IS NULL
      AND "alternative_claimed_access_deadline" IS NULL
      AND "deadline_calculation_version" IS NULL
      AND "manual_review_required"
    )
    OR (
      "deadline_calculation_status" = 'CALCULATED'
      AND length(btrim(COALESCE("deadline_calculation_version", ''))) >= 3
      AND "calculated_notification_date" IS NOT NULL
      AND "appeal_deadline" IS NOT NULL
      AND "calculated_notification_date" >= "notice_date"
      AND "appeal_deadline" >= "calculated_notification_date"
      AND "internal_risk_deadline" IS NULL
      AND "alternative_claimed_access_deadline" IS NULL
      AND "date_basis" NOT IN ('LEGACY_UNVERIFIED', 'DOCUMENT_DATE_RISK_ONLY')
      AND "delivery_evidence_status" <> 'CLAIMED'
      AND (
        NOT "manual_review_required"
        OR length(btrim(COALESCE("manual_review_reason", ''))) >= 3
      )
      AND (
        "delivery_method" <> 'DATA_RETRIEVAL'
        OR "delivery_evidence_status" = 'PROFESSIONALLY_DETERMINED'
        OR "manual_review_required"
      )
      AND "legal_remedy_instruction_status" <> 'UNKLAR'
      AND (
        "date_basis" = 'ACTUAL_ACCESS_DETERMINED'
        OR (
          "recipient_holiday_context_status" = 'CONFIRMED_FOR_DATE_AND_LOCATION'
          AND "recipient_country_code" = 'DE'
          AND "recipient_region" IS NOT NULL
        )
      )
      AND "authority_holiday_context_status" = 'CONFIRMED_FOR_DATE_AND_LOCATION'
      AND "authority_country_code" = 'DE'
      AND "authority_region" IS NOT NULL
      AND "access_status" NOT IN ('NOT_RECEIVED_DISPUTED', 'LATER_RECEIPT_CLAIMED')
    )
    OR (
      "deadline_calculation_status" = 'RISK_ONLY'
      AND length(btrim(COALESCE("deadline_calculation_version", ''))) >= 3
      AND "date_basis" = 'DOCUMENT_DATE_RISK_ONLY'
      AND "appeal_deadline" IS NULL
      AND "internal_risk_deadline" IS NOT NULL
      AND "alternative_claimed_access_deadline" IS NULL
      AND "internal_risk_deadline" >= "notice_date"
      AND "manual_review_required"
    )
    OR (
      "deadline_calculation_status" = 'MANUAL_REVIEW'
      AND "appeal_deadline" IS NULL
      AND "calculated_notification_date" IS NULL
      AND length(btrim(COALESCE("deadline_calculation_version", ''))) >= 3
      AND "manual_review_required"
      AND length(btrim(COALESCE("manual_review_reason", ''))) >= 3
      AND (
        "alternative_claimed_access_deadline" IS NULL
        OR (
          "access_status" = 'LATER_RECEIPT_CLAIMED'
          AND "received_at" IS NOT NULL
          AND "internal_risk_deadline" IS NOT NULL
          AND "alternative_claimed_access_deadline" >= "received_at"
          AND "alternative_claimed_access_deadline" >= "internal_risk_deadline"
        )
      )
    )
  ) NOT VALID,
  ADD CONSTRAINT "tax_notice_input_documentation_check"
  CHECK (
    "deadline_calculation_status" = 'LEGACY_UNVERIFIED'
    OR (
      length(btrim(COALESCE("recipient_name", ''))) >= 1
      AND length(btrim(COALESCE("authority_name", ''))) >= 1
      AND length(btrim(COALESCE("holiday_context_note", ''))) >= 3
      AND length(btrim(COALESCE("legal_remedy_instruction_note", ''))) >= 3
      AND (
        "delivery_evidence_status" = 'CLAIMED'
        OR length(btrim(COALESCE("delivery_evidence_note", ''))) >= 3
      )
      AND (
        "access_evidence_status" IS NULL
        OR length(btrim(COALESCE("access_evidence_note", ''))) >= 3
      )
    )
  ) NOT VALID,
  ADD CONSTRAINT "tax_notice_instruction_status_check"
  CHECK (
    ("legal_remedy_instruction_status" <> 'WIRKSAM'
      OR "legal_remedy_instruction_valid")
    AND
    ("legal_remedy_instruction_status" <> 'UNWIRKSAM'
      OR NOT "legal_remedy_instruction_valid")
  ) NOT VALID,
  ADD CONSTRAINT "tax_notice_access_evidence_check"
  CHECK (
    (
      "access_status" = 'UNCONTESTED'
      AND (
        (
          "received_at" IS NULL
          AND "access_evidence_status" IS NULL
        )
        OR (
          "date_basis" = 'ACTUAL_ACCESS_DETERMINED'
          AND "access_evidence_status" = 'PROFESSIONALLY_DETERMINED'
          AND length(btrim(COALESCE("access_evidence_note", ''))) >= 3
        )
      )
    )
    OR (
      "access_status" = 'NOT_RECEIVED_DISPUTED'
      AND "received_at" IS NULL
      AND "access_evidence_status" IS NOT NULL
      AND length(btrim(COALESCE("access_evidence_note", ''))) >= 3
    )
    OR (
      "access_status" = 'EARLIER_RECEIPT_RECORDED'
      AND "date_basis" = 'DISPATCH_DATE'
      AND "received_at" IS NOT NULL
      AND "access_evidence_status" IS NOT NULL
      AND length(btrim(COALESCE("access_evidence_note", ''))) >= 3
      AND (
        "deadline_calculation_status" <> 'CALCULATED'
        OR "received_at" <= "calculated_notification_date"
      )
    )
    OR (
      "access_status" = 'LATER_RECEIPT_CLAIMED'
      AND "date_basis" = 'DISPATCH_DATE'
      AND "received_at" IS NOT NULL
      AND "access_evidence_status" IN ('CLAIMED', 'SUBSTANTIATED')
      AND length(btrim(COALESCE("access_evidence_note", ''))) >= 3
    )
    OR (
      "access_status" = 'LATER_RECEIPT_DETERMINED'
      AND "date_basis" = 'DISPATCH_DATE'
      AND "received_at" IS NOT NULL
      AND "access_evidence_status" = 'PROFESSIONALLY_DETERMINED'
      AND length(btrim(COALESCE("access_evidence_note", ''))) >= 3
    )
  ) NOT VALID,
  ADD CONSTRAINT "tax_notice_delivery_basis_check"
  CHECK (
    (
      "delivery_method" IN ('POST', 'POST_ABROAD', 'ELECTRONIC')
      AND (
        "date_basis" IN ('LEGACY_UNVERIFIED', 'DISPATCH_DATE', 'DOCUMENT_DATE_RISK_ONLY')
        OR (
          "date_basis" = 'ACTUAL_ACCESS_DETERMINED'
          AND "received_at" IS NOT NULL
          AND "access_evidence_status" = 'PROFESSIONALLY_DETERMINED'
        )
      )
    )
    OR (
      "delivery_method" = 'DATA_RETRIEVAL'
      AND "date_basis" IN ('LEGACY_UNVERIFIED', 'PROVISION_DATE')
      AND "received_at" IS NULL
    )
    OR (
      "delivery_method" IN ('FORMAL', 'PERSONAL', 'OTHER')
      AND (
        "date_basis" = 'LEGACY_UNVERIFIED'
        OR (
          "date_basis" = 'ACTUAL_ACCESS_DETERMINED'
          AND "received_at" IS NOT NULL
          AND "access_evidence_status" = 'PROFESSIONALLY_DETERMINED'
        )
      )
    )
  ) NOT VALID,
  ADD CONSTRAINT "tax_notice_retrieval_regime_check"
  CHECK (
    "delivery_method" <> 'DATA_RETRIEVAL'
    OR "date_basis" = 'LEGACY_UNVERIFIED'
    OR (
      "date_basis" = 'PROVISION_DATE'
      AND "retrieval_issued_at" IS NOT NULL
      AND "retrieval_issued_at" <= "notice_date"
      AND (
        (
          "retrieval_issued_at" < DATE '2026-01-01'
          AND "retrieval_consent_status" = 'NOT_APPLICABLE'
          AND "retrieval_postal_request_status" = 'NOT_APPLICABLE'
          AND "retrieval_eligibility_2027_status" = 'NOT_APPLICABLE'
        )
        OR (
          "retrieval_issued_at" >= DATE '2026-01-01'
          AND "retrieval_issued_at" < DATE '2027-01-01'
          AND "retrieval_consent_status" <> 'NOT_APPLICABLE'
          AND "retrieval_postal_request_status" = 'NOT_APPLICABLE'
          AND "retrieval_eligibility_2027_status" = 'NOT_APPLICABLE'
        )
        OR (
          "retrieval_issued_at" >= DATE '2027-01-01'
          AND "retrieval_consent_status" = 'NOT_APPLICABLE'
          AND "retrieval_postal_request_status" <> 'NOT_APPLICABLE'
          AND "retrieval_eligibility_2027_status" <> 'NOT_APPLICABLE'
        )
      )
      AND (
        "deadline_calculation_status" <> 'CALCULATED'
        OR (
          "delivery_evidence_status" <> 'CLAIMED'
          AND (
            (
              "retrieval_issued_at" < DATE '2026-01-01'
              AND (
                (
                  NOT "retrieval_notification_disputed_or_late"
                  AND "retrieval_notification_status" = 'SENT'
                  AND "retrieval_notification_date" IS NOT NULL
                )
                OR (
                  "retrieval_notification_disputed_or_late"
                  AND "retrieved_at" IS NOT NULL
                )
              )
            )
            OR (
              "retrieval_issued_at" >= DATE '2026-01-01'
              AND "retrieval_issued_at" < DATE '2027-01-01'
              AND "retrieval_consent_status" = 'CONFIRMED'
            )
            OR (
              "retrieval_issued_at" >= DATE '2027-01-01'
              AND "retrieval_eligibility_2027_status" = 'CONFIRMED'
              AND (
                "retrieval_postal_request_status" = 'NONE_EFFECTIVE'
                OR (
                "retrieval_postal_request_status" = 'EFFECTIVE'
                  AND "retrieval_postal_request_received_at" IS NOT NULL
                  AND "retrieval_postal_request_received_at" > "notice_date"
                )
              )
            )
          )
        )
      )
    )
  ) NOT VALID,
  ADD CONSTRAINT "tax_notice_postal_request_evidence_check"
  CHECK (
    (
      "retrieval_postal_request_status" = 'EFFECTIVE'
      AND (
        (
          "retrieval_postal_request_received_at" IS NOT NULL
          AND "retrieval_postal_request_received_at" > "notice_date"
        )
        OR (
          (
            "retrieval_postal_request_received_at" IS NULL
            OR "retrieval_postal_request_received_at" <= "notice_date"
          )
          AND "deadline_calculation_status" = 'MANUAL_REVIEW'
          AND "retrieval_reinstatement_review_required"
          AND "manual_review_required"
          AND length(btrim(COALESCE("manual_review_reason", ''))) >= 3
        )
      )
    )
    OR (
      "retrieval_postal_request_status" IN ('NOT_APPLICABLE', 'NONE_EFFECTIVE')
      AND "retrieval_postal_request_received_at" IS NULL
    )
    OR "retrieval_postal_request_status" = 'UNKNOWN'
  ) NOT VALID,
  ADD CONSTRAINT "tax_notice_appeal_filing_evidence_check"
  CHECK (
    "status" NOT IN (
      'EINSPRUCH'::public."tax_notice_status",
      'ABGEHOLFEN'::public."tax_notice_status",
      'TEILABHILFE'::public."tax_notice_status",
      'TEILEINSPRUCHSENTSCHEIDUNG'::public."tax_notice_status",
      'ZURUECKGEWIESEN'::public."tax_notice_status",
      'KLAGE'::public."tax_notice_status"
    )
    OR ("appeal_filed_at" IS NOT NULL AND "appeal_filed_by" IS NOT NULL)
  ) NOT VALID,
  ADD CONSTRAINT "tax_notice_partial_relief_evidence_check"
  CHECK (
    (("partial_relief_received_at" IS NULL) = ("partial_relief_received_by" IS NULL))
  ) NOT VALID,
  ADD CONSTRAINT "tax_notice_court_filing_evidence_check"
  CHECK (
    "status" <> 'KLAGE'::public."tax_notice_status"
    OR ("klage_filed_at" IS NOT NULL AND "klage_filed_by" IS NOT NULL)
  ) NOT VALID,
  ADD CONSTRAINT "tax_notice_retrieval_notification_review_check"
  CHECK (
    "delivery_method" <> 'DATA_RETRIEVAL'
    OR (
      (
        NOT "retrieval_reinstatement_review_required"
        OR (
          "manual_review_required"
          AND length(btrim(COALESCE("manual_review_reason", ''))) >= 3
        )
      )
      AND ("retrieval_notification_status" <> 'SENT'
        OR "retrieval_notification_date" IS NOT NULL)
      AND (
        "retrieval_issued_at" IS NULL
        OR (
          "retrieval_issued_at" < DATE '2026-01-01'
          AND (
            "retrieval_notification_disputed_or_late"
            OR "retrieval_notification_status" = 'SENT'
            OR (
              "deadline_calculation_status" = 'MANUAL_REVIEW'
              AND "manual_review_required"
              AND length(btrim(COALESCE("manual_review_reason", ''))) >= 3
            )
          )
        )
        OR (
          "retrieval_notification_status" = 'SENT'
          AND "retrieval_notification_date" = "notice_date"
        )
        OR (
          "retrieval_notification_status" = 'SENT'
          AND "retrieval_notification_date" > "notice_date"
          AND "retrieval_reinstatement_review_required"
          AND "manual_review_required"
          AND length(btrim(COALESCE("manual_review_reason", ''))) >= 3
        )
        OR (
          "retrieval_notification_status" = 'FAILED'
          AND "retrieval_reinstatement_review_required"
          AND "manual_review_required"
          AND length(btrim(COALESCE("manual_review_reason", ''))) >= 3
        )
        OR (
          "retrieval_notification_status" IN ('NOT_RECORDED', 'UNKNOWN')
          AND "manual_review_required"
          AND length(btrim(COALESCE("manual_review_reason", ''))) >= 3
        )
      )
    )
  ) NOT VALID,
  ADD CONSTRAINT "tax_notice_decision_deadline_check"
  CHECK (
    "status" NOT IN (
      'TEILEINSPRUCHSENTSCHEIDUNG'::public."tax_notice_status",
      'ZURUECKGEWIESEN'::public."tax_notice_status",
      'KLAGE'::public."tax_notice_status"
    )
    OR (
      "appeal_decision_received_at" IS NOT NULL
      AND "appeal_decision_legal_remedy_instruction_valid" IS NOT NULL
      AND "klage_deadline" IS NOT NULL
    )
  ) NOT VALID,
  ADD CONSTRAINT "tax_notice_legal_final_evidence_check"
  CHECK (
    (
      "status" = 'BESTANDSKRAEFTIG'::public."tax_notice_status"
      AND "legal_final_at" IS NOT NULL
      AND "legal_final_by" IS NOT NULL
      AND length(btrim(COALESCE("legal_final_reason", ''))) >= 10
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
  ) NOT VALID,
  ADD CONSTRAINT "tax_notice_event_sequence_check"
  CHECK (
    ("appeal_filed_at" IS NULL OR "appeal_filed_at"::date >= "notice_date")
    AND (
      "partial_relief_received_at" IS NULL
      OR (
        "appeal_filed_at" IS NOT NULL
        AND "partial_relief_received_at" >= "appeal_filed_at"::date
      )
    )
    AND (
      "appeal_decision_received_at" IS NULL
      OR "appeal_filed_at" IS NULL
      OR "appeal_decision_received_at" >= "appeal_filed_at"::date
    )
    AND (
      "appeal_decision_received_at" IS NULL
      OR "partial_relief_received_at" IS NULL
      OR "appeal_decision_received_at" >= "partial_relief_received_at"
    )
    AND (
      "appeal_resolved_at" IS NULL
      OR "appeal_filed_at" IS NULL
      OR "appeal_resolved_at"::date >= "appeal_filed_at"::date
    )
    AND (
      "appeal_resolved_at" IS NULL
      OR "partial_relief_received_at" IS NULL
      OR "appeal_resolved_at"::date >= "partial_relief_received_at"
    )
    AND (
      "klage_filed_at" IS NULL
      OR "appeal_decision_received_at" IS NULL
      OR "klage_filed_at"::date >= "appeal_decision_received_at"
    )
    AND (
      "klage_filed_at" IS NULL
      OR "partial_relief_received_at" IS NULL
      OR "klage_filed_at"::date >= "partial_relief_received_at"
    )
    AND (
      "legal_final_at" IS NULL
      OR (
        "legal_final_at"::date >= "notice_date"
        AND ("appeal_filed_at" IS NULL
          OR "legal_final_at"::date >= "appeal_filed_at"::date)
        AND ("appeal_resolved_at" IS NULL
          OR "legal_final_at"::date >= "appeal_resolved_at"::date)
        AND ("partial_relief_received_at" IS NULL
          OR "legal_final_at"::date >= "partial_relief_received_at")
        AND ("appeal_decision_received_at" IS NULL
          OR "legal_final_at"::date >= "appeal_decision_received_at")
        AND ("klage_filed_at" IS NULL
          OR "legal_final_at"::date >= "klage_filed_at"::date)
      )
    )
  ) NOT VALID;

-- Direkte Integrationen dürfen aus unvollständigen Eingaben keine scheinbar
-- belastbare Frist erzeugen. Feiertagsberechnung bleibt in der App; bei einer
-- nachträglichen Änderung fristrelevanter Tatsachen wird ein alter Vorschlag
-- fail-closed invalidiert und muss neu beurteilt werden.
CREATE OR REPLACE FUNCTION app.tax_notice_set_appeal_deadline() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND (
       NEW.notice_date IS DISTINCT FROM OLD.notice_date
       OR NEW.received_at IS DISTINCT FROM OLD.received_at
       OR NEW.delivery_method IS DISTINCT FROM OLD.delivery_method
       OR NEW.recipient_name IS DISTINCT FROM OLD.recipient_name
       OR NEW.recipient_country_code IS DISTINCT FROM OLD.recipient_country_code
       OR NEW.recipient_locality IS DISTINCT FROM OLD.recipient_locality
       OR NEW.recipient_local_holiday_dates IS DISTINCT FROM OLD.recipient_local_holiday_dates
       OR NEW.recipient_bavaria_assumption_applies IS DISTINCT FROM OLD.recipient_bavaria_assumption_applies
       OR NEW.authority_name IS DISTINCT FROM OLD.authority_name
       OR NEW.authority_country_code IS DISTINCT FROM OLD.authority_country_code
       OR NEW.authority_locality IS DISTINCT FROM OLD.authority_locality
       OR NEW.authority_local_holiday_dates IS DISTINCT FROM OLD.authority_local_holiday_dates
       OR NEW.authority_bavaria_assumption_applies IS DISTINCT FROM OLD.authority_bavaria_assumption_applies
       OR NEW.date_basis IS DISTINCT FROM OLD.date_basis
       OR NEW.delivery_evidence_status IS DISTINCT FROM OLD.delivery_evidence_status
       OR NEW.legal_remedy_instruction_status IS DISTINCT FROM OLD.legal_remedy_instruction_status
       OR NEW.access_status IS DISTINCT FROM OLD.access_status
       OR NEW.access_evidence_status IS DISTINCT FROM OLD.access_evidence_status
       OR NEW.recipient_region IS DISTINCT FROM OLD.recipient_region
       OR NEW.authority_region IS DISTINCT FROM OLD.authority_region
       OR NEW.recipient_holiday_context_status IS DISTINCT FROM OLD.recipient_holiday_context_status
       OR NEW.authority_holiday_context_status IS DISTINCT FROM OLD.authority_holiday_context_status
       OR NEW.retrieval_issued_at IS DISTINCT FROM OLD.retrieval_issued_at
       OR NEW.retrieval_notification_date IS DISTINCT FROM OLD.retrieval_notification_date
       OR NEW.retrieval_notification_status IS DISTINCT FROM OLD.retrieval_notification_status
       OR NEW.retrieval_notification_disputed_or_late IS DISTINCT FROM OLD.retrieval_notification_disputed_or_late
       OR NEW.retrieval_notification_legacy_fallback IS DISTINCT FROM OLD.retrieval_notification_legacy_fallback
       OR NEW.retrieval_consent_status IS DISTINCT FROM OLD.retrieval_consent_status
       OR NEW.retrieval_postal_request_status IS DISTINCT FROM OLD.retrieval_postal_request_status
       OR NEW.retrieval_postal_request_received_at IS DISTINCT FROM OLD.retrieval_postal_request_received_at
       OR NEW.retrieval_eligibility_2027_status IS DISTINCT FROM OLD.retrieval_eligibility_2027_status
       OR NEW.retrieved_at IS DISTINCT FROM OLD.retrieved_at
     ) THEN
    NEW.appeal_deadline := NULL;
    NEW.calculated_notification_date := NULL;
    NEW.internal_risk_deadline := NULL;
    NEW.alternative_claimed_access_deadline := NULL;
    NEW.deadline_calculation_status := 'MANUAL_REVIEW';
    NEW.manual_review_required := true;
    -- Nach jeder Tatsachenänderung an einem Datenabruf bleibt auch eine
    -- mögliche §110-/Ausnahmeprüfung offen, bis die Engine den gesamten
    -- Sachverhalt neu bewertet. Beim Wechsel weg vom Datenabruf muss das
    -- quellspezifische Flag dagegen zwingend verschwinden.
    NEW.retrieval_reinstatement_review_required :=
      NEW.delivery_method = 'DATA_RETRIEVAL';
    NEW.manual_review_reason := concat_ws(
      E'\n',
      NULLIF(NEW.manual_review_reason, ''),
      'Fristrelevante Tatsachen wurden geändert; Kontrollvorschlag neu berechnen und prüfen.'
    );
  ELSIF TG_OP = 'UPDATE'
     AND (
       NEW.appeal_deadline IS DISTINCT FROM OLD.appeal_deadline
       OR NEW.calculated_notification_date IS DISTINCT FROM OLD.calculated_notification_date
       OR NEW.internal_risk_deadline IS DISTINCT FROM OLD.internal_risk_deadline
       OR NEW.alternative_claimed_access_deadline IS DISTINCT FROM OLD.alternative_claimed_access_deadline
       OR NEW.deadline_calculation_status IS DISTINCT FROM OLD.deadline_calculation_status
       OR NEW.deadline_calculation_version IS DISTINCT FROM OLD.deadline_calculation_version
       OR NEW.manual_review_required IS DISTINCT FROM OLD.manual_review_required
       OR NEW.retrieval_reinstatement_review_required IS DISTINCT FROM OLD.retrieval_reinstatement_review_required
     ) THEN
    -- Eine Neuberechnung darf den fail-closed Zustand ausschließlich über die
    -- SECURITY-DEFINER-Funktion unten verlassen. Der transaktionslokale Marker
    -- ist an genau einen Bescheid gebunden; zusätzlich muss der UPDATE unter
    -- der Tabellen-Owner-Rolle der Funktion laufen. Ein direkter App-UPDATE
    -- kann den Marker daher nicht durch set_config nachahmen.
    IF NOT (
      current_setting('app.tax_notice_deadline_reassessment_id', true)
        IS NOT DISTINCT FROM OLD.id::TEXT
      AND current_user = (
        SELECT pg_catalog.pg_get_userbyid(c.relowner)
          FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relname = 'tax_notice'
           AND c.relkind IN ('r', 'p')
      )
    ) THEN
      RAISE EXCEPTION
        'deadline assessment outputs cannot be edited without an authorized engine reassessment';
    END IF;
  END IF;

  IF NEW.deadline_calculation_status = 'CALCULATED'
     AND (NEW.appeal_deadline IS NULL OR NEW.calculated_notification_date IS NULL) THEN
    RAISE EXCEPTION
      'CALCULATED requires calculated_notification_date and appeal_deadline from the legal assessment engine';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER FUNCTION app.tax_notice_set_appeal_deadline()
  SET search_path = pg_catalog, public, pg_temp;

DROP TRIGGER IF EXISTS tax_notice_appeal_deadline_trigger ON public."tax_notice";
CREATE TRIGGER tax_notice_appeal_deadline_trigger
  BEFORE INSERT OR UPDATE OF
    "notice_date",
    "received_at",
    "delivery_method",
    "recipient_name",
    "recipient_country_code",
    "recipient_locality",
    "recipient_local_holiday_dates",
    "recipient_bavaria_assumption_applies",
    "authority_name",
    "authority_country_code",
    "authority_locality",
    "authority_local_holiday_dates",
    "authority_bavaria_assumption_applies",
    "date_basis",
    "delivery_evidence_status",
    "legal_remedy_instruction_status",
    "access_status",
    "access_evidence_status",
    "recipient_region",
    "authority_region",
    "recipient_holiday_context_status",
    "authority_holiday_context_status",
    "retrieval_issued_at",
    "retrieval_notification_date",
    "retrieval_notification_status",
    "retrieval_notification_disputed_or_late",
    "retrieval_notification_legacy_fallback",
    "retrieval_consent_status",
    "retrieval_postal_request_status",
    "retrieval_postal_request_received_at",
    "retrieval_eligibility_2027_status",
    "retrieved_at",
    "appeal_deadline",
    "calculated_notification_date",
    "internal_risk_deadline",
    "alternative_claimed_access_deadline",
    "deadline_calculation_status",
    "deadline_calculation_version",
    "manual_review_required",
    "retrieval_reinstatement_review_required"
  ON public."tax_notice"
  FOR EACH ROW EXECUTE FUNCTION app.tax_notice_set_appeal_deadline();

-- Gezielter Rückweg aus der fail-closed Invalidierung. Die Funktion akzeptiert
-- ausschließlich einen vollständigen CALCULATED-Vorschlag für exakt den
-- inzwischen invalidierten Datensatz und bindet ihn optimistisch an updated_at.
-- Damit kann keine parallel geänderte Tatsachenbasis mit einem veralteten
-- Engine-Ergebnis überschrieben werden.
CREATE OR REPLACE FUNCTION app.tax_notice_apply_calculated_reassessment(
  p_notice_id UUID,
  p_expected_updated_at TIMESTAMP(3),
  p_calculated_notification_date DATE,
  p_appeal_deadline DATE,
  p_deadline_calculation_version TEXT,
  p_manual_review_required BOOLEAN,
  p_manual_review_reason TEXT,
  p_retrieval_reinstatement_review_required BOOLEAN
)
RETURNS public."tax_notice"
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app, pg_temp
AS $$
DECLARE
  reassessed public."tax_notice"%ROWTYPE;
  bound_tenant_id UUID := app.current_tenant_id();
  bound_actor_id UUID := app.current_actor_id();
BEGIN
  IF bound_tenant_id IS NULL
     OR bound_actor_id IS NULL
     OR app.current_actor_type() IS DISTINCT FROM 'STAFF'
     OR NOT EXISTS (
       SELECT 1
         FROM public."staff_user" staff
        WHERE staff."id" = bound_actor_id
          AND staff."tenant_id" = bound_tenant_id
          AND staff."active"
     ) THEN
    RAISE EXCEPTION 'deadline reassessment requires an active bound staff context'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_expected_updated_at IS NULL
     OR p_calculated_notification_date IS NULL
     OR p_appeal_deadline IS NULL
     OR length(btrim(COALESCE(p_deadline_calculation_version, ''))) < 3
     OR p_manual_review_required IS NULL
     OR p_retrieval_reinstatement_review_required IS NULL
     OR (
       p_manual_review_required
       AND length(btrim(COALESCE(p_manual_review_reason, ''))) < 3
     )
     OR (
       NOT p_manual_review_required
       AND NULLIF(btrim(COALESCE(p_manual_review_reason, '')), '') IS NOT NULL
     )
     OR (
       p_retrieval_reinstatement_review_required
       AND NOT p_manual_review_required
     ) THEN
    RAISE EXCEPTION 'deadline reassessment contains an incomplete calculated result'
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM set_config(
    'app.tax_notice_deadline_reassessment_id',
    p_notice_id::TEXT,
    true
  );

  UPDATE public."tax_notice" AS notice
     SET "calculated_notification_date" = p_calculated_notification_date,
         "appeal_deadline" = p_appeal_deadline,
         "internal_risk_deadline" = NULL,
         "alternative_claimed_access_deadline" = NULL,
         "deadline_calculation_status" = 'CALCULATED',
         "deadline_calculation_version" = btrim(p_deadline_calculation_version),
         "manual_review_required" = p_manual_review_required,
         "manual_review_reason" = NULLIF(btrim(COALESCE(p_manual_review_reason, '')), ''),
         "retrieval_reinstatement_review_required" = p_retrieval_reinstatement_review_required,
         "updated_at" = timezone('UTC', clock_timestamp())
   WHERE notice."id" = p_notice_id
     AND notice."tenant_id" = bound_tenant_id
     AND notice."updated_at" IS NOT DISTINCT FROM p_expected_updated_at
     AND notice."deadline_calculation_status" = 'MANUAL_REVIEW'
     AND notice."appeal_deadline" IS NULL
     AND notice."calculated_notification_date" IS NULL
     AND notice."internal_risk_deadline" IS NULL
     AND notice."alternative_claimed_access_deadline" IS NULL
     AND notice."manual_review_required"
     AND position(
       'Fristrelevante Tatsachen wurden geändert; Kontrollvorschlag neu berechnen und prüfen.'
       IN COALESCE(notice."manual_review_reason", '')
     ) > 0
  RETURNING notice.* INTO reassessed;

  PERFORM set_config('app.tax_notice_deadline_reassessment_id', '', true);

  IF reassessed."id" IS NULL THEN
    RAISE EXCEPTION
      'deadline reassessment target is missing, stale or was not invalidated by an input change'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  RETURN reassessed;
END;
$$;

REVOKE ALL ON FUNCTION app.tax_notice_apply_calculated_reassessment(
  UUID,
  TIMESTAMP(3),
  DATE,
  DATE,
  TEXT,
  BOOLEAN,
  TEXT,
  BOOLEAN
) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.tax_notice_apply_calculated_reassessment(
  UUID,
  TIMESTAMP(3),
  DATE,
  DATE,
  TEXT,
  BOOLEAN,
  TEXT,
  BOOLEAN
) FROM taxtronik_app;

CREATE OR REPLACE FUNCTION app.tax_notice_require_progress_evidence() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'BESTANDSKRAEFTIG'::public.tax_notice_status THEN
    IF OLD.status NOT IN (
      'GEPRUEFT'::public.tax_notice_status,
      'ABGEHOLFEN'::public.tax_notice_status,
      'ZURUECKGEWIESEN'::public.tax_notice_status,
      'KLAGE'::public.tax_notice_status
    ) THEN
      RAISE EXCEPTION 'bestandskraft is not permitted from the current procedure status';
    END IF;

    IF OLD.status = 'GEPRUEFT'::public.tax_notice_status AND (
      NEW.deadline_calculation_status <> 'CALCULATED'
      OR NEW.manual_review_required
      OR NEW.appeal_deadline IS NULL
      OR NEW.appeal_filed_at IS NOT NULL
      OR NEW.legal_final_at IS NULL
      OR NEW.legal_final_at::date <= NEW.appeal_deadline
    ) THEN
      RAISE EXCEPTION
        'bestandskraft without an appeal requires the elapsed, fully calculated appeal deadline';
    END IF;

    IF OLD.status = 'ZURUECKGEWIESEN'::public.tax_notice_status AND (
      OLD.klage_deadline IS NULL
      OR NEW.legal_final_at IS NULL
      OR NEW.legal_final_at::date <= OLD.klage_deadline
    ) THEN
      RAISE EXCEPTION
        'bestandskraft after an appeal decision requires the elapsed court deadline';
    END IF;
  END IF;

  IF OLD.status IN (
    'EINSPRUCH'::public.tax_notice_status,
    'ABGEHOLFEN'::public.tax_notice_status,
    'TEILABHILFE'::public.tax_notice_status,
    'TEILEINSPRUCHSENTSCHEIDUNG'::public.tax_notice_status,
    'ZURUECKGEWIESEN'::public.tax_notice_status,
    'KLAGE'::public.tax_notice_status
  ) AND (NEW.appeal_filed_at IS NULL OR NEW.appeal_filed_by IS NULL) THEN
    RAISE EXCEPTION 'appeal filing evidence must be completed before status progress';
  END IF;

  IF OLD.status = 'ABGEHOLFEN'::public.tax_notice_status
     AND NEW.appeal_resolved_at IS NULL THEN
    RAISE EXCEPTION 'appeal resolution evidence must be completed before status progress';
  END IF;

  IF OLD.status = 'TEILABHILFE'::public.tax_notice_status
     AND (
       NEW.partial_relief_received_at IS NULL
       OR NEW.partial_relief_received_by IS NULL
     ) THEN
    RAISE EXCEPTION 'partial relief receipt evidence must be completed before status progress';
  END IF;

  IF NEW.partial_relief_received_at IS NOT NULL AND (
    (
      NEW.appeal_resolved_at IS NOT NULL
      AND NEW.appeal_resolved_at::date < NEW.partial_relief_received_at
    )
    OR (
      NEW.appeal_decision_received_at IS NOT NULL
      AND NEW.appeal_decision_received_at < NEW.partial_relief_received_at
    )
    OR (
      NEW.klage_filed_at IS NOT NULL
      AND NEW.klage_filed_at::date < NEW.partial_relief_received_at
    )
    OR (
      NEW.legal_final_at IS NOT NULL
      AND NEW.legal_final_at::date < NEW.partial_relief_received_at
    )
  ) THEN
    RAISE EXCEPTION 'procedure progress must not predate the partial relief receipt';
  END IF;

  IF OLD.status IN (
    'TEILEINSPRUCHSENTSCHEIDUNG'::public.tax_notice_status,
    'ZURUECKGEWIESEN'::public.tax_notice_status,
    'KLAGE'::public.tax_notice_status
  ) AND (
    NEW.appeal_decision_received_at IS NULL
    OR NEW.appeal_decision_legal_remedy_instruction_valid IS NULL
    OR NEW.klage_deadline IS NULL
  ) THEN
    RAISE EXCEPTION 'appeal decision evidence must be completed before status progress';
  END IF;

  IF OLD.status IN (
    'ZURUECKGEWIESEN'::public.tax_notice_status,
    'KLAGE'::public.tax_notice_status
  ) AND NEW.appeal_resolved_at IS NULL THEN
    RAISE EXCEPTION 'final appeal resolution evidence must be completed before status progress';
  END IF;

  IF OLD.status = 'KLAGE'::public.tax_notice_status
     AND (NEW.klage_filed_at IS NULL OR NEW.klage_filed_by IS NULL) THEN
    RAISE EXCEPTION 'court filing evidence must be completed before status progress';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER FUNCTION app.tax_notice_require_progress_evidence()
  SET search_path = pg_catalog, public, pg_temp;

-- Historische TEILABHILFE-Zeilen ohne eindeutig bezeichneten Bekanntgabetag
-- werden nicht allein wegen dieses fehlenden Ereignispaars blockiert; die
-- übrigen Nachweis-Constraints gelten unverändert. Bei Neuanlage/Eintritt in
-- TEILABHILFE ist das vollständige Paar Pflicht. Ein einmal dokumentierter
-- Nachweis bleibt auch in Folgestatus unveränderlich. So erfindet die Migration
-- keine Alttatsachen und lässt eine spätere Aktenbestätigung nicht verschwinden.
CREATE OR REPLACE FUNCTION app.tax_notice_guard_partial_relief_evidence()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" = 'TEILABHILFE'::public."tax_notice_status"
       AND (
         NEW."partial_relief_received_at" IS NULL
         OR NEW."partial_relief_received_by" IS NULL
       ) THEN
      RAISE EXCEPTION 'partial relief requires receipt date and documenting staff';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."partial_relief_received_at" IS NOT NULL
     AND (
       NEW."partial_relief_received_at" IS DISTINCT FROM OLD."partial_relief_received_at"
       OR NEW."partial_relief_received_by" IS DISTINCT FROM OLD."partial_relief_received_by"
     ) THEN
    RAISE EXCEPTION 'partial relief receipt evidence is immutable once recorded'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."status" = 'TEILABHILFE'::public."tax_notice_status"
     AND OLD."status" IS DISTINCT FROM NEW."status"
     AND (
       NEW."partial_relief_received_at" IS NULL
       OR NEW."partial_relief_received_by" IS NULL
     ) THEN
    RAISE EXCEPTION 'partial relief requires receipt date and documenting staff';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.tax_notice_guard_partial_relief_evidence() FROM PUBLIC;

CREATE TRIGGER tax_notice_partial_relief_evidence_guard
  BEFORE INSERT OR UPDATE OF
    "status",
    "partial_relief_received_at",
    "partial_relief_received_by"
  ON public."tax_notice"
  FOR EACH ROW EXECUTE FUNCTION app.tax_notice_guard_partial_relief_evidence();

-- ---------------------------------------------------------------------------
-- Tägliche Abschlusskontrolle: append-only Snapshot, tenant-isoliert.
-- ---------------------------------------------------------------------------

CREATE TABLE public."deadline_daily_review" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "review_date" DATE NOT NULL,
  "snapshot_at" TIMESTAMPTZ(6) NOT NULL DEFAULT transaction_timestamp(),
  "reviewed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewed_by" UUID NOT NULL,
  "open_count" INTEGER NOT NULL,
  "overdue_count" INTEGER NOT NULL,
  "due_today_count" INTEGER NOT NULL,
  "escalation_note" TEXT,
  "entries_snapshot" JSONB NOT NULL,
  CONSTRAINT "deadline_daily_review_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "deadline_daily_review_tenant_fk"
    FOREIGN KEY ("tenant_id") REFERENCES public."tenant"("id")
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "deadline_daily_review_counts_check"
    CHECK (
      "open_count" >= 0
      AND "overdue_count" >= 0
      AND "due_today_count" >= 0
      AND "overdue_count" + "due_today_count" <= "open_count"
      AND "reviewed_at" >= "snapshot_at"
    ),
  CONSTRAINT "deadline_daily_review_escalation_check"
    CHECK (
      ("overdue_count" = 0 AND "due_today_count" = 0)
      OR length(btrim(COALESCE("escalation_note", ''))) >= 3
  )
);

-- Der Tagesabschluss ist ein serverseitig datierter, in sich geschlossener
-- Snapshot. Direkte Integrationen dürfen weder einen früheren/späteren Tag
-- behaupten noch Zähler anliefern, die nicht aus den Snapshot-Einträgen folgen.
CREATE OR REPLACE FUNCTION app.deadline_daily_review_validate_insert()
RETURNS TRIGGER AS $$
DECLARE
  server_now TIMESTAMPTZ := clock_timestamp();
  transaction_started_at TIMESTAMPTZ := transaction_timestamp();
  berlin_review_date DATE := (server_now AT TIME ZONE 'Europe/Berlin')::date;
  snapshot_entry JSONB;
  entry_due_date DATE;
  snapshot_open_count INTEGER := 0;
  snapshot_overdue_count INTEGER := 0;
  snapshot_due_today_count INTEGER := 0;
BEGIN
  IF NEW.review_date IS DISTINCT FROM berlin_review_date THEN
    RAISE EXCEPTION
      'review_date must equal the current Europe/Berlin date (%)',
      berlin_review_date;
  END IF;

  -- Der fachliche Snapshot gehört zum konsistenten Lesestand der umgebenden
  -- Transaktion. Weder snapshot_at noch reviewed_at werden als angelieferte
  -- Tatsachen übernommen: ersterer ist der Transaktions-, letzterer der
  -- tatsächliche Insert-/Abschlusszeitpunkt.
  NEW.snapshot_at := transaction_started_at;
  NEW.reviewed_at := server_now;

  IF jsonb_typeof(NEW.entries_snapshot) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'entries_snapshot must be a JSON object';
  END IF;
  IF NEW.entries_snapshot->'version' IS DISTINCT FROM '1'::jsonb THEN
    RAISE EXCEPTION 'entries_snapshot.version must be 1';
  END IF;
  IF jsonb_typeof(NEW.entries_snapshot->'reviewDate') IS DISTINCT FROM 'string'
     OR NEW.entries_snapshot->>'reviewDate'
        IS DISTINCT FROM to_char(NEW.review_date, 'YYYY-MM-DD') THEN
    RAISE EXCEPTION 'entries_snapshot.reviewDate must match review_date';
  END IF;
  IF jsonb_typeof(NEW.entries_snapshot->'entries') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'entries_snapshot.entries must be a JSON array';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_object_keys(NEW.entries_snapshot) AS snapshot_key(key)
     WHERE snapshot_key.key NOT IN ('version', 'reviewDate', 'entries')
  ) THEN
    RAISE EXCEPTION
      'entries_snapshot may only contain version, reviewDate and entries';
  END IF;

  FOR snapshot_entry IN
    SELECT value
      FROM jsonb_array_elements(NEW.entries_snapshot->'entries') AS item(value)
  LOOP
    IF jsonb_typeof(snapshot_entry) IS DISTINCT FROM 'object'
       OR jsonb_typeof(snapshot_entry->'quelle') IS DISTINCT FROM 'string'
       OR snapshot_entry->>'quelle' NOT IN (
         'STEUERTERMIN',
         'EINSPRUCHSFRIST',
         'KLAGEFRIST',
         'ANFORDERUNG',
         'WIEDERVORLAGE'
       )
       OR jsonb_typeof(snapshot_entry->'kontrollart') IS DISTINCT FROM 'string'
       OR snapshot_entry->>'kontrollart' NOT IN (
         'CALCULATED_CONTROL_PROPOSAL',
         'REVIEW_PENDING_CONTROL_PROPOSAL',
         'INTERNAL_RISK',
         'OPERATIONAL_DUE_DATE'
       )
       OR (
         snapshot_entry->>'quelle' IN ('EINSPRUCHSFRIST', 'KLAGEFRIST')
         AND snapshot_entry->>'kontrollart' NOT IN (
           'CALCULATED_CONTROL_PROPOSAL',
           'REVIEW_PENDING_CONTROL_PROPOSAL',
           'INTERNAL_RISK'
         )
       )
       OR (
         snapshot_entry->>'quelle' IN ('STEUERTERMIN', 'ANFORDERUNG', 'WIEDERVORLAGE')
         AND snapshot_entry->>'kontrollart' <> 'OPERATIONAL_DUE_DATE'
       )
       OR jsonb_typeof(snapshot_entry->'id') IS DISTINCT FROM 'string'
       OR length(btrim(COALESCE(snapshot_entry->>'id', ''))) = 0
       OR jsonb_typeof(snapshot_entry->'clientId') IS DISTINCT FROM 'string'
       OR length(btrim(COALESCE(snapshot_entry->>'clientId', ''))) = 0
       OR jsonb_typeof(snapshot_entry->'faelligAm') IS DISTINCT FROM 'string'
       OR NOT (snapshot_entry ? 'verantwortlichId')
       OR (
         jsonb_typeof(snapshot_entry->'verantwortlichId') IS DISTINCT FROM 'string'
         AND jsonb_typeof(snapshot_entry->'verantwortlichId') IS DISTINCT FROM 'null'
       )
       OR (
         jsonb_typeof(snapshot_entry->'verantwortlichId') = 'string'
         AND length(btrim(snapshot_entry->>'verantwortlichId')) = 0
       ) THEN
      RAISE EXCEPTION 'entries_snapshot contains an invalid entry';
    END IF;

    -- Der append-only Kontrollnachweis darf keine Klartextbezeichnungen oder
    -- beliebigen Zusatzfelder dauerhaft duplizieren. Die Positivliste hält den
    -- Snapshot auf pseudonyme Referenzen und fachliche Kontrolldaten beschränkt.
    IF EXISTS (
      SELECT 1
        FROM jsonb_object_keys(snapshot_entry) AS snapshot_key(key)
       WHERE snapshot_key.key NOT IN (
         'quelle',
         'kontrollart',
         'id',
         'clientId',
         'faelligAm',
         'verantwortlichId'
       )
    ) THEN
      RAISE EXCEPTION
        'entries_snapshot entries may only contain pseudonymous control fields';
    END IF;

    -- Auch unter erlaubten Schlüsseln darf kein Klartext als vermeintliche ID
    -- gespeichert werden. Der Roundtrip über den nativen UUID-Typ erzwingt die
    -- kanonische, pseudonyme Schreibweise; verantwortlichId bleibt nullable.
    BEGIN
      IF ((snapshot_entry->>'id')::UUID)::TEXT
           IS DISTINCT FROM lower(btrim(snapshot_entry->>'id'))
         OR ((snapshot_entry->>'clientId')::UUID)::TEXT
           IS DISTINCT FROM lower(btrim(snapshot_entry->>'clientId'))
         OR (
           jsonb_typeof(snapshot_entry->'verantwortlichId') = 'string'
           AND ((snapshot_entry->>'verantwortlichId')::UUID)::TEXT
             IS DISTINCT FROM lower(btrim(snapshot_entry->>'verantwortlichId'))
         ) THEN
        RAISE EXCEPTION 'entries_snapshot identifiers must be canonical UUIDs';
      END IF;
    EXCEPTION
      WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'entries_snapshot identifiers must be canonical UUIDs';
    END;

    BEGIN
      entry_due_date := (snapshot_entry->>'faelligAm')::date;
    EXCEPTION
      WHEN invalid_datetime_format OR datetime_field_overflow THEN
        RAISE EXCEPTION 'entries_snapshot contains an invalid faelligAm date';
    END;

    IF snapshot_entry->>'faelligAm' IS DISTINCT FROM to_char(entry_due_date, 'YYYY-MM-DD') THEN
      RAISE EXCEPTION 'entries_snapshot.faelligAm must use YYYY-MM-DD';
    END IF;
    IF entry_due_date > NEW.review_date THEN
      RAISE EXCEPTION 'entries_snapshot must not contain future deadlines';
    END IF;

    snapshot_open_count := snapshot_open_count + 1;
    IF entry_due_date < NEW.review_date THEN
      snapshot_overdue_count := snapshot_overdue_count + 1;
    ELSE
      snapshot_due_today_count := snapshot_due_today_count + 1;
    END IF;
  END LOOP;

  IF NEW.open_count IS DISTINCT FROM snapshot_open_count
     OR NEW.overdue_count IS DISTINCT FROM snapshot_overdue_count
     OR NEW.due_today_count IS DISTINCT FROM snapshot_due_today_count THEN
    RAISE EXCEPTION
      'deadline daily review counters do not match entries_snapshot (% open, % overdue, % due today)',
      snapshot_open_count,
      snapshot_overdue_count,
      snapshot_due_today_count;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER FUNCTION app.deadline_daily_review_validate_insert()
  SET search_path = pg_catalog, public, pg_temp;

CREATE TRIGGER deadline_daily_review_validate_insert_trigger
  BEFORE INSERT ON public."deadline_daily_review"
  FOR EACH ROW EXECUTE FUNCTION app.deadline_daily_review_validate_insert();

CREATE UNIQUE INDEX "deadline_daily_review_tenant_date_key"
  ON public."deadline_daily_review" ("tenant_id", "review_date");
CREATE INDEX "deadline_daily_review_tenant_date_idx"
  ON public."deadline_daily_review" ("tenant_id", "review_date" DESC);

ALTER TABLE public."deadline_daily_review" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."deadline_daily_review" FORCE ROW LEVEL SECURITY;

CREATE POLICY "deadline_daily_review_select"
  ON public."deadline_daily_review"
  FOR SELECT
  USING (
    "tenant_id" = app.current_tenant_id()
    AND (
      app.current_actor_type() = 'SYSTEM'
      OR (
        app.current_actor_type() = 'STAFF'
        AND EXISTS (
          SELECT 1
            FROM public."staff_user" staff
            JOIN public."staff_role" sr
              ON sr."staff_user_id" = staff.id
           WHERE staff.id = app.current_actor_id()
             AND staff."tenant_id" = "deadline_daily_review"."tenant_id"
             AND staff."active" = TRUE
             AND sr."role" IN (
               'ADMIN'::public."staff_role_name",
               'PARTNER'::public."staff_role_name"
             )
        )
      )
    )
  );

CREATE POLICY "deadline_daily_review_insert"
  ON public."deadline_daily_review"
  FOR INSERT
  WITH CHECK (
    app.current_actor_type() = 'STAFF'
    AND "tenant_id" = app.current_tenant_id()
    AND "reviewed_by" = app.current_actor_id()
    AND EXISTS (
      SELECT 1
        FROM public."staff_user" staff
        JOIN public."staff_role" sr
          ON sr."staff_user_id" = staff.id
       WHERE staff.id = app.current_actor_id()
         AND staff."tenant_id" = "deadline_daily_review"."tenant_id"
         AND staff."active" = TRUE
         AND sr."role" IN (
           'ADMIN'::public."staff_role_name",
           'PARTNER'::public."staff_role_name"
         )
    )
  );

REVOKE ALL ON public."deadline_daily_review" FROM taxtronik_app;
GRANT SELECT, INSERT ON public."deadline_daily_review" TO taxtronik_app;

COMMIT;
