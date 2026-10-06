-- Fachkatalog: ACCESS-TENANT-RLS-001
--
-- Review-Befund F-08: Mandanten-Mails (neue Anforderung, GwG-Einladung,
-- Terminentscheidung, Rechnungsversand u. a.) gingen nach dem fachlichen
-- Commit per nicht abgewarteter Promise direkt an SMTP. Ein Fehler wurde nur
-- geloggt, die Oberfläche zeigte den Versand trotzdem als erledigt.
--
-- mail_outbox hält den Versandauftrag im selben Commit wie den fachlichen
-- Vorgang. Der Worker (mail-outbox-deliver) stellt zu, wiederholt eindeutig
-- gescheiterte Versuche mit Backoff und endet in einem Terminalstatus; bei
-- Fehlschlag, Teilzustellung oder unklarem Ausgang erhält die Kanzlei eine
-- Benachrichtigung. Wie bei den Steuertermin-Anforderungen ist SENDING ein
-- fail-closed In-Flight-Claim: ein abgebrochener Versuch wird nie blind
-- wiederholt.
--
-- Datenhaltung: Empfängeradresse, Template-Variablen und Anhangsverweise
-- liegen nur bis zum Terminalstatus im payload; danach bleiben ausschließlich
-- Status, Zähler, Zeitpunkte und Verweise auf den Vorgang. Geheime Variablen
-- (Einladungslink mit Token) liegen nur Secret-Box-verschlüsselt in
-- secret_vars_enc und werden mit dem Terminalstatus entfernt (CHECK).
--
-- Tenant-Isolation wie die n8n-Outbox-Tabellen (ENABLE + FORCE RLS, eine
-- Isolation-Policy) plus zentraler Paar-Guard. Die App-Rolle schreibt nur im
-- fachlichen Commit (INSERT) und liest den Status (SELECT); Zustellung und
-- Statuswechsel laufen ausschließlich im Worker (Owner).

BEGIN;

CREATE TYPE public.mail_outbox_kind AS ENUM ('DIRECT', 'CLIENT_CONTACTS');
CREATE TYPE public.mail_outbox_status AS ENUM (
  'QUEUED',
  'SENDING',
  'RETRY_PENDING',
  'PROVIDER_ACCEPTED',
  'PARTIAL_FAILURE',
  'NO_RECIPIENT',
  'FAILED',
  'UNKNOWN'
);

CREATE TABLE public."mail_outbox" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "client_id" UUID NOT NULL,
  "kind" public.mail_outbox_kind NOT NULL,
  "purpose" TEXT NOT NULL,
  "resource_type" TEXT NOT NULL,
  "resource_id" UUID NOT NULL,
  "staff_href" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "secret_vars_enc" TEXT,
  "status" public.mail_outbox_status NOT NULL DEFAULT 'QUEUED',
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
  "last_attempt_at" TIMESTAMPTZ(6),
  "accepted_at" TIMESTAMPTZ(6),
  "recipients_attempted" INTEGER,
  "recipients_accepted" INTEGER,
  "last_error" TEXT,
  "escalated_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "mail_outbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "mail_outbox_purpose_check" CHECK ("purpose" ~ '^[a-z][a-z0-9-]{0,63}$'),
  CONSTRAINT "mail_outbox_resource_type_check" CHECK ("resource_type" ~ '^[a-z][a-z_]{0,63}$'),
  CONSTRAINT "mail_outbox_staff_href_check" CHECK ("staff_href" LIKE '/staff/%'),
  CONSTRAINT "mail_outbox_payload_check" CHECK (jsonb_typeof("payload") = 'object'),
  CONSTRAINT "mail_outbox_attempt_count_check" CHECK ("attempt_count" >= 0),
  CONSTRAINT "mail_outbox_recipients_check" CHECK (
    ("recipients_attempted" IS NULL OR "recipients_attempted" >= 0)
    AND ("recipients_accepted" IS NULL OR "recipients_accepted" >= 0)
    AND (
      "recipients_attempted" IS NULL
      OR "recipients_accepted" IS NULL
      OR "recipients_accepted" <= "recipients_attempted"
    )
  ),
  -- Nur wartende Aufträge tragen einen nächsten Versuchszeitpunkt.
  CONSTRAINT "mail_outbox_schedule_check" CHECK (
    ("status" IN ('QUEUED', 'RETRY_PENDING')) = ("next_attempt_at" IS NOT NULL)
  ),
  -- Geheime Variablen überleben keinen Terminalstatus.
  CONSTRAINT "mail_outbox_secret_check" CHECK (
    "secret_vars_enc" IS NULL OR "status" IN ('QUEUED', 'SENDING', 'RETRY_PENDING')
  )
);

ALTER TABLE public."mail_outbox" ADD CONSTRAINT "mail_outbox_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES public."tenant"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE public."mail_outbox" ADD CONSTRAINT "mail_outbox_client_fkey"
  FOREIGN KEY ("tenant_id", "client_id") REFERENCES public."client"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

-- Zustellungsscan des Workers (fällige QUEUED/RETRY_PENDING, hängende SENDING).
CREATE INDEX "mail_outbox_status_next_attempt_idx"
  ON public."mail_outbox"("status", "next_attempt_at");
-- Zustellstatus am Vorgang (Rechnung, Anforderung, Einladung, ...).
CREATE INDEX "mail_outbox_resource_idx"
  ON public."mail_outbox"("tenant_id", "resource_type", "resource_id", "created_at");
-- Mandantenbezug; trägt zugleich beide Fremdschlüssel.
CREATE INDEX "mail_outbox_client_created_idx"
  ON public."mail_outbox"("tenant_id", "client_id", "created_at");

CREATE TRIGGER "00_tenant_client_pair_integrity"
  BEFORE INSERT OR UPDATE OF tenant_id, client_id ON public."mail_outbox"
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant_client_pair_integrity();

ALTER TABLE public."mail_outbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."mail_outbox" FORCE ROW LEVEL SECURITY;
CREATE POLICY mail_outbox_isolation ON public."mail_outbox"
  USING ("tenant_id" = app.current_tenant_id())
  WITH CHECK ("tenant_id" = app.current_tenant_id());

-- Die Default-Privilegien des Schemas geben der App-Rolle auch UPDATE/DELETE;
-- Statuswechsel und Bereinigung bleiben dem Worker vorbehalten.
REVOKE ALL ON public."mail_outbox" FROM PUBLIC, taxtronik_app;
GRANT SELECT, INSERT ON public."mail_outbox" TO taxtronik_app;

COMMIT;
