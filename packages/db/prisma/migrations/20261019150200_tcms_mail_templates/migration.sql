-- Fachkatalog: MAIL-OUTBOX-001
--
-- TCMS Stufe 4: Mitteilungen des Tax-CMS an Mandantenkontakte (Freigabe
-- angefordert, Bestätigungscode, Freigabe neu adressiert) versendet der Worker
-- tcms-nachrichten-zustellen über die Mail-Outbox mit diesen System-Slugs. Wie
-- die übrigen System-Mails erhalten bestehende Kanzleien je eine bearbeitbare
-- System-Vorlage (Administration → E-Mail-Vorlagen, Platzhalter dort erklärt);
-- fehlt sie (neue Kanzlei, gelöscht oder deaktiviert), versendet der Worker
-- denselben Ersatztext aus packages/mail/src/tcms-vorlagen.ts.
--
-- Der Bestätigungscode steht nur im Text ({{code}}), nie im Betreff.
-- Idempotent: Eingefügt wird nur, wenn die Kanzlei weder den Slug noch eine
-- Vorlage gleichen Namens hat (eindeutiger Name je Kanzlei).
BEGIN;

INSERT INTO "email_template" ("tenant_id", "slug", "name", "category", "subject", "body_md", "active", "sort_order", "updated_at")
SELECT t."id", v.slug, v.name, v.category, v.subject, v.body, true, v.sort_order, now()
FROM "tenant" t
CROSS JOIN (VALUES
  ('tcms-freigabe-angefordert', 'Tax-CMS: Freigabe angefordert', 'System',
   'Freigabe angefordert: {{freigabe.titel}}',
   E'Sehr geehrte/r {{contact.fullName}},\n\nfür {{client.name}} wartet im Mandantenportal eine Freigabe auf Sie:\n\n**{{freigabe.titel}}** ({{freigabe.art}})\n\nBitte melden Sie sich im Mandantenportal an und prüfen Sie die Freigabe:\n{{link}}\n\n{{freigabe.hinweis}}\n\nMit freundlichen Grüßen\nIhre Steuerkanzlei',
   160),
  ('tcms-freigabe-code', 'Tax-CMS: Bestätigungscode', 'System',
   'Ihr Bestätigungscode für {{freigabe.titel}}',
   E'Sehr geehrte/r {{contact.fullName}},\n\nIhr Bestätigungscode für die Freigabe **{{freigabe.titel}}** ({{client.name}}) lautet:\n\n**{{code}}**\n\nDer Code gilt bis {{freigabe.gueltigBis}} und nur für diese Freigabe. Geben Sie ihn im Mandantenportal ein:\n{{link}}\n\n{{freigabe.pruefsumme}}\n\nHaben Sie keinen Code angefordert, geben Sie ihn nicht weiter und informieren Sie bitte Ihre Kanzlei.\n\nMit freundlichen Grüßen\nIhre Steuerkanzlei',
   161),
  ('tcms-freigabe-neu-adressiert', 'Tax-CMS: Freigabe neu adressiert', 'System',
   'Freigabe an Sie adressiert: {{freigabe.titel}}',
   E'Sehr geehrte/r {{contact.fullName}},\n\ndie Kanzlei hat die Freigabe **{{freigabe.titel}}** ({{freigabe.art}}) für {{client.name}} an Sie adressiert. Sie wartet im Mandantenportal auf Sie:\n{{link}}\n\n{{freigabe.hinweis}}\n\nMit freundlichen Grüßen\nIhre Steuerkanzlei',
   162)
) AS v(slug, name, category, subject, body, sort_order)
WHERE NOT EXISTS (
  SELECT 1 FROM "email_template" et
  WHERE et."tenant_id" = t."id" AND (et."slug" = v.slug OR et."name" = v.name)
);

COMMIT;
