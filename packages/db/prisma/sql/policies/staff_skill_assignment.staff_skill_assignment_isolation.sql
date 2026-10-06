CREATE POLICY staff_skill_assignment_isolation ON public.staff_skill_assignment
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((EXISTS ( SELECT 1
   FROM public.staff_user s
  WHERE ((s.id = staff_skill_assignment.staff_id) AND (s.tenant_id = app.current_tenant_id())))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM public.staff_user s
  WHERE ((s.id = staff_skill_assignment.staff_id) AND (s.tenant_id = app.current_tenant_id())))));
