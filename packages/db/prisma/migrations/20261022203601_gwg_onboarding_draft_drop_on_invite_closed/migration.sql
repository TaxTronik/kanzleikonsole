-- GWG-SELF-ONBOARDING-001.
--
-- Zwischenstand der Online-Einreichung auch bei Widerruf und Ablösung löschen
-- (Produktentscheidung 2026-10-22). Zieht die Kanzlei eine Einladung zurück
-- oder ersetzt sie durch eine neue – ebenso bei einer veralteten Revision, der
-- Einreichung einer anderen Einladung oder „In der Kanzlei erfassen“ –, setzt
-- jeder Pfad status = 'CANCELLED' und entwertet den Token. Der Zwischenstand
-- lässt sich dann nie mehr öffnen; er wird mit seinen Personendaten gelöscht.
-- Abgelaufene, nie eingereichte Einladungen behalten ihn weiterhin.
--
-- Der bisherige Trigger für die Vernichtung der Prüfung (token_hash
-- 'vernichtet-…') geht in einem allgemeinen Trigger auf; Funktion und Trigger
-- heißen deshalb jetzt …_drop_on_invite_closed. Zwischenstände bereits
-- zurückgezogener Einladungen werden am Ende einmalig entfernt.
--
-- Erzeugt mit `pnpm db:sql:migration` aus packages/db/prisma/sql
-- (docs/development/kanonische-sql-quellen.md):
--   neu:      functions/app.gwg_onboarding_draft_drop_on_invite_closed().sql
--   entfernt: functions/app.gwg_onboarding_draft_drop_on_invite_destroyed().sql
--   neu:      triggers/gwg_onboarding_invite.gwg_onboarding_draft_drop_on_invite_closed.sql
--   entfernt: triggers/gwg_onboarding_invite.gwg_onboarding_draft_drop_on_invite_destroyed.sql
BEGIN;

DROP TRIGGER gwg_onboarding_draft_drop_on_invite_destroyed ON public.gwg_onboarding_invite;

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

CREATE TRIGGER gwg_onboarding_draft_drop_on_invite_closed AFTER UPDATE OF status, token_hash ON public.gwg_onboarding_invite FOR EACH ROW WHEN ((((new.status = 'CANCELLED'::gwg_invite_status) AND (old.status IS DISTINCT FROM new.status)) OR ((new.token_hash ~~ 'vernichtet-%'::text) AND (old.token_hash IS DISTINCT FROM new.token_hash)))) EXECUTE FUNCTION app.gwg_onboarding_draft_drop_on_invite_closed();

DROP FUNCTION app.gwg_onboarding_draft_drop_on_invite_destroyed();

-- Bestand: Zwischenstände bereits zurückgezogener oder abgelöster Einladungen.
DELETE FROM public."gwg_onboarding_draft" AS draft
 USING public."gwg_onboarding_invite" AS invite
 WHERE invite."id" = draft."invite_id"
   AND invite."tenant_id" = draft."tenant_id"
   AND invite."status" = 'CANCELLED';

COMMIT;
