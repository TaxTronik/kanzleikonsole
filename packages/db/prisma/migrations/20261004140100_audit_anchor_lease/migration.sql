-- AUDIT-RFC3161-ANCHOR-001 / ACCESS-TENANT-RLS-001.
--
-- Tenant-Lease des Rolling-Anchor-Workers (Review P-05). Bisher hielt der
-- Worker während des TSA-HTTP-Aufrufs eine Owner-Transaktion mit
-- pg_try_advisory_xact_lock offen und damit eine Pool-Verbindung; langsame
-- TSA-Antworten blockierten so andere Jobs. Jetzt wird vor dem Aufruf ein kurz
-- committeter Lease je Tenant beansprucht (mit Ablaufzeit), unmittelbar vor
-- der Anfrage bestätigt und nach dem bedingten Insert freigegeben. Während der
-- Anfrage hält der Worker weder Transaktion noch Verbindung.
--
-- Abgeleiteter Koordinationszustand, kein Beweismittel. Nur der Owner (Worker)
-- liest und schreibt; die App-Rolle erhält keinerlei Tabellenrechte.
BEGIN;

CREATE TABLE public."audit_anchor_lease" (
  "tenant_id"   UUID           NOT NULL,
  "holder"      UUID           NOT NULL,
  "acquired_at" TIMESTAMPTZ(6) NOT NULL,
  "expires_at"  TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "audit_anchor_lease_pkey" PRIMARY KEY ("tenant_id"),
  CONSTRAINT "audit_anchor_lease_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "audit_anchor_lease_expiry_check" CHECK ("expires_at" > "acquired_at")
);

COMMENT ON TABLE public."audit_anchor_lease" IS
  'Owner-only Tenant-Lease des Rolling-Anchor-Workers (Koordinationszustand, kein Beweismittel).';

ALTER TABLE public."audit_anchor_lease" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."audit_anchor_lease" FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_anchor_lease_isolation ON public."audit_anchor_lease"
  USING ("tenant_id" = app.current_tenant_id())
  WITH CHECK ("tenant_id" = app.current_tenant_id());

-- Die Default-Privilegien des Schemas gewähren neuen Tabellen Rechte an die
-- App-Rolle; hier vollständig zurücknehmen.
REVOKE ALL ON TABLE public."audit_anchor_lease" FROM PUBLIC;
REVOKE ALL ON TABLE public."audit_anchor_lease" FROM taxtronik_app;

COMMIT;
