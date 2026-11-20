CREATE POLICY notification_risk_research_scope ON public.notification
  AS RESTRICTIVE
  FOR ALL
  TO PUBLIC
  USING (
CASE
    WHEN ((resource_type = 'risk_research_result'::text) AND (app.current_actor_type() = 'STAFF'::text)) THEN app.risk_research_notification_visible(tenant_id, resource_id, staff_id)
    ELSE true
END)
  WITH CHECK (
CASE
    WHEN ((resource_type = 'risk_research_result'::text) AND (app.current_actor_type() = 'STAFF'::text)) THEN app.risk_research_notification_visible(tenant_id, resource_id, staff_id)
    ELSE true
END);
