CREATE POLICY wf_email_recipient_tenant ON public.workflow_email_recipient
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (((app.current_actor_type() = ANY (ARRAY['STAFF'::text, 'SYSTEM'::text])) AND (EXISTS ( SELECT 1
   FROM (public.workflow_item wi
     JOIN public.workflow_instance wfi ON ((wfi.id = wi.instance_id)))
  WHERE ((wi.id = workflow_email_recipient.item_id) AND (wfi.tenant_id = app.current_tenant_id()))))))
  WITH CHECK (((app.current_actor_type() = ANY (ARRAY['STAFF'::text, 'SYSTEM'::text])) AND (EXISTS ( SELECT 1
   FROM (public.workflow_item wi
     JOIN public.workflow_instance wfi ON ((wfi.id = wi.instance_id)))
  WHERE ((wi.id = workflow_email_recipient.item_id) AND (wfi.tenant_id = app.current_tenant_id()))))));
