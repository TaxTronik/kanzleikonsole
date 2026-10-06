CREATE POLICY inbound_attachment_access ON public.inbound_attachment
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((EXISTS ( SELECT 1
   FROM public.inbound_message m
  WHERE (m.id = inbound_attachment.message_id))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM public.inbound_message m
  WHERE (m.id = inbound_attachment.message_id))));
