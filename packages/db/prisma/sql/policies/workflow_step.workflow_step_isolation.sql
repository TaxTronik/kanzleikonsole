CREATE POLICY workflow_step_isolation ON public.workflow_step
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((EXISTS ( SELECT 1
   FROM public.workflow_template t
  WHERE ((t.id = workflow_step.template_id) AND (t.tenant_id = app.current_tenant_id())))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM public.workflow_template t
  WHERE ((t.id = workflow_step.template_id) AND (t.tenant_id = app.current_tenant_id())))));
