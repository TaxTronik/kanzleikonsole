CREATE POLICY stbvv_quote_export_select ON public.stbvv_quote_export
  AS PERMISSIVE
  FOR SELECT
  TO PUBLIC
  USING (((tenant_id = app.current_tenant_id()) AND ((app.current_actor_type() = 'SYSTEM'::text) OR ((app.current_actor_type() = 'STAFF'::text) AND (EXISTS ( SELECT 1
   FROM (public.stbvv_quote q
     JOIN public.invoice i ON ((i.id = stbvv_quote_export.invoice_id)))
  WHERE ((q.id = stbvv_quote_export.quote_id) AND (q.tenant_id = stbvv_quote_export.tenant_id) AND (i.tenant_id = q.tenant_id) AND (i.client_id = q.client_id))))))));
