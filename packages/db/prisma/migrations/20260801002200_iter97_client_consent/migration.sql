-- ----------------------------------------------------------------------------
-- iter97: client_consent — Datenschutz-Einwilligungen des Mandanten.
--
-- DSGVO Art. 6/7 + § 11 StBerG: die zur Mandatsbearbeitung erforderliche
-- Verarbeitung stützt sich auf Vertrag/gesetzliche Pflicht/berechtigtes
-- Interesse — NICHT auf pauschale Einwilligung. Freiwillige Einwilligungen
-- (Kommunikationskanäle, Marketing, Weitergabe an benannte Dritte,
-- Spezialdienstleister) werden hier granular und nachweissicher erfasst.
--
-- Append-only Historie: jeder Datensatz ist ein vollständiger Snapshot; der
-- neueste je Mandant ist maßgeblich. Widerruf (Art. 7 Abs. 3) = neuer Snapshot.
-- notice_snapshot friert den exakt gezeigten Hinweistext ein (Nachweis).
-- Die App liest und legt an, ändert/löscht aber nie (Vorgangsnachweis).
-- ----------------------------------------------------------------------------

CREATE TABLE "client_consent" (
    "id"                UUID         NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id"         UUID         NOT NULL,
    "client_id"         UUID         NOT NULL,
    "notice_version"    INTEGER      NOT NULL,
    "notice_snapshot"   TEXT         NOT NULL,
    "consents"          JSONB        NOT NULL,
    "source"            TEXT         NOT NULL,
    "signed_by_name"    TEXT         NOT NULL,
    "signed_by_contact" UUID,
    "is_revocation"     BOOLEAN      NOT NULL DEFAULT false,
    "note"              TEXT,
    "created_by"        UUID,
    "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_consent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "client_consent_client_fkey"
        FOREIGN KEY ("client_id") REFERENCES "client"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "client_consent_tenant_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE INDEX "client_consent_tenant_id_client_id_created_at_idx"
    ON "client_consent"("tenant_id", "client_id", "created_at");

ALTER TABLE "client_consent" ENABLE ROW LEVEL SECURITY;
CREATE POLICY client_consent_isolation ON "client_consent"
    USING ("tenant_id" = app.current_tenant_id())
    WITH CHECK ("tenant_id" = app.current_tenant_id());
ALTER TABLE "client_consent" FORCE ROW LEVEL SECURITY;

-- Append-only: Einwilligungs-Historie ist Vorgangsnachweis (DSGVO-Rechenschaft,
-- Art. 5 Abs. 2) — die App liest und legt an, ändert/löscht aber nie.
GRANT SELECT, INSERT ON "client_consent" TO taxtronik_app;
