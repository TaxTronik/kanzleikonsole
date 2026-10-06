CREATE POLICY workflow_item_isolation ON public.workflow_item
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((EXISTS ( SELECT 1
   FROM public.workflow_instance i
  WHERE ((i.id = workflow_item.instance_id) AND (i.tenant_id = app.current_tenant_id())))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM public.workflow_instance i
  WHERE ((i.id = workflow_item.instance_id) AND (i.tenant_id = app.current_tenant_id())))));
