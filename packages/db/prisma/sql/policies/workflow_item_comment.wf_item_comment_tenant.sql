CREATE POLICY wf_item_comment_tenant ON public.workflow_item_comment
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((EXISTS ( SELECT 1
   FROM (public.workflow_item wi
     JOIN public.workflow_instance wfi ON ((wfi.id = wi.instance_id)))
  WHERE ((wi.id = workflow_item_comment.item_id) AND (wfi.tenant_id = app.current_tenant_id())))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM (public.workflow_item wi
     JOIN public.workflow_instance wfi ON ((wfi.id = wi.instance_id)))
  WHERE ((wi.id = workflow_item_comment.item_id) AND (wfi.tenant_id = app.current_tenant_id())))));
