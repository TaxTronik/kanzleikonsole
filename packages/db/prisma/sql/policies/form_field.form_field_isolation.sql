CREATE POLICY form_field_isolation ON public.form_field
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((EXISTS ( SELECT 1
   FROM public.form_template t
  WHERE ((t.id = form_field.template_id) AND (t.tenant_id = app.current_tenant_id())))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM public.form_template t
  WHERE ((t.id = form_field.template_id) AND (t.tenant_id = app.current_tenant_id())))));
