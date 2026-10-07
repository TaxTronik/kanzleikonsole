-- Fachkatalog: ACCESS-TENANT-RLS-001 (mail_outbox aus 20261006120000_mail_outbox)
--
-- Review-Entscheidung C4: An den Statuszeilen der Mandanten-Mails gibt es
-- „Erneut senden" für fehlgeschlagene (FAILED) und unklare (UNKNOWN)
-- Versandaufträge. Der Neuversand setzt den Auftrag für den Worker zurück; die
-- Web-App sendet nie selbst. Dafür bleiben Inhalt und geheime Variablen in
-- FAILED und UNKNOWN erhalten (bisher mit jedem Terminalstatus entfernt). Der
-- Worker entfernt sie dort nach Ablauf des Neuversandfensters
-- (MAIL_OUTBOX_RESEND_WINDOW_DAYS ab Eskalation), bei anonymisiertem Mandanten
-- sofort und weiterhin mit jedem anderen Terminalstatus.
--
-- Die App-Rolle erhält weiterhin kein UPDATE auf mail_outbox. Den einzigen
-- Statuswechsel aus der Web-App kapselt app.mail_outbox_resend: nur im
-- gebundenen Kanzleikontext (Tenant und Akteurstyp STAFF) und nur aus dem
-- erwarteten Status FAILED oder UNKNOWN. Ohne Begründung geht der Auftrag mit
-- erhaltenem Inhalt zurück nach QUEUED (neuer Zustellzyklus mit vollem
-- Versuchsbudget); mit Begründung endet er als SKIPPED, weil der Vorgang nicht
-- mehr aktuell ist (Inhalt entfernt). Berechtigung, Mandantenzugriff und
-- Zustand des Vorgangs prüft die Server-Action; die Funktion erzwingt Tenant
-- und Übergang. EXECUTE wie bei allen App-Funktionen auch für taxtronik_owner
-- (Parität, 20261006160000_owner_role_least_privilege).
BEGIN;

ALTER TABLE public."mail_outbox" DROP CONSTRAINT "mail_outbox_secret_check";
-- Geheime Variablen überleben nur Status, aus denen noch versendet werden kann.
ALTER TABLE public."mail_outbox" ADD CONSTRAINT "mail_outbox_secret_check" CHECK (
  "secret_vars_enc" IS NULL
  OR "status" IN ('QUEUED', 'SENDING', 'RETRY_PENDING', 'FAILED', 'UNKNOWN')
);

CREATE OR REPLACE FUNCTION app.mail_outbox_resend(
  p_outbox_id UUID,
  p_expected_status public.mail_outbox_status,
  p_skip_reason TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app, pg_temp
AS $$
DECLARE
  v_tenant_id UUID := app.current_tenant_id();
  v_changed INTEGER;
BEGIN
  IF v_tenant_id IS NULL OR app.current_actor_type() IS DISTINCT FROM 'STAFF' THEN
    RAISE EXCEPTION 'MAIL_OUTBOX_RESEND_CONTEXT: Neuversand nur im Kanzleikontext.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_expected_status IS NULL
     OR p_expected_status NOT IN ('FAILED'::public.mail_outbox_status,
                                  'UNKNOWN'::public.mail_outbox_status) THEN
    RAISE EXCEPTION 'MAIL_OUTBOX_RESEND_STATUS: Nur fehlgeschlagene oder unklare Aufträge.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_skip_reason IS NULL THEN
    UPDATE public."mail_outbox"
       SET "status" = 'QUEUED',
           "attempt_count" = 0,
           "next_attempt_at" = now(),
           "accepted_at" = NULL,
           "recipients_attempted" = NULL,
           "recipients_accepted" = NULL,
           "escalated_at" = NULL,
           "last_error" = 'Manuell erneut zum Versand vorgemerkt.',
           "updated_at" = now()
     WHERE "id" = p_outbox_id
       AND "tenant_id" = v_tenant_id
       AND "status" = p_expected_status
       AND "payload" <> '{}'::jsonb;
  ELSE
    IF btrim(p_skip_reason) = '' THEN
      RAISE EXCEPTION 'MAIL_OUTBOX_RESEND_REASON: Begründung fehlt.'
        USING ERRCODE = 'check_violation';
    END IF;
    UPDATE public."mail_outbox"
       SET "status" = 'SKIPPED',
           "payload" = '{}'::jsonb,
           "secret_vars_enc" = NULL,
           "next_attempt_at" = NULL,
           "last_error" = left('Nicht versendet: ' || btrim(p_skip_reason), 500),
           "updated_at" = now()
     WHERE "id" = p_outbox_id
       AND "tenant_id" = v_tenant_id
       AND "status" = p_expected_status;
  END IF;
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  RETURN v_changed = 1;
END;
$$;

REVOKE ALL ON FUNCTION app.mail_outbox_resend(UUID, public.mail_outbox_status, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.mail_outbox_resend(UUID, public.mail_outbox_status, TEXT)
  TO taxtronik_app;
GRANT EXECUTE ON FUNCTION app.mail_outbox_resend(UUID, public.mail_outbox_status, TEXT)
  TO taxtronik_owner;

COMMIT;
