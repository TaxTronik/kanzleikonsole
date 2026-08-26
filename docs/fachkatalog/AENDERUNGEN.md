---
exceptions:
  - id: FK-EXC-20260827-001
    date: '2026-08-27'
    paths:
      - apps/worker/src/jobs/audit-anchor.ts
      - apps/worker/src/jobs/audit-rotate.ts
      - apps/worker/src/jobs/audit-verify-check.ts
      - apps/worker/src/jobs/dsgvo-retention.ts
      - apps/worker/src/jobs/evidence-seal.ts
      - apps/worker/src/jobs/gwg-expiry-check.ts
      - apps/worker/src/jobs/invoice-overdue-check.ts
      - apps/worker/src/jobs/magic-link-cleanup.ts
      - apps/worker/src/jobs/n8n-retention.ts
      - apps/worker/src/jobs/poa-expiry-check.ts
      - apps/worker/src/jobs/reminders-daily.ts
      - apps/worker/src/jobs/risk-analyse-llm.ts
      - apps/worker/src/jobs/tax-deadline-materialize.ts
    rule_ids:
      - ACCESS-NOTIFICATION-RECIPIENT-001
      - AUDIT-ARCHIVE-001
      - AUDIT-RFC3161-ANCHOR-001
      - AUDIT-VERIFY-ALERT-001
      - DSGVO-OPERATIONAL-RETENTION-001
      - INV-DUE-OVERDUE-001
      - POA-LIFECYCLE-001
      - RISK-AI-SUGGESTION-001
      - TAX-CONTROL-STATUS-001
      - TAX-DEADLINE-AUTOREQUEST-001
      - TAX-NOTICE-APPEAL-001
    reason: >-
      Die Worker-Registrierungen ersetzen ausschließlich ihre bisherigen
      identischen Queue-Namensliterale durch typisierte Konstanten aus der
      gemeinsamen Queue-Metadatenquelle. Der Audit-Prüfworker delegiert zudem
      sein unverändertes tenant_setting-Upsert mit demselben Transaktionsclient,
      Schlüssel und Ergebniswert an den gemeinsamen Persistenzhelfer.
      Prozessoren, Jobdaten, fachliche Auswahl, Statusentscheidungen,
      Retry-Verhalten und Ergebnisse bleiben unverändert.
    tests:
      - apps/worker/src/__tests__/queues.test.ts
      - apps/worker/src/__tests__/scheduler.test.ts
      - apps/worker/src/jobs/__tests__/audit-rotate.test.ts
      - apps/worker/src/jobs/__tests__/audit-verify-check.test.ts
      - apps/worker/src/jobs/__tests__/dsgvo-retention.test.ts
      - apps/worker/src/jobs/__tests__/evidence-seal.test.ts
      - apps/worker/src/jobs/__tests__/invoice-overdue-check.test.ts
      - apps/worker/src/jobs/__tests__/n8n-retention.test.ts
      - apps/worker/src/jobs/__tests__/poa-expiry-check.test.ts
      - apps/worker/src/jobs/__tests__/reminders-daily.test.ts
      - apps/worker/src/jobs/__tests__/risk-analyse-llm.test.ts
      - apps/worker/src/jobs/__tests__/tax-deadline-materialize.test.ts
    reviewer: Codex (automatisierter technischer Refactoring-Abgleich)
  - id: FK-EXC-20260827-002
    date: '2026-08-27'
    paths:
      - apps/web/src/app/api/portal/documents/[id]/download/route.ts
      - apps/web/src/app/api/portal/documents/[id]/preview-url/route.ts
      - apps/web/src/app/api/staff/documents/[id]/download/route.ts
      - apps/web/src/app/api/staff/documents/[id]/preview-url/route.ts
      - apps/web/src/app/staff/(protected)/admin/audit/actions.ts
      - apps/web/src/app/staff/(protected)/admin/audit/page.tsx
      - apps/web/src/server/compliance/verfahrensdoku.ts
      - apps/web/src/server/privacy/consent-catalog.ts
      - apps/web/src/server/privacy/notice.ts
      - apps/web/src/server/risk/los.ts
      - apps/web/src/server/settings/access-policy.ts
      - apps/worker/src/jobs/audit-anchor.ts
      - apps/worker/src/jobs/audit-rotate.ts
      - apps/worker/src/jobs/audit-verify-check.ts
      - packages/db/src/staff-client-access.ts
      - packages/evidence/src/cli/verify.ts
      - apps/web/src/app/api/staff/documents/__tests__/delivery-access.test.ts
      - apps/web/src/server/documents/__tests__/delivery.test.ts
      - apps/web/src/server/documents/delivery.ts
    rule_ids:
      - ACCESS-CLIENT-MODE-001
      - ACCESS-NOTIFICATION-RECIPIENT-001
      - AUDIT-VERIFY-ALERT-001
      - DOC-PORTAL-SHARING-001
      - DSGVO-CONSENT-SNAPSHOT-001
      - RISK-AI-SUGGESTION-001
      - TCMS-SAMPLE-PROOF-001
    reason: >-
      Gemeinsame Dokumentauslieferungs- und Tenant-Setting-Bausteine ersetzen
      duplizierte Prisma-, Storage-, Lese- und Upsert-Sequenzen. Portal-Freigabefilter,
      Staff-Zugriffsgate, Audit-Reihenfolge, MIME-Policy, Schlüssel, Werte und
      Normalisierung bleiben explizit an den bisherigen Aufrufern erhalten.
      Der bereits vorgesehene Best-effort-Audit der Staff-Vorschau läuft nun
      korrekt in einer eigenen Transaktion; dies ändert keine fachliche
      Zugriffs- oder Freigabeentscheidung.
    tests:
      - apps/web/src/app/api/portal/documents/__tests__/read-rate-limit.test.ts
      - apps/web/src/app/api/staff/documents/__tests__/delivery-access.test.ts
      - apps/web/src/server/documents/__tests__/delivery.test.ts
      - apps/web/src/server/compliance/__tests__/verfahrensdoku.test.ts
      - apps/web/src/server/privacy/__tests__/consent-catalog.test.ts
      - apps/web/src/server/privacy/__tests__/consent-display.test.ts
      - apps/web/src/server/risk/__tests__/los.test.ts
      - apps/web/src/server/settings/__tests__/access-policy.test.ts
      - apps/web/src/server/settings/__tests__/access-policy.property.test.ts
      - apps/worker/src/jobs/__tests__/audit-rotate.test.ts
      - apps/worker/src/jobs/__tests__/audit-verify-check.test.ts
      - packages/db/src/__tests__/tenant-settings.test.ts
    reviewer: Codex (automatisierter technischer Refactoring-Abgleich)
  - id: FK-EXC-20260827-004
    date: '2026-08-27'
    paths:
      - packages/db/prisma/migrations/20260827090000_remove_state_machine_builder/migration.sql
      - packages/db/prisma/schema.prisma
    rule_ids:
      - ACCESS-TENANT-RLS-001
    reason: >-
      Die Migration entfernt ausschließlich die drei tenantisolierten Tabellen
      des eigenständigen State-Builders, der nie an einen Fachvorgang oder eine
      fachliche Ressource angebunden war. Abhängige Tabellen werden zuerst
      entfernt; historische Audit-Bezeichnungen bleiben für bereits vorhandene
      Nachweise lesbar. Eine fachliche Statusentscheidung wird nicht verändert.
    tests:
      - packages/db/src/__tests__/state-machine-removal-migration.test.ts
    reviewer: Codex (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20260827-005
    date: '2026-08-27'
    paths:
      - packages/db/prisma/migrations/20260827100000_reconcile_late_security_guards/migration.sql
    rule_ids:
      - ACCESS-CLIENT-MODE-001
      - ACCESS-NOTIFICATION-RECIPIENT-001
      - ACCESS-TENANT-RLS-001
      - INV-ARCHIVE-EINVOICE-001
      - TAX-CONTROL-STATUS-001
      - TAX-DEADLINE-AUTOREQUEST-001
      - TAX-NOTICE-APPEAL-001
    reason: >-
      Eine Forward-Migration stellt für zwei exakt attestierte Pre-Release-
      Migrationsstände das bereits katalogisierte Sollverhalten wieder her:
      interne Rechnungs- und Bescheidfunktionen sind nicht direkt durch die
      App-Rolle ausführbar, Teilabhilfe-Nachweise bleiben vollständig und
      unveränderlich, die interne Fristenhistorie bleibt für die App unlesbar
      und Notifications werden empfänger-, ressourcen- und tenantgebunden
      fail-closed geprüft. Es werden keine fachlichen Tatsachen ergänzt und
      keine bestehende Regelentscheidung verändert. Der Deploy-Gate akzeptiert
      ausschließlich die beiden bekannten Alt-Checksummen bis zur atomaren
      Reparatur und lehnt unbekannte Abweichungen weiterhin ab.
    tests:
      - packages/db/src/__tests__/late-security-repair-migration.test.ts
      - packages/db/src/__tests__/invoice-xrechnung-document-link.test.ts
      - packages/db/src/__tests__/notification-client-scope-migration.test.ts
      - packages/db/src/__tests__/notification-client-scope-rls.test.ts
      - packages/db/src/__tests__/tax-deadline-request-consistency.test.ts
      - packages/db/src/__tests__/tax-notice-evidence.test.ts
    reviewer: Codex (automatisierter technischer Abgleich ohne fachliche Freigabe)
---

# Fachkatalog – dokumentierte Änderungen ohne Regelwirkung

Diese Datei ist die bewusst sichtbare Ausnahme zum CI-Diff-Gate. Sie wird nur
aktualisiert, wenn sich ein überwachter Fachpfad ändert, **ohne** dass sich die
fachliche Aussage einer Regel ändert, etwa bei einer reinen Umbenennung oder
einem nachweislich verhaltensneutralen Refactoring.

Jede Ausnahme wird im YAML-Kopf als unveränderlicher Datensatz ergänzt und
nennt:

- Datum und betroffene Regel-ID(s),
- geänderte Fachpfade,
- warum Entscheidung, Geltungsbereich, Ausnahmen und Ergebnis unverändert
  bleiben,
- welche Tests die Verhaltensneutralität belegen,
- prüfende Person.

Beispiel (unter `exceptions` einrücken):

```yaml
- id: FK-EXC-20260823-001
  date: '2026-08-23'
  paths:
    - packages/tax/src/engine.ts
  rule_ids:
    - TAX-DEADLINE-WORKDAY-001
  reason: Die Umbenennung verändert weder Eingaben noch Entscheidung oder Ergebnis der Regel.
  tests:
    - packages/tax/src/__tests__/engine.test.ts
  reviewer: Vorname Nachname
```

Die CI akzeptiert nur **neu hinzugefügte** Datensätze für die aktuelle Änderung,
prüft Fachpfade, Regel-IDs und vorhandene Testdateien und verhindert spätere
Änderungen oder Löschungen bestehender Ausnahmen.

Eine neue oder geänderte Fachentscheidung gehört immer direkt in die
betroffenen Regeldateien und nicht in diese Ausnahmeliste. Regeldateien werden
bei Ablösung mit Status `superseded` erhalten; das Diff-Gate verbietet ihre
Löschung.

## Einträge

- `FK-EXC-20260827-001` — zentrale Queue-Namen ersetzen identische Literale in
  Worker-Registrierungen; Jobverarbeitung und Fachentscheidungen bleiben
  unverändert.
- `FK-EXC-20260827-002` — gemeinsame Dokumentauslieferung und
  Tenant-Setting-Persistenz bei unveränderten Zugriffs-, Audit- und
  Einstellungsregeln.
- `FK-EXC-20260827-004` — Entfernung des fachlich unverbundenen State-Builders
  einschließlich seiner drei Datenbanktabellen.
- `FK-EXC-20260827-005` — atomare Wiederherstellung der bereits dokumentierten
  ACL-, Nachweis-, Empfänger- und RLS-Guards für zwei exakt attestierte
  Pre-Release-Migrationsstände.
