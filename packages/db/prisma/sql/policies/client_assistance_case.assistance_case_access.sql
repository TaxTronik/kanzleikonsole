CREATE POLICY assistance_case_access ON public.client_assistance_case
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (((tenant_id = app.current_tenant_id()) AND (((app.current_actor_type() = 'STAFF'::text) AND app.notification_staff_can_access_client(tenant_id, app.current_actor_id(), client_id)) OR ((app.current_actor_type() = 'CLIENT_CONTACT'::text) AND (EXISTS ( SELECT 1
   FROM (public.client_contact cc
     JOIN public.client c ON ((c.id = cc.client_id)))
  WHERE ((cc.id = app.current_actor_id()) AND (cc.tenant_id = client_assistance_case.tenant_id) AND (cc.client_id = client_assistance_case.client_id) AND cc.active AND (c.mandate_ended_at IS NULL) AND c.allow_active AND (c.anonymized_at IS NULL))))))))
  WITH CHECK (((tenant_id = app.current_tenant_id()) AND (((app.current_actor_type() = 'STAFF'::text) AND app.notification_staff_can_access_client(tenant_id, app.current_actor_id(), client_id)) OR ((app.current_actor_type() = 'CLIENT_CONTACT'::text) AND (EXISTS ( SELECT 1
   FROM (public.client_contact cc
     JOIN public.client c ON ((c.id = cc.client_id)))
  WHERE ((cc.id = app.current_actor_id()) AND (cc.tenant_id = client_assistance_case.tenant_id) AND (cc.client_id = client_assistance_case.client_id) AND cc.active AND (c.mandate_ended_at IS NULL) AND c.allow_active AND (c.anonymized_at IS NULL))))))));
