-- Iter. 40 — Mail-Dispatch: App als primärer Versender, n8n optional
--
-- Bisher gespaltene Pipeline: transaktionale Mails (Magic-Link, PoA) gingen
-- über `apps/web/src/server/mail/send.ts` mit hartcodierten TS-Templates,
-- asynchrone Eskalationen wurden per `emitN8nEvent` an n8n delegiert — wo
-- aber gar kein Workflow für alle Events existiert. Resultat: viele Events
-- landen im Nichts.
--
-- Diese Migration legt das Fundament für **App-als-Default**:
--   1. EmailTemplate bekommt einen System-Slug → Code referenziert
--      Templates über stabile Schlüssel (statt fragile Name-Strings)
--   2. Default-Templates für alle App-Events werden pro Tenant geseedet —
--      sind im ACP editierbar, fallback hartcodiert im Code falls Template
--      gelöscht wird
--
-- Mail-Dispatch-Toggle (`mail.dispatch` in tenant_setting):
--   APP  — nur App-eigener SMTP-Versand (Default, neu)
--   BOTH — App schickt + n8n-Event zusätzlich (für extra Integrationen)
-- Wert wird im ACP gepflegt, nicht hier geseedet (App-Code fällt auf 'APP').

-- 1. EmailTemplate-Erweiterung -----------------------------------------------

ALTER TABLE "email_template"
  ADD COLUMN "slug" TEXT;

-- System-Templates haben einen Slug; User-Templates bleiben slug=NULL
CREATE UNIQUE INDEX "email_template_tenant_slug_unique"
  ON "email_template"("tenant_id", "slug")
  WHERE "slug" IS NOT NULL;

-- 2. Default-Templates für jeden bestehenden Tenant seeden -------------------
--    Idempotent: nur einfügen, falls slug für den Tenant noch nicht existiert.

INSERT INTO "email_template" ("tenant_id", "slug", "name", "category", "subject", "body_md", "active", "sort_order", "updated_at")
SELECT t."id", v.slug, v.name, v.category, v.subject, v.body, true, v.sort_order, now()
FROM "tenant" t
CROSS JOIN (VALUES
  ('magic-link', 'Magic-Link (Portal-Login)', 'System',
   'Ihr Login-Link zum Mandantenportal',
   E'Hallo {{contact.fullName}},\n\nüber den folgenden Link können Sie sich in das Mandantenportal einloggen:\n\n{{link}}\n\nDer Link ist 30 Minuten gültig und kann nur einmal verwendet werden.\n\nMit freundlichen Grüßen\nIhre Steuerkanzlei',
   100),
  ('poa-sign', 'Vollmacht zur Signatur', 'System',
   'Bitte Vollmacht signieren — {{client.name}}',
   E'Sehr geehrte/r {{contact.fullName}},\n\nbitte signieren Sie die anliegende Vollmacht über folgenden Link:\n\n{{link}}\n\nSie benötigen den per separater Mail/SMS zugesandten Bestätigungscode.\n\nMit freundlichen Grüßen\nIhre Steuerkanzlei',
   110),
  ('gwg-onboarding', 'GwG-Onboarding-Einladung', 'System',
   'Identifizierung für Ihre Mandantschaft',
   E'Sehr geehrte/r {{inviteName}},\n\num Sie als Mandant aufzunehmen, sind wir gesetzlich verpflichtet, Ihre Identität nach dem Geldwäschegesetz zu prüfen.\n\nBitte füllen Sie das kurze Online-Formular über folgenden Link aus:\n\n{{link}}\n\nDer Link ist 14 Tage gültig.\n\nMit freundlichen Grüßen\nIhre Steuerkanzlei',
   120),
  ('handover-ready', 'Unterlagen abholbereit', 'System',
   'Ihre Unterlagen können abgeholt werden — {{label}}',
   E'Sehr geehrte/r {{contact.fullName}},\n\nIhre bei uns hinterlegten Unterlagen ({{label}}) sind fertig bearbeitet und können in unseren Geschäftsräumen abgeholt werden.\n\nMit freundlichen Grüßen\nIhre Steuerkanzlei',
   130),
  ('request-opened', 'Neue Anforderung', 'System',
   'Neue Anforderung von Ihrer Kanzlei: {{request.title}}',
   E'Sehr geehrte/r {{contact.fullName}},\n\nin Ihrem Mandantenportal liegt eine neue Anforderung für Sie bereit:\n\n**{{request.title}}**\n\n{{request.description}}\n\nBitte öffnen Sie das Portal:\n{{portalUrl}}\n\nMit freundlichen Grüßen\nIhre Steuerkanzlei',
   140),
  ('appointment-confirmed', 'Termin bestätigt', 'System',
   'Termin-Bestätigung: {{appointment.title}}',
   E'Sehr geehrte/r {{contact.fullName}},\n\nwir bestätigen Ihren Termin:\n\n**{{appointment.title}}**\n{{appointment.startsAt}}\n{{appointment.location}}\n\nMit freundlichen Grüßen\nIhre Steuerkanzlei',
   150),
  ('appointment-rejected', 'Termin-Anfrage nicht möglich', 'System',
   'Ihre Termin-Anfrage konnten wir leider nicht annehmen',
   E'Sehr geehrte/r {{contact.fullName}},\n\nleider können wir Ihre Termin-Anfrage „{{request.subject}}" nicht annehmen.\n\n{{rejectionReason}}\n\nBitte schlagen Sie über das Portal alternative Zeiten vor.\n\nMit freundlichen Grüßen\nIhre Steuerkanzlei',
   160),
  ('appeal-deadline-reminder', 'Einspruchsfrist läuft', 'System',
   'Einspruchsfrist {{labelDays}} — {{client.name}}',
   E'Hallo,\n\ndie Einspruchsfrist für den Bescheid „{{notice.kind}} {{notice.period}}" des Mandanten {{client.name}} läuft {{labelDays}} aus.\n\nFrist: {{notice.appealDeadline}}\n\nBitte ggf. Einspruch einlegen.',
   170)
) AS v(slug, name, category, subject, body, sort_order)
WHERE NOT EXISTS (
  SELECT 1 FROM "email_template" et
  WHERE et."tenant_id" = t."id" AND et."slug" = v.slug
);
