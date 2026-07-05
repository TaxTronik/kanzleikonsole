-- ----------------------------------------------------------------------------
-- iter96: ELSTER-Kontoabfrage (Stufe 2 über die eric-bridge).
--
-- 1. client.steuernummer — 13-stelliges ELSTER-Bundesformat, EINE pro Mandant
--    (Tochtergesellschaften/Betriebsstätten mit eigener StNr = eigene
--    Mandanten). Format wird app-seitig validiert (zod, ^[0-9]{13}$).
-- 2. elster_kontoabfrage — persistierte Abruf-Historie: jeder Abruf ist ein
--    Vorgang beim ELSTER-Server (kostenrelevant, nachweispflichtig). Die
--    Portalzertifikat-PIN wird NIE persistiert. Append-only für die App
--    (kein UPDATE/DELETE-Grant) — die Historie ist Vorgangsnachweis.
-- ----------------------------------------------------------------------------

ALTER TABLE "client" ADD COLUMN "steuernummer" TEXT;

CREATE TABLE "elster_kontoabfrage" (
    "id"               UUID         NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id"        UUID         NOT NULL,
    "client_id"        UUID         NOT NULL,
    "art"              TEXT         NOT NULL,
    "steuerart"        TEXT,
    "zeitraum"         TEXT,
    "echtfall"         BOOLEAN      NOT NULL DEFAULT false,
    "ok"               BOOLEAN      NOT NULL,
    "return_code"      INTEGER      NOT NULL,
    "nutzdaten_ticket" TEXT,
    "result"           TEXT,
    "error_text"       TEXT,
    "requested_by"     UUID         NOT NULL,
    "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "elster_kontoabfrage_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "elster_kontoabfrage_client_fkey"
        FOREIGN KEY ("client_id") REFERENCES "client"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "elster_kontoabfrage_tenant_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE INDEX "elster_kontoabfrage_tenant_id_client_id_created_at_idx"
    ON "elster_kontoabfrage"("tenant_id", "client_id", "created_at");

ALTER TABLE "elster_kontoabfrage" ENABLE ROW LEVEL SECURITY;
CREATE POLICY elster_kontoabfrage_isolation ON "elster_kontoabfrage"
    USING ("tenant_id" = app.current_tenant_id())
    WITH CHECK ("tenant_id" = app.current_tenant_id());
ALTER TABLE "elster_kontoabfrage" FORCE ROW LEVEL SECURITY;

-- Append-only: Abruf-Historie ist Vorgangsnachweis — die App liest und legt an,
-- ändert/löscht aber nie.
GRANT SELECT, INSERT ON "elster_kontoabfrage" TO taxtronik_app;
