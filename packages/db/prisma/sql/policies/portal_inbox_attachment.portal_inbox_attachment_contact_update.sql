CREATE POLICY portal_inbox_attachment_contact_update ON public.portal_inbox_attachment
  AS PERMISSIVE
  FOR UPDATE
  TO PUBLIC
  USING (app.portal_inbox_owned_open_batch(batch_id))
  WITH CHECK (app.portal_inbox_owned_open_batch(batch_id));
