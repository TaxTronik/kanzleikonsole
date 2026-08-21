-- Dual Stamping: sparse, externally timestamped checkpoints over the local
-- audit hash chain. The business transaction never waits for the TSA.

CREATE TABLE "audit_anchor" (
    "id"                   BIGSERIAL     NOT NULL,
    "tenant_id"            UUID          NOT NULL,
    "from_audit_id"        BIGINT        NOT NULL,
    "top_audit_id"         BIGINT        NOT NULL,
    "top_hash"             BYTEA         NOT NULL,
    "previous_anchor_hash" BYTEA         NOT NULL,
    "anchor_hash"          BYTEA         NOT NULL,
    "tsa_request_blob"     BYTEA         NOT NULL,
    "tsa_response_blob"    BYTEA         NOT NULL,
    "tsa_serial"           TEXT,
    "tsa_gen_time"         TIMESTAMPTZ(6) NOT NULL,
    "trust_anchored"       BOOLEAN       NOT NULL DEFAULT false,
    "created_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_anchor_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "audit_anchor_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "audit_anchor_range_check" CHECK ("from_audit_id" <= "top_audit_id"),
    CONSTRAINT "audit_anchor_hash_length_check" CHECK (
      octet_length("top_hash") = 32
      AND octet_length("previous_anchor_hash") = 32
      AND octet_length("anchor_hash") = 32
    )
);

CREATE UNIQUE INDEX "audit_anchor_tenant_id_top_audit_id_key"
  ON "audit_anchor"("tenant_id", "top_audit_id");
-- One predecessor can have exactly one successor. This closes the MVCC race
-- where concurrent TSA calls selected different local tips from the same
-- external predecessor before either INSERT committed.
CREATE UNIQUE INDEX "audit_anchor_tenant_id_previous_anchor_hash_key"
  ON "audit_anchor"("tenant_id", "previous_anchor_hash");
CREATE INDEX "audit_anchor_tenant_id_id_idx" ON "audit_anchor"("tenant_id", "id");
CREATE INDEX "audit_anchor_tenant_id_tsa_gen_time_idx"
  ON "audit_anchor"("tenant_id", "tsa_gen_time");

ALTER TABLE "audit_anchor" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_anchor" FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_anchor_isolation ON "audit_anchor"
  USING ("tenant_id" = app.current_tenant_id())
  WITH CHECK ("tenant_id" = app.current_tenant_id());

CREATE TRIGGER audit_anchor_no_modify
  BEFORE UPDATE OR DELETE OR TRUNCATE ON "audit_anchor"
  FOR EACH STATEMENT EXECUTE FUNCTION app.prevent_modification();

GRANT SELECT, INSERT ON "audit_anchor" TO taxtronik_app;
GRANT USAGE, SELECT ON SEQUENCE "audit_anchor_id_seq" TO taxtronik_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "audit_anchor" FROM taxtronik_app;
