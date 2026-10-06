CREATE POLICY assistance_revision_insert ON public.client_assistance_revision
  AS PERMISSIVE
  FOR INSERT
  TO PUBLIC
  WITH CHECK ((EXISTS ( SELECT 1
   FROM public.client_assistance_case c
  WHERE (c.id = client_assistance_revision.case_id))));
