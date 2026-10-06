CREATE POLICY storage_orphan_tenant ON public.storage_orphan
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (((app.current_actor_type() = ANY (ARRAY['STAFF'::text, 'SYSTEM'::text])) AND (tenant_id = app.current_tenant_id())))
  WITH CHECK (((app.current_actor_type() = ANY (ARRAY['STAFF'::text, 'SYSTEM'::text])) AND (tenant_id = app.current_tenant_id())));
