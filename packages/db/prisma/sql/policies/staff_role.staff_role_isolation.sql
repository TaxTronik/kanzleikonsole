CREATE POLICY staff_role_isolation ON public.staff_role
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((EXISTS ( SELECT 1
   FROM public.staff_user su
  WHERE ((su.id = staff_role.staff_user_id) AND (su.tenant_id = app.current_tenant_id())))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM public.staff_user su
  WHERE ((su.id = staff_role.staff_user_id) AND (su.tenant_id = app.current_tenant_id())))));
