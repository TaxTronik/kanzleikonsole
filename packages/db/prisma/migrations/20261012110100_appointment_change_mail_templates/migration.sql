-- Fachkatalog: MAIL-OUTBOX-001
--
-- Welle 15 (Entscheidung „Checkbox im Dialog“): Beim Bearbeiten oder Absagen
-- eines Termins im Kanzleikalender kann die Kanzlei den Mandanten per E-Mail
-- informieren (Mail-Outbox-Anlässe appointment-changed und
-- appointment-cancelled). Wie die übrigen Termin-Mails (appointment-confirmed,
-- appointment-rejected aus 20260621000000_iter40_mail_dispatch) erhalten
-- bestehende Kanzleien je eine bearbeitbare System-Vorlage; fehlt sie (neue
-- Kanzlei, gelöscht oder deaktiviert), versendet die App denselben Ersatztext
-- aus apps/web/src/server/appointments/client-mail.ts.
--
-- Die Vorlagen nennen Titel, Zeit und Ort bzw. die Absage, keine internen
-- Notizen. Idempotent: Eingefügt wird nur, wenn die Kanzlei weder den Slug noch
-- eine Vorlage gleichen Namens hat (eindeutiger Name je Kanzlei).
BEGIN;

INSERT INTO "email_template" ("tenant_id", "slug", "name", "category", "subject", "body_md", "active", "sort_order", "updated_at")
SELECT t."id", v.slug, v.name, v.category, v.subject, v.body, true, v.sort_order, now()
FROM "tenant" t
CROSS JOIN (VALUES
  ('appointment-changed', 'Termin geändert (Kanzlei)', 'System',
   'Terminänderung: {{appointment.title}}',
   E'Sehr geehrte/r {{contact.fullName}},\n\nIhr Termin wurde geändert. Es gilt jetzt:\n\n**{{appointment.title}}**\n{{appointment.startsAt}} bis {{appointment.endsAt}}\n{{appointment.location}}\n\nMit freundlichen Grüßen\nIhre Steuerkanzlei',
   155),
  ('appointment-cancelled', 'Termin abgesagt (Kanzlei)', 'System',
   'Terminabsage: {{appointment.title}}',
   E'Sehr geehrte/r {{contact.fullName}},\n\nleider müssen wir den folgenden Termin absagen:\n\n**{{appointment.title}}**\n{{appointment.startsAt}}\n\nFür einen neuen Termin melden Sie sich bitte bei uns oder nutzen Sie das Mandantenportal.\n\nMit freundlichen Grüßen\nIhre Steuerkanzlei',
   156)
) AS v(slug, name, category, subject, body, sort_order)
WHERE NOT EXISTS (
  SELECT 1 FROM "email_template" et
  WHERE et."tenant_id" = t."id" AND (et."slug" = v.slug OR et."name" = v.name)
);

COMMIT;
