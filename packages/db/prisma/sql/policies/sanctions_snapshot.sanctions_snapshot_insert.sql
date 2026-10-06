CREATE POLICY sanctions_snapshot_insert ON public.sanctions_snapshot
  AS PERMISSIVE
  FOR INSERT
  TO PUBLIC
  WITH CHECK (((tenant_id = app.current_tenant_id()) AND ((app.current_actor_type() = 'SYSTEM'::text) OR ((app.current_actor_type() = 'STAFF'::text) AND (EXISTS ( SELECT 1
   FROM (public.staff_user s
     JOIN public.staff_role r ON ((r.staff_user_id = s.id)))
  WHERE ((s.id = app.current_actor_id()) AND (s.tenant_id = sanctions_snapshot.tenant_id) AND s.active AND (r.role = ANY (ARRAY['ADMIN'::public.staff_role_name, 'PARTNER'::public.staff_role_name])))))))));
