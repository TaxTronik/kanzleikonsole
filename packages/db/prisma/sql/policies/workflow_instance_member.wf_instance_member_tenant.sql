CREATE POLICY wf_instance_member_tenant ON public.workflow_instance_member
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((EXISTS ( SELECT 1
   FROM public.workflow_instance wfi
  WHERE ((wfi.id = workflow_instance_member.instance_id) AND (wfi.tenant_id = app.current_tenant_id())))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM public.workflow_instance wfi
  WHERE ((wfi.id = workflow_instance_member.instance_id) AND (wfi.tenant_id = app.current_tenant_id())))));
