-- Iter. 37 — Kanzleikalender
--
-- "Steuertermine" wird zum "Kanzleikalender": neben tax_deadline gibt es jetzt
--   appointment           — generischer Termin (Mandanten-Meeting, intern,
--                            privat); jeder Termin hat einen ownerStaff
--                            (für wen) + createdByStaff (wer angelegt).
--   appointment_request   — Anfrage des Mandanten aus dem Portal: 1–3
--                            Wunschtermine + Anliegen. Kanzlei akzeptiert
--                            (erzeugt appointment) oder lehnt ab.
--
-- Steuertermine bleiben unverändert im tax_deadline-Modell — die Kalender-
-- Ansicht zieht beide zusammen.

-- 1. Enums --------------------------------------------------------------------

CREATE TYPE "appointment_kind" AS ENUM (
    'CLIENT_MEETING',
    'INTERNAL',
    'PRIVATE'
);

CREATE TYPE "appointment_status" AS ENUM (
    'PLANNED',
    'CONFIRMED',
    'CANCELLED',
    'DONE'
);

CREATE TYPE "appointment_request_status" AS ENUM (
    'PENDING',
    'ACCEPTED',
    'REJECTED',
    'CANCELLED'
);

-- 2. appointment-Tabelle ------------------------------------------------------

CREATE TABLE "appointment" (
    "id"               UUID                NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id"        UUID                NOT NULL,
    "owner_staff_id"   UUID                NOT NULL,
    "created_by_staff" UUID                NOT NULL,
    "client_id"        UUID,
    "kind"             "appointment_kind"  NOT NULL DEFAULT 'CLIENT_MEETING',
    "status"           "appointment_status" NOT NULL DEFAULT 'PLANNED',
    "title"            TEXT                NOT NULL,
    "notes"            TEXT,
    "location"         TEXT,
    "starts_at"        TIMESTAMPTZ         NOT NULL,
    "ends_at"          TIMESTAMPTZ         NOT NULL,
    "from_request_id"  UUID,
    "created_at"       TIMESTAMPTZ         NOT NULL DEFAULT now(),
    "updated_at"       TIMESTAMPTZ         NOT NULL DEFAULT now(),

    CONSTRAINT "appointment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "appointment_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE,
    CONSTRAINT "appointment_owner_staff_id_fkey"
        FOREIGN KEY ("owner_staff_id") REFERENCES "staff_user"("id") ON DELETE RESTRICT,
    CONSTRAINT "appointment_created_by_staff_fkey"
        FOREIGN KEY ("created_by_staff") REFERENCES "staff_user"("id") ON DELETE RESTRICT,
    CONSTRAINT "appointment_client_id_fkey"
        FOREIGN KEY ("client_id") REFERENCES "client"("id") ON DELETE SET NULL,
    CONSTRAINT "appointment_time_chk" CHECK ("ends_at" > "starts_at")
);

CREATE INDEX "appointment_tenant_starts_idx" ON "appointment"("tenant_id", "starts_at");
CREATE INDEX "appointment_tenant_owner_idx" ON "appointment"("tenant_id", "owner_staff_id");
CREATE INDEX "appointment_tenant_client_idx" ON "appointment"("tenant_id", "client_id");

-- 4. appointment_request-Tabelle ---------------------------------------------

CREATE TABLE "appointment_request" (
    "id"              UUID                          NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id"       UUID                          NOT NULL,
    "client_id"       UUID                          NOT NULL,
    -- ClientContact, der die Anfrage gestellt hat (nullable: Staff legt im Auftrag an)
    "created_by_contact" UUID,
    -- Wunsch-Bearbeiter (z. B. immer ein Berufsträger)
    "preferred_staff_id" UUID,
    "subject"         TEXT                          NOT NULL,
    "notes"           TEXT,
    -- Bis zu 3 Wunschtermine, als JSON-Array von {startsAt, endsAt}
    "proposed_slots"  JSONB                         NOT NULL,
    "status"          "appointment_request_status"  NOT NULL DEFAULT 'PENDING',
    "accepted_slot"   JSONB,
    "accepted_appointment_id" UUID,
    "rejection_reason" TEXT,
    "decided_by_staff" UUID,
    "decided_at"      TIMESTAMPTZ,
    "created_at"      TIMESTAMPTZ                   NOT NULL DEFAULT now(),
    "updated_at"      TIMESTAMPTZ                   NOT NULL DEFAULT now(),

    CONSTRAINT "appointment_request_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "appointment_request_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE,
    CONSTRAINT "appointment_request_client_id_fkey"
        FOREIGN KEY ("client_id") REFERENCES "client"("id") ON DELETE CASCADE,
    CONSTRAINT "appointment_request_contact_fkey"
        FOREIGN KEY ("created_by_contact") REFERENCES "client_contact"("id") ON DELETE SET NULL,
    CONSTRAINT "appointment_request_preferred_staff_fkey"
        FOREIGN KEY ("preferred_staff_id") REFERENCES "staff_user"("id") ON DELETE SET NULL,
    CONSTRAINT "appointment_request_decided_by_fkey"
        FOREIGN KEY ("decided_by_staff") REFERENCES "staff_user"("id") ON DELETE SET NULL,
    CONSTRAINT "appointment_request_accepted_appointment_fkey"
        FOREIGN KEY ("accepted_appointment_id") REFERENCES "appointment"("id") ON DELETE SET NULL
);

CREATE INDEX "appointment_request_tenant_status_idx"
    ON "appointment_request"("tenant_id", "status", "created_at" DESC);
CREATE INDEX "appointment_request_client_idx"
    ON "appointment_request"("tenant_id", "client_id");

-- 5. FK von appointment.from_request_id auf appointment_request --------------
--    (wir hängen ihn nachträglich, weil die Tabellen zyklisch sind)

ALTER TABLE "appointment"
    ADD CONSTRAINT "appointment_from_request_fkey"
        FOREIGN KEY ("from_request_id") REFERENCES "appointment_request"("id") ON DELETE SET NULL;

-- 6. RLS + GRANT --------------------------------------------------------------

ALTER TABLE "appointment" ENABLE ROW LEVEL SECURITY;
CREATE POLICY appointment_isolation ON "appointment"
    USING ("tenant_id" = app.current_tenant_id())
    WITH CHECK ("tenant_id" = app.current_tenant_id());

ALTER TABLE "appointment_request" ENABLE ROW LEVEL SECURITY;
CREATE POLICY appointment_request_isolation ON "appointment_request"
    USING ("tenant_id" = app.current_tenant_id())
    WITH CHECK ("tenant_id" = app.current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON "appointment"         TO taxtronik_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "appointment_request" TO taxtronik_app;
