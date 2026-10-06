CREATE POLICY bwa_plan_line_isolation ON public.bwa_plan_line
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((EXISTS ( SELECT 1
   FROM public.bwa_plan p
  WHERE ((p.id = bwa_plan_line.plan_id) AND (p.tenant_id = app.current_tenant_id())))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM public.bwa_plan p
  WHERE ((p.id = bwa_plan_line.plan_id) AND (p.tenant_id = app.current_tenant_id())))));
