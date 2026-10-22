CREATE POLICY gwg_onboarding_draft_isolation ON public.gwg_onboarding_draft
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((tenant_id = app.current_tenant_id()))
  WITH CHECK ((tenant_id = app.current_tenant_id()));
