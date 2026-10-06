CREATE POLICY staff_permission_isolation ON public.staff_permission
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((EXISTS ( SELECT 1
   FROM public.staff_user su
  WHERE ((su.id = staff_permission.staff_user_id) AND (su.tenant_id = app.current_tenant_id())))));
