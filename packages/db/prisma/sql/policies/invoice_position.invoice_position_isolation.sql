CREATE POLICY invoice_position_isolation ON public.invoice_position
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((EXISTS ( SELECT 1
   FROM public.invoice i
  WHERE ((i.id = invoice_position.invoice_id) AND (i.tenant_id = app.current_tenant_id())))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM public.invoice i
  WHERE ((i.id = invoice_position.invoice_id) AND (i.tenant_id = app.current_tenant_id())))));
