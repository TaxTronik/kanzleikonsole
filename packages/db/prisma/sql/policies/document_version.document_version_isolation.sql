CREATE POLICY document_version_isolation ON public.document_version
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((EXISTS ( SELECT 1
   FROM public.document d
  WHERE ((d.id = document_version.document_id) AND (d.tenant_id = app.current_tenant_id())))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM public.document d
  WHERE ((d.id = document_version.document_id) AND (d.tenant_id = app.current_tenant_id())))));
