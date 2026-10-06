CREATE POLICY client_reminder_assignee_isolation ON public.client_reminder_assignee
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((EXISTS ( SELECT 1
   FROM public.client_reminder r
  WHERE ((r.id = client_reminder_assignee.reminder_id) AND (r.tenant_id = app.current_tenant_id())))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM public.client_reminder r
  WHERE ((r.id = client_reminder_assignee.reminder_id) AND (r.tenant_id = app.current_tenant_id())))));
