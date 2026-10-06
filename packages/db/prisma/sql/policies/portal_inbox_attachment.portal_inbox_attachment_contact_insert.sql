CREATE POLICY portal_inbox_attachment_contact_insert ON public.portal_inbox_attachment
  AS PERMISSIVE
  FOR INSERT
  TO PUBLIC
  WITH CHECK (app.portal_inbox_owned_open_batch(batch_id));
