CREATE POLICY stbvv_quote_export_invoice_permission ON public.stbvv_quote_export
  AS RESTRICTIVE
  FOR INSERT
  TO PUBLIC
  WITH CHECK ((EXISTS ( SELECT 1
   FROM public.staff_user s
  WHERE ((s.id = app.current_actor_id()) AND (s.tenant_id = stbvv_quote_export.tenant_id) AND s.active AND ((EXISTS ( SELECT 1
           FROM public.staff_role r
          WHERE ((r.staff_user_id = s.id) AND (r.role = ANY (ARRAY['ADMIN'::public.staff_role_name, 'PARTNER'::public.staff_role_name]))))) OR (EXISTS ( SELECT 1
           FROM public.staff_permission p
          WHERE ((p.staff_user_id = s.id) AND (p.permission = 'INVOICE_MANAGE'::public.staff_permission_name)))))))));
