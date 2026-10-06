CREATE POLICY assistance_output_scope ON public.client_assistance_output
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((EXISTS ( SELECT 1
   FROM public.client_assistance_revision r
  WHERE (r.id = client_assistance_output.revision_id))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM public.client_assistance_revision r
  WHERE (r.id = client_assistance_output.revision_id))));
