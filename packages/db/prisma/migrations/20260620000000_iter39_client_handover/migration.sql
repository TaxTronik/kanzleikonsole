-- Iter. 39 — Mandanten-Anlieferungen (physische Unterlagen)
--
-- Mandant bringt Belege vorbei (ESt, FiBu, Verträge, …). Kanzlei trackt
-- den Vorgang vom Eingang über Bearbeitung bis zur Abholung.
--
-- Gegenstück zu PendingBinder (Iter. 34):
--   PendingBinder         Richtung Kanzlei → Mandant ("Pendelordner raus")
--   ClientHandover        Richtung Mandant → Kanzlei ("Anlieferung rein")
--
-- Status-Maschine:
--   RECEIVED     Eingegangen, noch nicht angefasst
--   IN_PROGRESS  In Bearbeitung (geöffnet, sortiert, ggf. gescannt)
--   READY        Bearbeitung fertig, Mandant kann abholen
--                (löst n8n-Event "client.handover.ready" → E-Mail aus)
--   PICKED_UP    Abgeholt — Vorgang abgeschlossen

CREATE TYPE "handover_status" AS ENUM (
    'RECEIVED',
    'IN_PROGRESS',
    'READY',
    'PICKED_UP'
);

CREATE TABLE "client_handover" (
    "id"                     UUID              NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id"              UUID              NOT NULL,
    "client_id"              UUID              NOT NULL,
    "label"                  TEXT              NOT NULL,
    "contents"               TEXT,
    "status"                 "handover_status" NOT NULL DEFAULT 'RECEIVED',
    "received_at"            TIMESTAMPTZ       NOT NULL DEFAULT now(),
    "started_at"             TIMESTAMPTZ,
    "ready_at"               TIMESTAMPTZ,
    "picked_up_at"           TIMESTAMPTZ,
    "created_by_staff"       UUID              NOT NULL,
    "notified_contact_email" TEXT,
    "created_at"             TIMESTAMPTZ       NOT NULL DEFAULT now(),
    "updated_at"             TIMESTAMPTZ       NOT NULL DEFAULT now(),

    CONSTRAINT "client_handover_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "client_handover_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE,
    CONSTRAINT "client_handover_client_id_fkey"
        FOREIGN KEY ("client_id") REFERENCES "client"("id") ON DELETE CASCADE,
    CONSTRAINT "client_handover_created_by_staff_fkey"
        FOREIGN KEY ("created_by_staff") REFERENCES "staff_user"("id") ON DELETE RESTRICT
);

CREATE INDEX "client_handover_tenant_status_idx"
    ON "client_handover"("tenant_id", "status");
CREATE INDEX "client_handover_client_status_idx"
    ON "client_handover"("client_id", "status");

ALTER TABLE "client_handover" ENABLE ROW LEVEL SECURITY;
CREATE POLICY client_handover_isolation ON "client_handover"
    USING ("tenant_id" = app.current_tenant_id())
    WITH CHECK ("tenant_id" = app.current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON "client_handover" TO taxtronik_app;
