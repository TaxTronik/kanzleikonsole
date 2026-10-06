CREATE POLICY deadline_daily_review_select ON public.deadline_daily_review
  AS PERMISSIVE
  FOR SELECT
  TO PUBLIC
  USING (((tenant_id = app.current_tenant_id()) AND ((app.current_actor_type() = 'SYSTEM'::text) OR ((app.current_actor_type() = 'STAFF'::text) AND (EXISTS ( SELECT 1
   FROM (public.staff_user staff
     JOIN public.staff_role sr ON ((sr.staff_user_id = staff.id)))
  WHERE ((staff.id = app.current_actor_id()) AND (staff.tenant_id = deadline_daily_review.tenant_id) AND (staff.active = true) AND (sr.role = ANY (ARRAY['ADMIN'::public.staff_role_name, 'PARTNER'::public.staff_role_name])))))))));
