CREATE POLICY gwg_id_document_isolation ON public.gwg_id_document
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((EXISTS ( SELECT 1
   FROM public.gwg_check gc
  WHERE ((gc.id = gwg_id_document.gwg_check_id) AND (gc.tenant_id = app.current_tenant_id())))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM public.gwg_check gc
  WHERE ((gc.id = gwg_id_document.gwg_check_id) AND (gc.tenant_id = app.current_tenant_id())))));
