-- Iter. 40a — weitere System-Templates seeden
--
-- poa-otp wurde im Initial-Seed vergessen; request-responded fehlt für die
-- Antwort-Benachrichtigung an Mitarbeiter; workflow-mail als Default für
-- CLIENT_EMAIL-Workflow-Steps.

INSERT INTO "email_template" ("tenant_id", "slug", "name", "category", "subject", "body_md", "active", "sort_order", "updated_at")
SELECT t."id", v.slug, v.name, v.category, v.subject, v.body, true, v.sort_order, now()
FROM "tenant" t
CROSS JOIN (VALUES
  ('poa-otp', 'Vollmacht — Bestätigungscode', 'System',
   'Bestätigungscode zur Vollmachts-Signatur',
   E'Sehr geehrte/r {{contact.fullName}},\n\nIhr Bestätigungscode zur Signatur der Vollmacht „{{subject}}":\n\n**{{otp}}**\n\nDer Code ist {{expiresMinutes}} Minuten gültig.',
   115),
  ('workflow-step-email', 'Workflow-Schritt — Mandanten-Mail', 'System',
   '{{step.title}} — {{client.name}}',
   E'Sehr geehrte/r {{contact.fullName}},\n\n{{step.body}}\n\nMit freundlichen Grüßen\nIhre Steuerkanzlei',
   180)
) AS v(slug, name, category, subject, body, sort_order)
WHERE NOT EXISTS (
  SELECT 1 FROM "email_template" et
  WHERE et."tenant_id" = t."id" AND et."slug" = v.slug
);
