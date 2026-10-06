CREATE POLICY wf_n8n_dispatch_tenant ON public.workflow_n8n_dispatch
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (((app.current_actor_type() = ANY (ARRAY['STAFF'::text, 'SYSTEM'::text])) AND (tenant_id = app.current_tenant_id()) AND (EXISTS ( SELECT 1
   FROM (public.workflow_item wi
     JOIN public.workflow_instance wfi ON ((wfi.id = wi.instance_id)))
  WHERE ((wi.id = workflow_n8n_dispatch.item_id) AND (wfi.tenant_id = workflow_n8n_dispatch.tenant_id))))))
  WITH CHECK (((app.current_actor_type() = ANY (ARRAY['STAFF'::text, 'SYSTEM'::text])) AND (tenant_id = app.current_tenant_id()) AND (EXISTS ( SELECT 1
   FROM (public.workflow_item wi
     JOIN public.workflow_instance wfi ON ((wfi.id = wi.instance_id)))
  WHERE ((wi.id = workflow_n8n_dispatch.item_id) AND (wfi.tenant_id = workflow_n8n_dispatch.tenant_id))))));
