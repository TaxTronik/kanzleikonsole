CREATE POLICY gwg_beneficial_owner_isolation ON public.gwg_beneficial_owner
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((EXISTS ( SELECT 1
   FROM public.gwg_check gc
  WHERE ((gc.id = gwg_beneficial_owner.gwg_check_id) AND (gc.tenant_id = app.current_tenant_id())))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM public.gwg_check gc
  WHERE ((gc.id = gwg_beneficial_owner.gwg_check_id) AND (gc.tenant_id = app.current_tenant_id())))));
