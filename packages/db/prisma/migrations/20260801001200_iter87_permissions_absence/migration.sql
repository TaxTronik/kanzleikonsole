-- =============================================================================
-- iter87: Granulare Berechtigungen je Mitarbeiter + generische Abwesenheit
--
-- 1) staff_permission: Einzelrechte (INVOICE_MANAGE/INVOICE_SEND/ABSENCE_DECIDE).
--    ADMIN/PARTNER haben implizit alles (App-Schicht); EMPLOYEE braucht den
--    expliziten Grant. Backfill: alle aktiven Bestandsmitarbeiter erhalten die
--    INVOICE_*-Rechte — vor iter87 durfte JEDER aktive Mitarbeiter Rechnungen
--    anlegen und versenden, das Update ändert also kein Verhalten; Admins
--    entziehen danach gezielt. ABSENCE_DECIDE wird NICHT backfilled:
--    Urlaubsentscheidungen waren schon immer Admin/Partner-only.
--
-- 2) sick_leave → absence: Generalisierung der Krankmeldung zur
--    Abwesenheitsmeldung mit Art (kind). Bestandsdaten werden zu SICKNESS.
--    Constraint-/Index-/Policy-Namen werden an die Prisma-Konvention
--    angeglichen, damit der Schema-Drift-Check sauber bleibt.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) Berechtigungen
-- ---------------------------------------------------------------------------
CREATE TYPE "staff_permission_name" AS ENUM ('INVOICE_MANAGE', 'INVOICE_SEND', 'ABSENCE_DECIDE');

CREATE TABLE "staff_permission" (
    "staff_user_id" UUID                    NOT NULL,
    "permission"    "staff_permission_name" NOT NULL,
    "granted_by"    UUID,
    "granted_at"    TIMESTAMP(3)            NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_permission_pkey" PRIMARY KEY ("staff_user_id", "permission"),
    CONSTRAINT "staff_permission_staff_user_id_fkey"
        FOREIGN KEY ("staff_user_id") REFERENCES "staff_user"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RLS wie staff_role: Tenant-Bezug über den zugehörigen staff_user.
ALTER TABLE "staff_permission" ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_permission_isolation ON "staff_permission"
    USING (EXISTS (
        SELECT 1 FROM "staff_user" su
        WHERE su.id = "staff_permission"."staff_user_id"
          AND su.tenant_id = app.current_tenant_id()
    ));
ALTER TABLE "staff_permission" FORCE ROW LEVEL SECURITY;

-- Minimalrechte: Grants werden angelegt/entzogen, nie geändert (kein UPDATE).
GRANT SELECT, INSERT, DELETE ON "staff_permission" TO taxtronik_app;

-- Backfill (siehe Kopfkommentar): Status quo bleibt erhalten.
INSERT INTO "staff_permission" ("staff_user_id", "permission")
SELECT "id", 'INVOICE_MANAGE'::"staff_permission_name" FROM "staff_user" WHERE "active";
INSERT INTO "staff_permission" ("staff_user_id", "permission")
SELECT "id", 'INVOICE_SEND'::"staff_permission_name" FROM "staff_user" WHERE "active";

-- ---------------------------------------------------------------------------
-- 2) sick_leave → absence
-- ---------------------------------------------------------------------------
CREATE TYPE "absence_kind" AS ENUM ('SICKNESS', 'OTHER');

ALTER TABLE "sick_leave" RENAME TO "absence";
ALTER TABLE "absence" ADD COLUMN "kind" "absence_kind" NOT NULL DEFAULT 'SICKNESS';

-- Namen an Prisma-Konvention angleichen (RLS-Policy folgt dem Rename von selbst).
ALTER INDEX "sick_leave_pkey" RENAME TO "absence_pkey";
ALTER INDEX "sick_leave_tenant_id_staff_id_start_date_idx" RENAME TO "absence_tenant_id_staff_id_start_date_idx";
ALTER TABLE "absence" RENAME CONSTRAINT "sick_leave_staff_id_fkey" TO "absence_staff_id_fkey";
ALTER TABLE "absence" RENAME CONSTRAINT "sick_leave_document_id_fkey" TO "absence_document_id_fkey";
ALTER POLICY sick_leave_isolation ON "absence" RENAME TO absence_isolation;

-- ---------------------------------------------------------------------------
-- 3) Benachrichtigungen an Entscheidungsträger (neue Kinds)
-- ---------------------------------------------------------------------------
ALTER TYPE "notification_kind" ADD VALUE 'VACATION_REQUESTED';
ALTER TYPE "notification_kind" ADD VALUE 'ABSENCE_REPORTED';
