CREATE POLICY request_response_isolation ON public.request_response
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((EXISTS ( SELECT 1
   FROM public.request r
  WHERE ((r.id = request_response.request_id) AND (r.tenant_id = app.current_tenant_id())))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM public.request r
  WHERE ((r.id = request_response.request_id) AND (r.tenant_id = app.current_tenant_id())))));
