CREATE POLICY bwa_position_isolation ON public.bwa_position
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((EXISTS ( SELECT 1
   FROM public.bwa_period p
  WHERE ((p.id = bwa_position.period_id) AND (p.tenant_id = app.current_tenant_id())))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM public.bwa_period p
  WHERE ((p.id = bwa_position.period_id) AND (p.tenant_id = app.current_tenant_id())))));
