-- =============================================================================
-- Iter. 5b: Client um Rechnungs-Stammdaten erweitern (XRechnung-Pflichtfelder)
-- =============================================================================

ALTER TABLE "client"
    ADD COLUMN "street"        TEXT,
    ADD COLUMN "postal_code"   TEXT,
    ADD COLUMN "city"          TEXT,
    ADD COLUMN "country_iso"   TEXT,
    ADD COLUMN "vat_id"        TEXT,
    ADD COLUMN "invoice_email" CITEXT;
