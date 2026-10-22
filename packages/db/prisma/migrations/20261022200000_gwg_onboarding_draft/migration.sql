-- GWG-SELF-ONBOARDING-001
--
-- Zwischenstand der Online-Einreichung je Einladung: Der Mandant kann neu laden
-- oder auf einem anderen Gerät (z. B. dem Smartphone für die Ausweisfotos)
-- weitermachen. Gespeichert werden nur die Formularangaben und Verweise auf die
-- bereits hochgeladenen Dateien der Einladung, keine Dateien.
--
-- Lebensdauer (Produktentscheidung 2026-10-22, fachliche Prüfung offen): keine
-- Löschung nach Zeitablauf. Der Zwischenstand endet mit der Einreichung (die
-- Daten stehen dann in der Prüfung), mit der Einladung (Anonymisierung des
-- Mandanten löscht sie, ON DELETE CASCADE) und bei der Vernichtung der Prüfung:
-- app.destroy_gwg_check anonymisiert die Einladung, statt sie zu löschen; der
-- Trigger unten entfernt dabei den Zwischenstand mit seinen Personendaten.
BEGIN;

CREATE TABLE public."gwg_onboarding_draft" (
  "invite_id"  UUID           NOT NULL,
  "tenant_id"  UUID           NOT NULL,
  "payload"    JSONB          NOT NULL,
  "revision"   INTEGER        NOT NULL DEFAULT 1,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "gwg_onboarding_draft_pkey" PRIMARY KEY ("invite_id"),
  CONSTRAINT "gwg_onboarding_draft_invite_id_fkey"
    FOREIGN KEY ("invite_id") REFERENCES public."gwg_onboarding_invite"("id")
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "gwg_onboarding_draft_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES public."tenant"("id")
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "gwg_onboarding_draft_revision_check" CHECK ("revision" > 0),
  -- Nur ein Formularstand, keine Dateien: Obergrenze gegen Missbrauch.
  CONSTRAINT "gwg_onboarding_draft_payload_check" CHECK (
    jsonb_typeof("payload") = 'object'
    AND octet_length("payload"::TEXT) <= 131072
  )
);
CREATE INDEX "gwg_onboarding_draft_tenant_id_idx"
  ON public."gwg_onboarding_draft"("tenant_id");

COMMENT ON TABLE public."gwg_onboarding_draft" IS
  'Zwischenstand der Online-Einreichung je Einladung (GWG-SELF-ONBOARDING-001); endet mit Einreichung, Einladung oder Vernichtung der Prüfung.';

ALTER TABLE public."gwg_onboarding_draft" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."gwg_onboarding_draft" FORCE ROW LEVEL SECURITY;

CREATE POLICY gwg_onboarding_draft_isolation ON public."gwg_onboarding_draft"
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (("tenant_id" = app.current_tenant_id()))
  WITH CHECK (("tenant_id" = app.current_tenant_id()));

-- Vernichtung der Prüfung: app.destroy_gwg_check setzt token_hash der
-- Einladungen auf 'vernichtet-<id>'. Der Zwischenstand derselben Einladung
-- (gleicher Mandant, gleiche Sitzung mit gesetztem Tenant-Kontext) entfällt.
CREATE FUNCTION app.gwg_onboarding_draft_drop_on_invite_destroyed()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  DELETE FROM public."gwg_onboarding_draft"
   WHERE "invite_id" = NEW."id"
     AND "tenant_id" = NEW."tenant_id";
  RETURN NEW;
END;
$function$;

CREATE TRIGGER gwg_onboarding_draft_drop_on_invite_destroyed
  AFTER UPDATE OF "token_hash" ON public."gwg_onboarding_invite"
  FOR EACH ROW
  WHEN (
    NEW."token_hash" LIKE 'vernichtet-%'
    AND OLD."token_hash" IS DISTINCT FROM NEW."token_hash"
  )
  EXECUTE FUNCTION app.gwg_onboarding_draft_drop_on_invite_destroyed();

COMMIT;
