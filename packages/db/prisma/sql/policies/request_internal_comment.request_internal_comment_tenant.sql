CREATE POLICY request_internal_comment_tenant ON public.request_internal_comment
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (((app.current_actor_type() = ANY (ARRAY['STAFF'::text, 'SYSTEM'::text])) AND (EXISTS ( SELECT 1
   FROM public.request r
  WHERE ((r.id = request_internal_comment.request_id) AND (r.tenant_id = app.current_tenant_id()))))))
  WITH CHECK (((app.current_actor_type() = ANY (ARRAY['STAFF'::text, 'SYSTEM'::text])) AND (EXISTS ( SELECT 1
   FROM public.request r
  WHERE ((r.id = request_internal_comment.request_id) AND (r.tenant_id = app.current_tenant_id()))))));
