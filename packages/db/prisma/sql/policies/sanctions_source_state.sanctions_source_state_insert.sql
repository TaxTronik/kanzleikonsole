CREATE POLICY sanctions_source_state_insert ON public.sanctions_source_state
  AS PERMISSIVE
  FOR INSERT
  TO PUBLIC
  WITH CHECK (((tenant_id = app.current_tenant_id()) AND ((app.current_actor_type() = 'SYSTEM'::text) OR ((app.current_actor_type() = 'STAFF'::text) AND (EXISTS ( SELECT 1
   FROM (public.staff_user s
     JOIN public.staff_role r ON ((r.staff_user_id = s.id)))
  WHERE ((s.id = app.current_actor_id()) AND (s.tenant_id = sanctions_source_state.tenant_id) AND s.active AND (r.role = ANY (ARRAY['ADMIN'::public.staff_role_name, 'PARTNER'::public.staff_role_name])))))))));
