-- Iter. 40b — zwei weitere System-Templates
--   request-staff-replied: Mandant erhält Mail, wenn die Kanzlei eine
--                          Antwort auf seine Anforderung gepostet hat.
--   gwg-activated:         Mandant erhält Begrüßungs-Mail, wenn der
--                          GwG-Check verified wurde und er aktiv wird.

INSERT INTO "email_template" ("tenant_id", "slug", "name", "category", "subject", "body_md", "active", "sort_order", "updated_at")
SELECT t."id", v.slug, v.name, v.category, v.subject, v.body, true, v.sort_order, now()
FROM "tenant" t
CROSS JOIN (VALUES
  ('request-staff-replied', 'Antwort auf Anforderung', 'System',
   'Antwort von Ihrer Kanzlei: {{request.title}}',
   E'Sehr geehrte/r {{contact.fullName}},\n\nIhre Kanzlei hat auf Ihre Anforderung „{{request.title}}" geantwortet.\n\nDie Antwort können Sie im Mandantenportal einsehen:\n{{portalUrl}}\n\nMit freundlichen Grüßen\nIhre Steuerkanzlei',
   145),
  ('gwg-activated', 'GwG-Prüfung abgeschlossen — Willkommen', 'System',
   'Willkommen — Ihre Mandantschaft ist nun aktiv',
   E'Sehr geehrte/r {{contact.fullName}},\n\nvielen Dank für die Mitwirkung an der Identifizierung nach dem Geldwäschegesetz.\n\nIhre Mandantschaft ist jetzt vollständig eingerichtet — wir können Anforderungen, Rechnungen und Dokumente austauschen. Loggen Sie sich gerne in Ihr Mandantenportal ein:\n\n{{portalUrl}}\n\nMit freundlichen Grüßen\nIhre Steuerkanzlei',
   125)
) AS v(slug, name, category, subject, body, sort_order)
WHERE NOT EXISTS (
  SELECT 1 FROM "email_template" et
  WHERE et."tenant_id" = t."id" AND et."slug" = v.slug
);
