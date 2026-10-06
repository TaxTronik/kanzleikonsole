CREATE POLICY assistance_revision_read ON public.client_assistance_revision
  AS PERMISSIVE
  FOR SELECT
  TO PUBLIC
  USING ((EXISTS ( SELECT 1
   FROM public.client_assistance_case c
  WHERE (c.id = client_assistance_revision.case_id))));
