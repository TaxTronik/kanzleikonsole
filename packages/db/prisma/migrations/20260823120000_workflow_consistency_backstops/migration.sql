-- Workflow-/Auto-Request-Idempotenz und Storage-Orphan-Journal.
-- Alle Claims und Folgeartefakte werden in derselben Transaktion geschrieben;
-- die Unique-Constraints sind der letzte Backstop gegen parallele Aufrufer.

-- ---------------------------------------------------------------------------
-- Steuertermin -> genau eine automatisch erzeugte Anforderung
-- ---------------------------------------------------------------------------
ALTER TABLE "tax_deadline"
  ADD COLUMN "auto_request_claimed_at" TIMESTAMPTZ(6);

ALTER TABLE "request"
  ADD COLUMN "tax_deadline_id" UUID;

-- Historisch ungültige/doppelte Pointer werden ohne Löschung von Fachdaten
-- entkoppelt und am Termin selbst nachvollziehbar vermerkt.
UPDATE "tax_deadline" td
   SET "notes" = concat_ws(E'\n', NULLIF(td."notes", ''),
         '[Migration 20260823120000] Ungültige Request-Referenz entkoppelt.'),
       "request_id" = NULL,
       "status" = CASE WHEN td."status" = 'REMINDED' THEN 'PLANNED' ELSE td."status" END
 WHERE td."request_id" IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM "request" r
      WHERE r."id" = td."request_id"
        AND r."tenant_id" = td."tenant_id"
        AND r."client_id" = td."client_id"
   );

WITH ranked AS (
  SELECT td."id", td."request_id",
         row_number() OVER (
           PARTITION BY td."request_id"
           ORDER BY td."created_at", td."id"
         ) AS rn
    FROM "tax_deadline" td
   WHERE td."request_id" IS NOT NULL
)
UPDATE "tax_deadline" td
   SET "notes" = concat_ws(E'\n', NULLIF(td."notes", ''),
         '[Migration 20260823120000] Mehrfach verwendete Request-Referenz entkoppelt; kanonischer Termin bleibt verknüpft.'),
       "request_id" = NULL,
       "status" = CASE WHEN td."status" = 'REMINDED' THEN 'PLANNED' ELSE td."status" END
  FROM ranked r
 WHERE td."id" = r."id" AND r.rn > 1;

-- Bereits sauber verknüpfte Auto-Anforderungen bekommen ihre Herkunft
-- nachgetragen.
UPDATE "request" r
   SET "tax_deadline_id" = td."id"
 FROM "tax_deadline" td
 WHERE td."request_id" = r."id"
   AND td."tenant_id" = r."tenant_id"
   AND td."client_id" = r."client_id"
   AND r."tax_deadline_id" IS NULL;

CREATE UNIQUE INDEX "request_tax_deadline_unique"
  ON "request" ("tax_deadline_id");
CREATE UNIQUE INDEX "tax_deadline_request_unique"
  ON "tax_deadline" ("request_id");

ALTER TABLE "request"
  ADD CONSTRAINT "request_tax_deadline_fk"
  FOREIGN KEY ("tax_deadline_id") REFERENCES "tax_deadline"("id")
  ON DELETE SET NULL ON UPDATE NO ACTION;

ALTER TABLE "tax_deadline"
  ADD CONSTRAINT "tax_deadline_request_fk"
  FOREIGN KEY ("request_id") REFERENCES "request"("id")
  ON DELETE SET NULL ON UPDATE NO ACTION;

-- Beide Pointer sind bewusst vorhanden (Legacy-Leseweg auf tax_deadline und
-- Herkunfts-Unique auf request), dürfen aber nie auseinanderlaufen. Deferred
-- erlaubt das Anlegen beider Seiten innerhalb derselben Transaktion.
CREATE OR REPLACE FUNCTION enforce_tax_deadline_request_link()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_TABLE_NAME = 'tax_deadline' THEN
    IF NEW.request_id IS NULL THEN
      IF EXISTS (
        SELECT 1 FROM public."request" r
         WHERE r.tax_deadline_id = NEW.id
      ) THEN
        RAISE EXCEPTION 'tax_deadline/request pointer mismatch for deadline %', NEW.id;
      END IF;
    ELSE
      IF NOT EXISTS (
        SELECT 1 FROM public."request" r
         WHERE r.id = NEW.request_id
           AND r.tax_deadline_id = NEW.id
           AND r.tenant_id = NEW.tenant_id
           AND r.client_id = NEW.client_id
      ) THEN
        RAISE EXCEPTION 'tax_deadline/request pointer mismatch for deadline %', NEW.id;
      END IF;
    END IF;
  ELSE
    IF NEW.tax_deadline_id IS NULL THEN
      IF EXISTS (
        SELECT 1 FROM public.tax_deadline td
         WHERE td.request_id = NEW.id
      ) THEN
        RAISE EXCEPTION 'request/tax_deadline pointer mismatch for request %', NEW.id;
      END IF;
    ELSE
      IF NOT EXISTS (
        SELECT 1 FROM public.tax_deadline td
         WHERE td.id = NEW.tax_deadline_id
           AND td.request_id = NEW.id
           AND td.tenant_id = NEW.tenant_id
           AND td.client_id = NEW.client_id
      ) THEN
        RAISE EXCEPTION 'request/tax_deadline pointer mismatch for request %', NEW.id;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "tax_deadline_request_consistency"
AFTER INSERT OR UPDATE OF "request_id", "tenant_id", "client_id" ON "tax_deadline"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_tax_deadline_request_link();

CREATE CONSTRAINT TRIGGER "request_tax_deadline_consistency"
AFTER INSERT OR UPDATE OF "tax_deadline_id", "tenant_id", "client_id" ON "request"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_tax_deadline_request_link();

-- ---------------------------------------------------------------------------
-- Pro Workflow-Schritt höchstens ein Request-/Formular-Artefakt
-- ---------------------------------------------------------------------------
WITH duplicates AS (
  SELECT "workflow_item_id",
         min("id"::text)::uuid AS canonical_id,
         string_agg("id"::text, ', ' ORDER BY "created_at", "id") AS all_ids
    FROM "request"
   WHERE "workflow_item_id" IS NOT NULL
   GROUP BY "workflow_item_id"
  HAVING count(*) > 1
)
UPDATE "workflow_item" wi
   SET "notes" = concat_ws(E'\n', NULLIF(wi."notes", ''),
         '[Migration 20260823120000] Doppelte Request-Artefakte entkoppelt (frühester Datensatz bleibt kanonisch): ' || d.all_ids)
  FROM duplicates d
 WHERE wi."id" = d."workflow_item_id";

WITH ranked AS (
  SELECT "id", row_number() OVER (
           PARTITION BY "workflow_item_id" ORDER BY "created_at", "id"
         ) AS rn
    FROM "request"
   WHERE "workflow_item_id" IS NOT NULL
)
UPDATE "request" r
   SET "workflow_item_id" = NULL
  FROM ranked x
 WHERE r."id" = x."id" AND x.rn > 1;

DROP INDEX IF EXISTS "request_workflow_item_idx";
CREATE UNIQUE INDEX "request_workflow_item_unique"
  ON "request" ("workflow_item_id");

DROP INDEX IF EXISTS "form_submission_workflow_item_idx";
WITH duplicates AS (
  SELECT "workflow_item_id",
         string_agg("id"::text, ', ' ORDER BY "created_at", "id") AS all_ids
    FROM "form_submission"
   WHERE "workflow_item_id" IS NOT NULL
   GROUP BY "workflow_item_id"
  HAVING count(*) > 1
)
UPDATE "workflow_item" wi
   SET "notes" = concat_ws(E'\n', NULLIF(wi."notes", ''),
         '[Migration 20260823120000] Doppelte Formular-Artefakte entkoppelt (frühester Datensatz bleibt kanonisch): ' || d.all_ids)
  FROM duplicates d
 WHERE wi."id" = d."workflow_item_id";

WITH ranked AS (
  SELECT "id", row_number() OVER (
           PARTITION BY "workflow_item_id" ORDER BY "created_at", "id"
         ) AS rn
    FROM "form_submission"
   WHERE "workflow_item_id" IS NOT NULL
)
UPDATE "form_submission" s
   SET "workflow_item_id" = NULL
  FROM ranked x
 WHERE s."id" = x."id" AND x.rn > 1;

CREATE UNIQUE INDEX "form_submission_workflow_item_unique"
  ON "form_submission" ("workflow_item_id");

-- ---------------------------------------------------------------------------
-- Staff-only Kommentare an Mandanten-Anforderungen
-- ---------------------------------------------------------------------------
CREATE TABLE "request_internal_comment" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "request_id" UUID NOT NULL,
  "author_staff_id" UUID NOT NULL,
  "author_name" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "request_internal_comment_pk" PRIMARY KEY ("id"),
  CONSTRAINT "request_internal_comment_request_fk"
    FOREIGN KEY ("request_id") REFERENCES "request"("id")
    ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE INDEX "request_internal_comment_request_idx"
  ON "request_internal_comment" ("request_id", "created_at");

ALTER TABLE "request_internal_comment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "request_internal_comment" FORCE ROW LEVEL SECURITY;
CREATE POLICY "request_internal_comment_tenant" ON "request_internal_comment"
  USING (
    app.current_actor_type() IN ('STAFF', 'SYSTEM')
    AND EXISTS (
      SELECT 1 FROM "request" r
       WHERE r."id" = "request_internal_comment"."request_id"
         AND r."tenant_id" = app.current_tenant_id()
    )
  )
  WITH CHECK (
    app.current_actor_type() IN ('STAFF', 'SYSTEM')
    AND EXISTS (
      SELECT 1 FROM "request" r
       WHERE r."id" = "request_internal_comment"."request_id"
         AND r."tenant_id" = app.current_tenant_id()
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON "request_internal_comment" TO taxtronik_app;

-- ---------------------------------------------------------------------------
-- CLIENT_EMAIL: dauerhafter Zustand je Empfänger
-- ---------------------------------------------------------------------------
CREATE TABLE "workflow_email_recipient" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "item_id" UUID NOT NULL,
  "recipient_email" CITEXT NOT NULL,
  "recipient_name" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "body_text" TEXT NOT NULL,
  "body_html" TEXT NOT NULL,
  "claimed_at" TIMESTAMPTZ(6),
  "sent_at" TIMESTAMPTZ(6),
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "last_error" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "wf_email_recipient_pk" PRIMARY KEY ("id"),
  CONSTRAINT "wf_email_recipient_item_fk"
    FOREIGN KEY ("item_id") REFERENCES "workflow_item"("id")
    ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX "wf_email_recipient_item_email_uq"
  ON "workflow_email_recipient" ("item_id", "recipient_email");
CREATE INDEX "wf_email_recipient_pending_idx"
  ON "workflow_email_recipient" ("item_id", "sent_at");

ALTER TABLE "workflow_email_recipient" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workflow_email_recipient" FORCE ROW LEVEL SECURITY;
CREATE POLICY "wf_email_recipient_tenant" ON "workflow_email_recipient"
  USING (
    app.current_actor_type() IN ('STAFF', 'SYSTEM')
    AND EXISTS (
      SELECT 1
        FROM "workflow_item" wi
        JOIN "workflow_instance" wfi ON wfi."id" = wi."instance_id"
       WHERE wi."id" = "workflow_email_recipient"."item_id"
         AND wfi."tenant_id" = app.current_tenant_id()
    )
  )
  WITH CHECK (
    app.current_actor_type() IN ('STAFF', 'SYSTEM')
    AND EXISTS (
      SELECT 1
        FROM "workflow_item" wi
        JOIN "workflow_instance" wfi ON wfi."id" = wi."instance_id"
       WHERE wi."id" = "workflow_email_recipient"."item_id"
         AND wfi."tenant_id" = app.current_tenant_id()
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON "workflow_email_recipient" TO taxtronik_app;

-- ---------------------------------------------------------------------------
-- Durable Workflow -> n8n-Dispatches mit Outbox-Dedupe
-- ---------------------------------------------------------------------------
ALTER TABLE "n8n_outbox" ADD COLUMN "dedupe_key" VARCHAR(200);
CREATE UNIQUE INDEX "n8n_outbox_dedupe_key_uq" ON "n8n_outbox" ("dedupe_key");

CREATE TABLE "workflow_n8n_dispatch" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "item_id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  -- Snapshot statt FK: Recovery/Audit bleiben auch nach Ausscheiden des Staff-Akteurs möglich.
  "actor_staff_id" UUID NOT NULL,
  "event" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "claimed_at" TIMESTAMPTZ(6),
  "enqueued_at" TIMESTAMPTZ(6),
  "outbox_id" UUID,
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "last_error" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "wf_n8n_dispatch_pk" PRIMARY KEY ("id"),
  CONSTRAINT "wf_n8n_dispatch_item_fk"
    FOREIGN KEY ("item_id") REFERENCES "workflow_item"("id")
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "wf_n8n_dispatch_tenant_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id")
    ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX "wf_n8n_dispatch_item_uq" ON "workflow_n8n_dispatch" ("item_id");
CREATE INDEX "wf_n8n_dispatch_pending_idx"
  ON "workflow_n8n_dispatch" ("enqueued_at", "claimed_at", "created_at");

ALTER TABLE "workflow_n8n_dispatch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workflow_n8n_dispatch" FORCE ROW LEVEL SECURITY;
CREATE POLICY "wf_n8n_dispatch_tenant" ON "workflow_n8n_dispatch"
  USING (
    app.current_actor_type() IN ('STAFF', 'SYSTEM')
    AND "tenant_id" = app.current_tenant_id()
    AND EXISTS (
      SELECT 1
        FROM "workflow_item" wi
        JOIN "workflow_instance" wfi ON wfi."id" = wi."instance_id"
       WHERE wi."id" = "workflow_n8n_dispatch"."item_id"
         AND wfi."tenant_id" = "workflow_n8n_dispatch"."tenant_id"
    )
  )
  WITH CHECK (
    app.current_actor_type() IN ('STAFF', 'SYSTEM')
    AND "tenant_id" = app.current_tenant_id()
    AND EXISTS (
      SELECT 1
        FROM "workflow_item" wi
        JOIN "workflow_instance" wfi ON wfi."id" = wi."instance_id"
       WHERE wi."id" = "workflow_n8n_dispatch"."item_id"
         AND wfi."tenant_id" = "workflow_n8n_dispatch"."tenant_id"
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON "workflow_n8n_dispatch" TO taxtronik_app;

-- ---------------------------------------------------------------------------
-- Nachvollziehbare/aufräumbare Storage-Orphans
-- ---------------------------------------------------------------------------
CREATE TYPE "storage_orphan_resolution" AS ENUM ('DELETED', 'REFERENCED', 'INTEGRITY_INCIDENT');

CREATE TABLE "storage_orphan" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "source" TEXT NOT NULL,
  "storage_bucket" TEXT NOT NULL,
  "storage_key" TEXT NOT NULL,
  "storage_version_id" TEXT NOT NULL DEFAULT '',
  "sha256" BYTEA NOT NULL,
  "size_bytes" BIGINT NOT NULL,
  "immutable" BOOLEAN NOT NULL,
  "retention_until" TIMESTAMPTZ(6),
  "failure" TEXT,
  "cleanup_claimed_at" TIMESTAMPTZ(6),
  "cleanup_attempts" INTEGER NOT NULL DEFAULT 0,
  "cleanup_error" TEXT,
  "resolution" "storage_orphan_resolution",
  "cleaned_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "storage_orphan_pk" PRIMARY KEY ("id"),
  CONSTRAINT "storage_orphan_tenant_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id")
    ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX "storage_orphan_object_uq"
  ON "storage_orphan" ("storage_bucket", "storage_key", "storage_version_id");
CREATE INDEX "storage_orphan_cleanup_idx"
  ON "storage_orphan" ("tenant_id", "cleaned_at", "cleanup_claimed_at", "created_at");

-- Reconciliation muss vor jedem Delete kostenguenstig pruefen koennen, ob die
-- Storage-Identitaet trotz eines verlorenen COMMIT-ACK dauerhaft referenziert ist.
CREATE INDEX "document_version_storage_identity_idx"
  ON "document_version" ("storage_bucket", "storage_key", "storage_version_id");

ALTER TABLE "storage_orphan" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "storage_orphan" FORCE ROW LEVEL SECURITY;
CREATE POLICY "storage_orphan_tenant" ON "storage_orphan"
  USING (
    app.current_actor_type() IN ('STAFF', 'SYSTEM')
    AND "tenant_id" = app.current_tenant_id()
  )
  WITH CHECK (
    app.current_actor_type() IN ('STAFF', 'SYSTEM')
    AND "tenant_id" = app.current_tenant_id()
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON "storage_orphan" TO taxtronik_app;
