-- Interne Request-Kommentare sind nicht nur auf Anwendungsebene, sondern auch
-- per RLS vom Mandantenportal getrennt. SYSTEM bleibt für Reconciliation und
-- revisionssichere Betriebsabläufe zugelassen.
DROP POLICY "request_internal_comment_tenant" ON "request_internal_comment";

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
