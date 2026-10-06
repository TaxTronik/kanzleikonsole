CREATE POLICY payroll_session_staff ON public.payroll_guest_session
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (((tenant_id = app.current_tenant_id()) AND (EXISTS ( SELECT 1
   FROM public.payroll_employee_invite v
  WHERE ((v.id = payroll_guest_session.invite_id) AND app.payroll_staff_intake(v.intake_id))))))
  WITH CHECK (((tenant_id = app.current_tenant_id()) AND (EXISTS ( SELECT 1
   FROM public.payroll_employee_invite v
  WHERE ((v.id = payroll_guest_session.invite_id) AND app.payroll_staff_intake(v.intake_id))))));
