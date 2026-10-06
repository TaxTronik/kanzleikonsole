---
exceptions:
  - id: FK-EXC-20261006-021
    date: '2026-10-06'
    paths:
      - .forgejo/workflows/ci.yml
      - apps/web/src/app/staff/(protected)/poa/_signing-shared.ts
      - apps/web/src/app/staff/(protected)/poa/actions.ts
      - apps/web/src/server/poa/__tests__/poa-services-db-ci.test.ts
      - apps/web/src/server/poa/__tests__/poa-services-db.test.ts
      - apps/web/src/server/poa/create-poa.ts
      - apps/web/src/server/poa/revoke-poa.ts
      - apps/web/src/server/poa/send-for-signature.ts
      - apps/web/src/server/poa/signing-token.ts
    rule_ids:
      - POA-LIFECYCLE-001
      - POA-SIGNING-CONFIRMATION-001
      - POA-SIGNING-SNAPSHOT-001
      - CLIENT-MANDATE-LIFECYCLE-001
      - ASSURANCE-RELEASE-EVIDENCE-001
    reason: >-
      Anlage, Versand zur Signatur und Widerruf von Vollmachten laufen über eigene
      Server-Services (apps/web/src/server/poa/create-poa.ts,
      send-for-signature.ts, revoke-poa.ts, signing-token.ts); die Actions behalten
      ADMIN/PARTNER-Gate, Eingabeprüfung, Fehlerabbildung und Revalidierung.
      Abfragen, Schreibvorgänge, Versandsnapshot und Hash, Token-Hash, DB-Uhrzeit,
      Audit-Events und Meldungen bleiben unverändert. Neue PostgreSQL-Testsuite gegen
      die PoA-Integritätstrigger im CI-db-Job. Keine fachliche Freigabe.
    tests:
      - apps/web/src/server/poa/__tests__/poa-services-db.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261006-020
    date: '2026-10-06'
    paths:
      - .forgejo/workflows/ci.yml
      - apps/web/src/app/staff/(protected)/documents/actions.ts
      - apps/web/src/server/documents/__tests__/retag-db-ci.test.ts
      - apps/web/src/server/documents/__tests__/retag-db.test.ts
      - apps/web/src/server/documents/retag.ts
    rule_ids:
      - DOC-VERSION-IMMUTABILITY-001
      - DOC-UPLOAD-JOURNAL-001
      - DOC-PORTAL-SHARING-001
      - ASSURANCE-RELEASE-EVIDENCE-001
    reason: >-
      Die Umklassifizierung von Dokumenten (Einzelaktion und Auswahl) läuft über
      einen gemeinsamen Dokument-Service (apps/web/src/server/documents/retag.ts);
      die bisher in der Action-Datei liegenden Schritte (Ziel auflösen, Sperre,
      Metadaten-Retag, journal-first Re-Store, Fehlermeldung) wurden unverändert
      verschoben. Sperrreihenfolge, Transaktionen, Journalquelle, Audit-Events,
      Meldungen und revalidierte Pfade bleiben gleich; geschützte Versionen werden
      weiterhin durch eine neue Version ergänzt statt geändert. Neue PostgreSQL-
      Testsuite im CI-db-Job. Keine fachliche Freigabe.
    tests:
      - apps/web/src/server/documents/__tests__/retag-db.test.ts
      - apps/web/src/app/staff/(protected)/documents/__tests__/retag-race.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261006-019
    date: '2026-10-06'
    paths:
      - apps/web/src/server/gwg-onboarding/__tests__/invite-lifecycle.test.ts
    rule_ids:
      - GWG-SELF-ONBOARDING-001
    reason: >-
      Der Quelltext-Test des GwG-Einladungs-Lifecycles normalisiert die
      Zeilenenden der gelesenen Action-Dateien vor dem Mehrzeilenvergleich, weil die
      Working-Copy unter Windows CRLF trägt (.gitattributes hält nur das Repository
      auf LF). Geprüfte Aussagen, Einladungslogik und Supersession bleiben
      unverändert. Keine fachliche Freigabe.
    tests:
      - apps/web/src/server/gwg-onboarding/__tests__/invite-lifecycle.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261006-018
    date: '2026-10-06'
    paths:
      - .forgejo/workflows/ci.yml
      - apps/web/src/app/staff/(protected)/documents/__tests__/bulk-actions-ci.test.ts
      - apps/web/src/app/staff/(protected)/documents/__tests__/bulk-actions-db.test.ts
      - apps/web/src/app/staff/(protected)/documents/__tests__/bulk-actions.test.ts
      - apps/web/src/app/staff/(protected)/documents/actions.ts
      - apps/web/src/app/staff/(protected)/documents/folder-actions.ts
      - apps/web/src/server/documents/__tests__/document-bulk.test.ts
      - apps/web/src/server/documents/document-bulk.ts
    rule_ids:
      - DOC-PORTAL-SHARING-001
      - DOC-VERSION-IMMUTABILITY-001
      - DOC-UPLOAD-JOURNAL-001
      - ASSURANCE-RELEASE-EVIDENCE-001
    reason: >-
      Verschieben, Freigeben, Löschen und Umtypisieren einer Auswahl im
      Dokumenten-Explorer laufen als eine Server Action mit ID-Liste (höchstens
      1.000) statt als eine Action je Dokument. Je Block von 200 Dokumenten läuft
      eine Transaktion; Zugriffsprüfung, Freigabe-, Lösch-, Verschiebe- und
      Umtypisierungslogik sowie das Audit-Event je Dokument sind dieselben
      Funktionen wie bei der Einzelaktion. Eine fachliche Ablehnung betrifft nur das
      einzelne Dokument; ein Datenbankfehler (etwa der Trigger der Lohn-Freigabesperre)
      rollt den Block zurück, der dann dokumentweise wiederholt wird. Umtypisieren
      mit Anhebung der Schutzstufe behält den journalisierten Re-Store je Dokument.
      Freigaberegeln, Versionsschutz, Aufbewahrung und RLS bleiben unverändert. Neuer
      CI-Schritt prüft die Bulk-Actions gegen PostgreSQL mit der App-Rolle. Keine
      fachliche Freigabe.
    tests:
      - apps/web/src/app/staff/(protected)/documents/__tests__/bulk-actions.test.ts
      - apps/web/src/server/documents/__tests__/document-bulk.test.ts
      - apps/web/src/app/staff/(protected)/documents/__tests__/bulk-actions-db.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261006-017
    date: '2026-10-06'
    paths:
      - apps/web/next.config.mjs
      - apps/web/src/app/gwg-onboarding/__tests__/actions-expiry.test.ts
      - apps/web/src/app/gwg-onboarding/actions.ts
      - apps/web/src/app/gwg-onboarding/wizard-steps.tsx
      - apps/web/src/app/gwg-onboarding/wizard.tsx
      - apps/web/src/app/portal/(protected)/forms/[id]/__tests__/actions.test.ts
      - apps/web/src/app/portal/(protected)/forms/[id]/actions.ts
      - apps/web/src/app/portal/(protected)/forms/[id]/filler.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/notices/filings/__tests__/actions-journal.test.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/notices/filings/actions.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/notices/filings/filings-section.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/subsumtion/actions.ts
      - apps/web/src/app/staff/(protected)/invoices/actions.ts
      - apps/web/src/app/staff/(protected)/invoices/new/external-form.tsx
      - apps/web/src/server/documents/__tests__/upload-file.test.ts
      - apps/web/src/server/documents/upload-file.ts
      - apps/web/src/server/invoicing/__tests__/invoice-actions.test.ts
    rule_ids:
      - GWG-SELF-ONBOARDING-001
      - FORM-PRESUBMIT-UPLOAD-001
      - DOC-UPLOAD-JOURNAL-001
      - INV-LIFECYCLE-FREEZE-001
      - INV-VAT-TOTALS-001
      - MAIL-INBOX-001
    reason: >-
      Uploads über Server Actions (externe Rechnungs-PDF, Steuererklärungs-PDF,
      DATEV-BWA-XLSX, Formular-Datei im Mandantenportal, GwG-Onboarding) werden
      als binäre Datei in FormData statt als base64-String übertragen; die
      Grenzen je Upload-Art kommen aus einer Quelle (src/lib/upload-limits.mjs),
      aus der auch die Anzeige und das bodySizeLimit in next.config.mjs (26 MiB)
      abgeleitet sind. Die angezeigten Grenzen von 10 bzw. 20 MB gelten damit
      tatsächlich (bisher Abbruch ab rund 7,5 MB). Virenscan, Typprüfung,
      Aufbewahrung, Formular- und Rechnungslogik bleiben unverändert. Keine
      fachliche Freigabe.
    tests:
      - apps/web/src/server/documents/__tests__/upload-file.test.ts
      - apps/web/src/app/portal/(protected)/forms/[id]/__tests__/actions.test.ts
      - apps/web/src/server/invoicing/__tests__/invoice-actions.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261006-016
    date: '2026-10-06'
    paths:
      - .forgejo/workflows/ci.yml
      - apps/web/src/app/api/portal/documents/__tests__/commit-journal.test.ts
      - apps/web/src/app/api/portal/documents/commit/route.ts
      - apps/web/src/app/api/staff/documents/[id]/new-version/commit/__tests__/route-poa-lock.test.ts
      - apps/web/src/app/api/staff/documents/[id]/new-version/commit/route.ts
      - apps/web/src/app/api/staff/documents/commit/__tests__/route-toctou.test.ts
      - apps/web/src/app/api/staff/documents/commit/route.ts
      - apps/web/src/app/portal/(protected)/forms/[id]/__tests__/actions.test.ts
      - apps/web/src/app/portal/(protected)/forms/[id]/actions.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/notices/filings/__tests__/actions-journal.test.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/notices/filings/actions.ts
      - apps/web/src/app/staff/(protected)/documents/__tests__/retag-race.test.ts
      - apps/web/src/app/staff/(protected)/documents/actions.ts
      - apps/web/src/app/staff/(protected)/invoices/actions.ts
      - apps/web/src/server/documents/__tests__/journaled-upload.test.ts
      - apps/web/src/server/documents/__tests__/storage-intent.test.ts
      - apps/web/src/server/documents/__tests__/storage-journal-fake.ts
      - apps/web/src/server/documents/journaled-upload.ts
      - apps/web/src/server/documents/storage-compensation.ts
      - apps/web/src/server/documents/storage-intent.ts
      - apps/web/src/server/invoicing/__tests__/archive.test.ts
      - apps/web/src/server/invoicing/archive.ts
      - apps/web/src/server/risk/__tests__/research-shelf.test.ts
      - apps/web/src/server/risk/research-shelf.ts
      - apps/worker/src/jobs/storage-orphan-cleanup.ts
      - packages/db/prisma/migrations/20261006130000_storage_orphan_absent_resolution/migration.sql
      - packages/db/prisma/migrations/20261006130100_storage_upload_intent/migration.sql
      - packages/db/prisma/schema.prisma
    rule_ids:
      - DOC-UPLOAD-JOURNAL-001
      - DOC-OBJECT-LOCK-001
      - DOC-RETENTION-CLASS-001
      - DOC-VERSION-IMMUTABILITY-001
      - INV-ARCHIVE-EINVOICE-001
      - FORM-PRESUBMIT-UPLOAD-001
      - DSGVO-OPERATIONAL-RETENTION-001
      - ASSURANCE-RELEASE-EVIDENCE-001
    reason: >-
      Alle direkten Upload-Pfade (Staff- und Portal-Upload, neue Version,
      Wissensanhänge, Umklassifizierung mit Re-Store, externe Rechnung,
      Steuererklärungs-PDF, Formular-Datei, Aktenregal, E-Rechnungsarchiv)
      journalisieren die Speicherabsicht (storage_orphan.intent) vor dem
      Object-Store-Write und schließen sie in der Commit-Transaktion per
      app.settle_storage_intent ab (Migrationen 20261006130000 und
      20261006130100). Nach einem Abbruch zwischen Write und Commit löst der
      Cleanup-Worker die offene Absicht auf (referenziert, versionsgenau löschen
      nach Sicherheitsfrist bzw. nach Ablauf der Aufbewahrung, nie geschrieben).
      Virenscan, MIME-Prüfung, Größengrenzen, Schutzstufen, Aufbewahrung und RLS
      bleiben unverändert; vorhersehbare Ablehnungen greifen jetzt vor dem Write.
      Keine fachliche Freigabe; der Umsetzungstext von DOC-UPLOAD-JOURNAL-001
      beschreibt noch das bisherige Store-first-Verfahren und ist vom
      Regelverantwortlichen nachzuziehen.
    tests:
      - packages/db/src/__tests__/storage-upload-intent.test.ts
      - apps/worker/src/jobs/__tests__/storage-orphan-cleanup-db.test.ts
      - apps/web/src/server/documents/__tests__/journaled-upload.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261006-015
    date: '2026-10-06'
    paths:
      - apps/web/src/instrumentation.ts
      - packages/evidence/src/ports/rfc3161-http.ts
      - packages/mail/src/dispatch.ts
      - packages/mail/src/index.ts
    rule_ids:
      - ACCESS-TENANT-RLS-001
      - AUDIT-RFC3161-ANCHOR-001
      - TAX-DEADLINE-AUTOREQUEST-001
      - ACCESS-NOTIFICATION-RECIPIENT-001
      - AUDIT-HASH-CHAIN-001
    reason: >-
      Die n8n-Anbindung des Mail-Pakets wird beim Start von Web-App
      (instrumentation.ts) und Worker ausdrücklich genau einmal registriert statt
      als Seiteneffekt eines Imports; fehlt die Registrierung, bricht ein Versand
      im Modus „App + n8n“ vor dem SMTP-Kontakt mit klarer Meldung ab, statt das
      Ereignis still auszulassen. Die SSRF-Grenze in ssrf-guard.ts, rss und dem
      RFC-3161-Port nutzt die typisierte HttpTargetPolicy aus
      @taxtronik/http-utils statt Casts; die Richtlinie selbst ist unverändert.
      Versandinhalte, Empfängerauflösung, Zeitstempelstelle und
      Hardware-Richtlinie bleiben unverändert. Keine fachliche Freigabe.
    tests:
      - packages/mail/src/__tests__/n8n-emitter.test.ts
      - apps/web/src/__tests__/instrumentation.test.ts
      - apps/web/src/server/http/__tests__/ssrf-guard-policy.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261006-014
    date: '2026-10-06'
    paths:
      - .forgejo/workflows/ci.yml
      - apps/web/src/app/staff/(protected)/clients/[id]/_data.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/__tests__/actions.test.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/__tests__/invite-actions-access.test.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/__tests__/page-render.test.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/actions.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/gwg-page-data.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/gwg-page-invitation.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/invite-actions.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/invite-section.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/requests/__tests__/actions.test.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/requests/actions.ts
      - apps/web/src/app/staff/(protected)/clients/onboarding/[id]/actions.ts
      - apps/web/src/app/staff/(protected)/forms/submissions/[id]/page.tsx
      - apps/web/src/app/staff/(protected)/invoices/[id]/page.tsx
      - apps/web/src/app/staff/(protected)/invoices/actions.ts
      - apps/web/src/app/staff/(protected)/requests/[id]/page.tsx
      - apps/web/src/server/invoicing/__tests__/invoice-actions.test.ts
      - apps/web/src/server/invoicing/__tests__/invoice-concurrency-db.test.ts
      - packages/db/prisma/migrations/20261006120000_mail_outbox/migration.sql
      - packages/db/prisma/schema.prisma
      - packages/mail/src/dispatch.ts
      - packages/mail/src/index.ts
      - packages/mail/src/request-opened.ts
    rule_ids:
      - GWG-SELF-ONBOARDING-001
      - GWG-ACTIVATION-GATE-001
      - REQ-LIFECYCLE-001
      - INV-LIFECYCLE-FREEZE-001
      - ACCESS-TENANT-RLS-001
      - ACCESS-NOTIFICATION-RECIPIENT-001
      - TAX-DEADLINE-AUTOREQUEST-001
    reason: >-
      Elf Mandanten-Mails (neue Anforderung, Kanzlei-Antwort, Formular,
      GwG-Einladung und -Freischaltung, Terminentscheidung, Rechnungsversand,
      externe Rechnung, Abholbereitschaft) werden nicht mehr nach dem Commit per
      nicht abgewartetem Promise versendet, sondern im fachlichen Commit als
      Versandauftrag in mail_outbox gespeichert (Migration 20261006120000, RLS wie
      die n8n-Outbox, App-Rolle nur SELECT/INSERT) und vom Worker zugestellt:
      eindeutige Fehlschläge bis zu sechsmal mit wachsendem Abstand, unklarer
      Ausgang ohne Wiederholung, Benachrichtigung der Kanzlei bei endgültigem
      Fehlschlag. Inhalte, Empfänger und Abmeldungen bleiben gleich; Empfänger
      werden wie bisher beim Versand aufgelöst. Der GwG-Einladungslink liegt nur
      verschlüsselt im Auftrag und wird nach Abschluss gelöscht. Keine fachliche
      Freigabe; die Aufbewahrungsdauer der Auftragsmetadaten ist offen.
    tests:
      - apps/web/src/server/mail/__tests__/outbox.test.ts
      - apps/worker/src/jobs/__tests__/mail-outbox.test.ts
      - packages/db/src/__tests__/mail-outbox-rls.test.ts
      - packages/mail/src/__tests__/outbox.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261006-013
    date: '2026-10-06'
    paths:
      - apps/web/src/app/portal/(protected)/requests/[id]/page.tsx
      - apps/web/src/app/portal/(protected)/requests/page.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/gwg-page-labels.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/page.tsx
      - apps/web/src/app/staff/(protected)/documents/[id]/__tests__/tier-badge.test.tsx
      - apps/web/src/app/staff/(protected)/documents/[id]/page.tsx
      - apps/web/src/app/staff/(protected)/requests/[id]/page.tsx
      - apps/web/src/server/documents/managed-docs.ts
      - packages/storage/src/__tests__/tiers.test.ts
      - packages/storage/src/client.ts
      - packages/storage/src/index.ts
      - packages/storage/src/tiers.ts
    rule_ids:
      - GWG-RETENTION-DESTRUCTION-001
      - DOC-RETENTION-CLASS-001
      - REQ-LIFECYCLE-001
      - ACCESS-SEARCH-SCOPE-001
    reason: >-
      Bezeichnungen für Anforderungsstatus, Priorität und Mandantentyp kommen
      zentral aus lib/domain-labels.ts statt aus Kopien je Seite; die
      Schutzstufe eines Dokuments bestimmt eine einzige umgebungsfreie Regel in
      @taxtronik/storage (tiers.ts), die managed-docs wiederverwendet. Portal und
      Kanzlei teilen eine AuthShell. Die Dokument-Detailseite kennzeichnet
      GwG-Nachweise nicht mehr fälschlich als „GoBD-immutable“ mit
      COMPLIANCE-Hinweis. Angezeigte Texte, Aufbewahrungsklassen, Object-Lock-
      Regeln und Zugriffsprüfungen bleiben sonst unverändert. Keine fachliche
      Freigabe.
    tests:
      - packages/storage/src/__tests__/tiers.test.ts
      - apps/web/src/app/staff/(protected)/documents/[id]/__tests__/tier-badge.test.tsx
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261006-012
    date: '2026-10-06'
    paths:
      - apps/web/src/app/gwg-onboarding/__tests__/actions-expiry.test.ts
      - apps/web/src/app/gwg-onboarding/__tests__/bound-draft-submit.test.ts
      - apps/web/src/app/gwg-onboarding/__tests__/identity-source.test.ts
      - apps/web/src/app/gwg-onboarding/actions.ts
      - apps/web/src/app/portal/(protected)/forms/[id]/__tests__/actions.test.ts
      - apps/web/src/app/portal/(protected)/forms/[id]/actions.ts
      - apps/web/src/app/staff/(protected)/admin/audit/__tests__/actions-result.test.ts
      - apps/web/src/app/staff/(protected)/admin/dsgvo-retention/actions.ts
      - apps/web/src/app/staff/(protected)/admin/dsgvo/__tests__/actions.test.ts
      - apps/web/src/app/staff/(protected)/admin/gwg-retention/actions.ts
      - apps/web/src/app/staff/(protected)/admin/privacy/__tests__/actions.test.ts
      - apps/web/src/app/staff/(protected)/admin/privacy/actions.ts
      - apps/web/src/app/staff/(protected)/admin/privacy/page.tsx
      - apps/web/src/app/staff/(protected)/admin/quantenlos/actions.ts
      - apps/web/src/app/staff/(protected)/admin/settings/infra-actions.ts
      - apps/web/src/app/staff/(protected)/admin/settings/mail-actions.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/__tests__/actions.test.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/__tests__/invite-actions-access.test.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/notices/__tests__/create-notice-action.test.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/privacy/__tests__/actions.test.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/privacy/actions.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/reminders/actions.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/requests/__tests__/actions.test.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/requests/actions.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/screening/actions.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/subsumtion/actions.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/subsumtion/norm-actions.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/subsumtion/research-actions.ts
      - apps/web/src/app/staff/(protected)/dashboard/rss-feed-actions.ts
      - apps/web/src/app/staff/(protected)/documents/__tests__/folder-actions-access.test.ts
      - apps/web/src/app/staff/(protected)/documents/__tests__/restore-gwg.test.ts
      - apps/web/src/app/staff/(protected)/documents/__tests__/retag-race.test.ts
      - apps/web/src/app/staff/(protected)/documents/actions.ts
      - apps/web/src/app/staff/(protected)/documents/folder-actions.ts
      - apps/web/src/app/staff/(protected)/inbox/actions.ts
      - apps/web/src/app/staff/(protected)/invoices/actions.ts
      - apps/web/src/app/staff/(protected)/poa/__tests__/actions.test.ts
      - apps/web/src/app/staff/(protected)/poa/actions.ts
      - apps/web/src/app/staff/(protected)/stbvv/actions.ts
      - apps/web/src/app/staff/(protected)/tax-deadlines/__tests__/actions.test.ts
      - apps/web/src/server/actions/staff-action.ts
      - apps/web/src/server/auth/rbac.ts
      - apps/web/src/server/gwg-onboarding/submission-transaction.ts
      - apps/web/src/server/invoicing/__tests__/create-draft.test.ts
      - apps/web/src/server/invoicing/__tests__/invoice-actions.test.ts
      - apps/web/src/server/invoicing/__tests__/invoice-concurrency-db.test.ts
      - apps/web/src/server/invoicing/create-draft.ts
      - apps/web/src/server/privacy/consent-catalog.ts
      - apps/web/src/server/risk/catalog-norms.ts
      - apps/web/src/server/risk/delegate.ts
      - apps/web/src/server/risk/los-state.ts
      - apps/web/src/server/risk/los.ts
      - apps/web/src/server/risk/markings.ts
      - apps/web/src/server/risk/norms-core.ts
      - apps/web/src/server/risk/norms.ts
      - apps/web/src/server/risk/reanalyze.ts
      - apps/web/src/server/risk/reformat.ts
      - apps/web/src/server/risk/research.ts
      - apps/web/src/server/settings/modules.ts
      - apps/web/src/server/settings/portal-features.ts
      - apps/web/src/server/workflows/execute-step.ts
      - packages/storage/src/errors.ts
      - packages/storage/src/index.ts
      - packages/storage/src/service.ts
    rule_ids:
      - GWG-ACTIVATION-GATE-001
      - GWG-SELF-ONBOARDING-001
      - DOC-UPLOAD-JOURNAL-001
      - INV-ARCHIVE-EINVOICE-001
      - REQ-LIFECYCLE-001
      - POA-LIFECYCLE-001
      - RISK-AI-SUGGESTION-001
      - ACCESS-TENANT-RLS-001
    reason: >-
      Server-Actions ordnen Fehler zentral in einem Fehler-Mapper ein: fachliche
      Fehler als ActionError, Datenbankfehler nach Prisma-Code und SQLSTATE
      (einschließlich der GwG-Schranke 23514 mit Marker), Speicherfehler nach
      Fehlerklasse, Netzwerkfehler nach Name/Code; Eingaben werden mit safeParse
      statt parse geprüft. Bisher als „Unerwarteter Fehler“ endende Fälle zeigen
      ihre vorgesehene deutsche Meldung, rohe Datenbank- und Systemmeldungen
      erreichen die Oberfläche nicht mehr, auch nicht im anonymen
      GwG-Onboarding. Ein AST-Guard verbietet neue Fehlertexte per throw new
      Error in Server-Actions. Prüfungen, Berechtigungen, Trigger und
      Audit-Ereignisse bleiben unverändert; nur der Rückkanal der Fehler ändert
      sich. Keine fachliche Freigabe.
    tests:
      - apps/web/src/__tests__/action-error-contract.test.ts
      - apps/web/src/server/actions/__tests__/to-action-error.test.ts
      - packages/db/src/__tests__/database-error-classification.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261006-011
    date: '2026-10-06'
    paths:
      - apps/web/src/app/portal/(protected)/bwa/plan/plan-comparison.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/__tests__/page-render.test.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/_action-helpers.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/page.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/page.tsx
      - apps/web/src/app/staff/(protected)/dashboard/widgets/my-work-basket.tsx
      - apps/web/src/app/staff/(protected)/mandate-expansion/dependencies/page.tsx
      - apps/web/src/app/staff/(protected)/notifications/__tests__/actions.test.ts
      - apps/web/src/app/staff/(protected)/notifications/__tests__/page.test.tsx
      - apps/web/src/app/staff/(protected)/notifications/page.tsx
      - apps/web/src/app/staff/(protected)/requests/[id]/page.tsx
      - apps/web/src/components/bwa/projection-snapshot.ts
      - apps/web/src/components/knowledge-context.tsx
      - apps/web/src/server/gwg/check-mutation.ts
      - apps/web/src/server/mandate-expansion/gwg-structure-panel.tsx
      - apps/web/src/server/mandate-expansion/gwg-structure.ts
      - apps/web/src/app/staff/(protected)/notifications/actions.ts
    rule_ids:
      - GWG-BENEFICIAL-OWNERS-001
      - GWG-IDENTIFICATION-EVIDENCE-001
      - MANDATE-STRUCTURE-001
      - BWA-PROJECTION-001
      - KNOWLEDGE-CONTEXT-001
      - ACCESS-NOTIFICATION-RECIPIENT-001
      - ACCESS-SEARCH-SCOPE-001
    reason: >-
      Geteilte Oberflächenteile liegen nicht mehr unter src/server bzw. werden
      nicht mehr aus Routenordnern importiert: die Mandantenassistenz-Seite, der
      Mein-Tag-Schalter, das ActionForm der Mandatserweiterung und die
      BWA-Planbausteine liegen unter components/, die Benachrichtigungs-Actions
      unter server/notifications, die GwG-Prüfhilfen unter
      server/gwg/check-mutation.ts (von _action-helpers.ts re-exportiert);
      Wissenskontext, Kontaktpanel und GwG-Strukturpanel erhalten ihre Actions als
      Props. Eine ESLint-Regel sichert die Schichtgrenzen mit begründeter
      Allowlist. Nur Modulorte, Props und Importe ändern sich; Prüfungen,
      Zugriffsregeln, GwG-, BWA- und Benachrichtigungslogik bleiben unverändert.
      Keine fachliche Freigabe.
    tests:
      - apps/web/src/__tests__/app-layer-imports.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261006-010
    date: '2026-10-06'
    paths:
      - apps/web/src/app/staff/(protected)/fristen/page.tsx
      - apps/web/src/server/fristen/__tests__/kontrollbuch-seite.test.ts
      - apps/web/src/server/fristen/__tests__/kontrollbuch.test.ts
      - apps/web/src/server/fristen/__tests__/tagesabschluss.test.ts
      - apps/web/src/server/fristen/kontrollbuch.ts
      - apps/web/src/server/fristen/quellen/anforderungen.ts
      - apps/web/src/server/fristen/quellen/bescheid.ts
      - apps/web/src/server/fristen/quellen/einspruchsfristen.ts
      - apps/web/src/server/fristen/quellen/index.ts
      - apps/web/src/server/fristen/quellen/interne-prueftermine.ts
      - apps/web/src/server/fristen/quellen/klagefristen.ts
      - apps/web/src/server/fristen/quellen/steuertermine.ts
      - apps/web/src/server/fristen/quellen/typen.ts
      - apps/web/src/server/fristen/quellen/wiedervorlagen.ts
      - apps/web/src/server/fristen/tagesabschluss.ts
    rule_ids:
      - TAX-CONTROL-STATUS-001
    reason: >-
      Das Fristen-Kontrollbuch ist in je einen Adapter pro Fristquelle
      (Bescheide, Steuertermine, Einspruchs- und Klagefristen, interne
      Prüftermine, Anforderungen, Wiedervorlagen) und einen Orchestrator
      zerlegt. Die Fristenseite lädt offene Einträge seitenweise (200 je Seite,
      dringendste zuerst) mit Zählern aus count-Abfragen; die
      Tagesabschluss-Vorschau entsteht aus dem geladenen Ergebnis statt aus einem
      zweiten Volllauf. CSV-Export und Tagesabschluss-Protokoll nutzen weiter den
      vollständigen Lader. Ein einmaliger Differenzvergleich gegen den alten Lader
      auf PostgreSQL (1.152 Kombinationen, rund 132.000 Einträge) ergab gleiche
      Einträge, Reihenfolge, Zähler und Tagesabschlüsse. Bei mehreren
      Hauptbearbeitern oder Zuständigen gilt jetzt einheitlich die erste
      Zuweisung als verantwortlich statt einer von der Zeilenreihenfolge
      abhängigen. Fristberechnung, Status und Kontrollpflichten bleiben
      unverändert. Keine fachliche Freigabe.
    tests:
      - apps/web/src/server/fristen/__tests__/kontrollbuch.test.ts
      - apps/web/src/server/fristen/__tests__/kontrollbuch-seite.test.ts
      - apps/web/src/server/fristen/__tests__/tagesabschluss.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261006-009
    date: '2026-10-06'
    paths:
      - packages/tax/src/__tests__/legal-assessments.test.ts
      - packages/tax/src/__tests__/plausibility-engine.test.ts
      - packages/tax/src/engine.ts
      - packages/tax/src/legal-assessments.ts
    rule_ids:
      - TAX-NOTICE-APPEAL-001
      - TAX-DEADLINE-WORKDAY-001
      - TAX-NOTICE-DATARETRIEVAL-001
    reason: >-
      Der als veraltet markierte, nicht exportierte Fristen-Rechenkern in
      packages/tax/src/engine.ts (appealDeadline, klageDeadline und Hilfen) wurde
      nur von einem Test aufgerufen und ist entfernt. Dessen Fallbeispiele laufen
      jetzt gegen die produktiven assess*-Funktionen in legal-assessments.ts, die
      zusätzlich Jahresfrist, Auslandspost, Datenabruf-Altfall und fehlendes
      Bescheiddatum abdecken. Die Feiertagsprüfung speichert je Jahr, Region und
      Bayern-Annahme zwischen; ein Test belegt Gleichheit für jeden Tag 2025/2026
      in allen Regionen. Fristergebnisse bleiben unverändert. Keine fachliche
      Freigabe; der Implementierungstext von TAX-NOTICE-APPEAL-001 erwähnt die
      entfernten Hilfsfunktionen noch und ist vom Regelverantwortlichen
      nachzuziehen.
    tests:
      - packages/tax/src/__tests__/legal-assessments.test.ts
      - packages/tax/src/__tests__/plausibility-engine.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261006-008
    date: '2026-10-06'
    paths:
      - apps/web/src/app/staff/(protected)/admin/audit/__tests__/actions-result.test.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/__tests__/actions.test.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/_action-helpers.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/actions.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/id-document-actions.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/reminders/actions.ts
    rule_ids:
      - GWG-BENEFICIAL-OWNERS-001
      - GWG-IDENTIFICATION-EVIDENCE-001
      - GWG-ACTIVATION-GATE-001
      - GWG-REVERIFICATION-VALIDITY-001
      - REMINDER-TICKET-001
    reason: >-
      Ungenutzte Server-Actions ohne Aufrufer außerhalb von Tests entfallen:
      deleteReminderAction (Alias von archiveReminderAction), openCheckAction
      (Alias von startNewCheckCycleAction), markPhoneNoteReadById, der manuelle
      Audit-Rotations-Trigger sowie die nie eingebundene Altfassung zum Anlegen
      wirtschaftlich Berechtigter (add-owner-form.tsx, addBeneficialOwnerAction);
      deren Tests laufen jetzt gegen addGwgPersonAction, den produktiven Pfad.
      Der Fachkatalog-Verweis auf add-owner-form.tsx ist entfernt; die Regel nennt
      bereits new-gwg-person-form.tsx. Erreichbare Abläufe, Prüfungen und
      Audit-Ereignisse bleiben unverändert. Keine fachliche Freigabe.
    tests:
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/__tests__/actions.test.ts
      - apps/web/src/app/staff/(protected)/admin/audit/__tests__/actions-result.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261006-007
    date: '2026-10-06'
    paths:
      - .forgejo/workflows/ci.yml
    rule_ids:
      - ASSURANCE-RELEASE-EVIDENCE-001
      - AUDIT-RFC3161-ANCHOR-001
      - AUDIT-VERIFY-ALERT-001
    reason: >-
      Der CI-Job e2e-paranoid baut die Web-App mit NODE_ENV=production und startet
      für die Playwright-Suite den ausgelieferten Standalone-Server statt
      next start, mit expliziten Nicht-Default-Zugangsdaten für S3 und den
      digest-gepinnten Produktions-Images von PostgreSQL (18-alpine) und Redis.
      Playwright wiederholt fehlgeschlagene Tests nicht mehr (retries: 0); der
      Paranoid-Guard lehnt Wiederholungen ab. Umfang der Suite, Release-Gates und
      der Testnachweis „E2E Paranoid“ bleiben unverändert. Keine fachliche
      Freigabe.
    tests:
      - scripts/tests/check-paranoid-e2e.test.mjs
      - scripts/release/tests/check-release-gates.test.mjs
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261006-006
    date: '2026-10-06'
    paths:
      - apps/web/src/app/staff/(protected)/clients/[id]/_data.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/page.tsx
      - apps/web/src/app/staff/(protected)/documents/page.tsx
      - apps/web/src/server/documents/__tests__/managed-docs.test.ts
      - apps/web/src/server/documents/managed-docs.ts
    rule_ids:
      - ACCESS-SEARCH-SCOPE-001
      - REMINDER-TICKET-001
    reason: >-
      Dokumentenverwaltung, Mandanten-Tab und Subsumtionsablage nutzen ein
      gemeinsames DTO und eine gemeinsame Stufenzuordnung aus
      server/documents/managed-docs.ts. loadClientDocumentsPage filtert Ordner
      (mit Unterordnern) und Titelsuche serverseitig über alle Dokumente des
      zugriffsgeprüften Mandanten statt nur über die geladene Seite; Zähler und
      Blättern folgen der Auswahl. Ein gemeinsamer Löschdialog fragt in beiden
      Ansichten nach einem optionalen Grund und zeigt die GoBD-/GwG-Hinweise.
      Zugriffsprüfungen, das Audit-Ereignis document.delete und die
      Wiedervorlagen-Abfrage bleiben unverändert. Keine fachliche Freigabe.
    tests:
      - apps/web/src/server/documents/__tests__/managed-docs.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261006-005
    date: '2026-10-06'
    paths:
      - apps/web/src/app/portal/(protected)/bwa/page.tsx
      - apps/web/src/app/portal/(protected)/bwa/plan/new/page.tsx
      - apps/web/src/app/portal/(protected)/forms/[id]/page.tsx
      - apps/web/src/app/portal/(protected)/forms/page.tsx
      - apps/web/src/app/portal/(protected)/invoices/page.tsx
      - apps/web/src/app/portal/(protected)/steuer/page.tsx
      - apps/web/src/app/staff/(protected)/admin/quantenlos/page.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/bwa/[periodId]/page.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/bwa/plans/new/page.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/bwa/plans/page.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/notices/new/page.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/notices/page.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/page.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/subsumtion/_guard.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/tax-schedule/page.tsx
      - apps/web/src/app/staff/(protected)/forms/submissions/[id]/page.tsx
      - apps/web/src/app/staff/(protected)/interactions/page.tsx
      - apps/web/src/app/staff/(protected)/invoices/[id]/page.tsx
      - apps/web/src/app/staff/(protected)/invoices/__tests__/page.test.tsx
      - apps/web/src/app/staff/(protected)/invoices/new/__tests__/page.test.tsx
      - apps/web/src/app/staff/(protected)/invoices/new/page.tsx
      - apps/web/src/app/staff/(protected)/invoices/page.tsx
      - apps/web/src/app/staff/(protected)/mailbox/page.tsx
      - apps/web/src/app/staff/(protected)/payroll/page.tsx
      - apps/web/src/app/staff/(protected)/poa/[id]/page.tsx
      - apps/web/src/app/staff/(protected)/poa/__tests__/client-context.test.ts
      - apps/web/src/app/staff/(protected)/poa/new/page.tsx
      - apps/web/src/app/staff/(protected)/poa/page.tsx
      - apps/web/src/app/staff/(protected)/reminders/[id]/page.tsx
      - apps/web/src/app/staff/(protected)/reminders/page.tsx
      - apps/web/src/app/staff/(protected)/tax-deadlines/__tests__/page-render.test.tsx
      - apps/web/src/app/staff/(protected)/tax-deadlines/group/page.tsx
      - apps/web/src/app/staff/(protected)/tax-deadlines/page.tsx
      - apps/web/src/app/staff/(protected)/year-end/page.tsx
    rule_ids:
      - ACCESS-SEARCH-SCOPE-001
      - ACCESS-CLIENT-MODE-001
      - REMINDER-TICKET-001
      - TAX-NOTICE-APPEAL-001
      - TAX-NOTICE-DATARETRIEVAL-001
      - TAX-DEADLINE-AUTOREQUEST-001
      - TAX-CONTROL-STATUS-001
      - BWA-IMPORT-MAPPING-001
      - BWA-PROJECTION-001
      - BWA-TAX-ESTIMATE-001
      - FORM-SCHEMA-SNAPSHOT-001
      - YEAR-END-CAMPAIGN-001
      - INV-PORTAL-SHARING-001
      - INV-DUE-OVERDUE-001
      - MAIL-INBOX-001
      - PAYROLL-INTAKE-001
      - CLIENT-FEEDBACK-001
      - TCMS-SAMPLE-PROOF-001
    reason: >-
      Navigation, Routen-Gate und Seitenprüfung lesen die Zuordnung Pfad → Modul
      aus einer gemeinsamen Registry (lib/module-registry.ts); jede Modulseite
      prüft ihr Modul zusätzlich selbst über requireModulePage() und antwortet
      bei abgeschaltetem Modul mit 404, auch bei Navigation innerhalb der App.
      Es werden nur Einstiegsprüfungen der Seiten ergänzt; Fachlogik,
      Zugriffsregeln, Fristen, Bescheid-, BWA-, Rechnungs-, Formular- und
      Jahreswechsel-Abläufe bleiben unverändert. Der Kanzleikalender erscheint,
      sobald Termine oder Steuertermine aktiv sind, und zeigt nur Inhalte
      aktiver Module. Keine fachliche Freigabe.
    tests:
      - apps/web/src/lib/__tests__/module-registry.test.ts
      - apps/web/src/server/settings/__tests__/module-page.test.ts
      - apps/web/src/__tests__/module-page-guard.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261006-004
    date: '2026-10-06'
    paths:
      - apps/web/src/app/staff/(protected)/clients/[id]/billing/actions.ts
      - apps/web/src/app/staff/(protected)/invoices/actions.ts
      - apps/web/src/server/invoicing/__tests__/archive.test.ts
      - apps/web/src/server/invoicing/__tests__/create-draft.test.ts
      - apps/web/src/server/invoicing/create-draft.ts
      - apps/web/src/server/invoicing/time-billing.ts
      - apps/web/src/server/invoicing/vat.ts
      - apps/web/src/server/stbvv/service.ts
    rule_ids:
      - INV-NUMBER-ALLOCATION-001
      - INV-VAT-TOTALS-001
      - INV-TIME-ENTRY-CLAIM-001
      - STBVV-CALCULATION-001
      - INV-ARCHIVE-EINVOICE-001
    reason: >-
      Manuelle Rechnung, Stundenabrechnung und StBVV-Rechnung legen Entwürfe über
      einen gemeinsamen Dienst createDraftInvoiceTx an: dieselben Prüfungen wie
      bisher der manuelle Pfad (Reverse-Charge nach § 13b UStG nur mit
      USt-IdNr von Kanzlei und Mandant, BR-AE-01; Beträge innerhalb
      Decimal(12,2); Rechnungsdatum im laufenden Jahr ±1), danach
      Nummernvergabe, Kopf, Positionen, Übernahme der Quelle und
      Audit-Ereignis. Für gültige Rechnungen sind Nummernvergabe, Kopf- und
      Positionsdaten, Übernahme der Zeiteinträge und Audit-Ereignisse je Pfad
      unverändert (Tests je Pfad, Differenzvergleich mit 7.000 Zufallsentwürfen).
      Ungültige Zeit- und StBVV-Rechnungen werden jetzt vor der Nummernvergabe
      abgelehnt statt erst beim Versand. Keine fachliche Freigabe; die
      Rückdatierungsgrenze für Zeit- und StBVV-Rechnungen bleibt eine offene
      Prüffrage zu INV-NUMBER-ALLOCATION-001.
    tests:
      - apps/web/src/server/invoicing/__tests__/create-draft.test.ts
      - apps/web/src/server/invoicing/__tests__/archive.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261006-003
    date: '2026-10-06'
    paths:
      - apps/web/src/app/api/staff/invoices/[id]/xrechnung/__tests__/route.test.ts
      - apps/web/src/app/api/staff/invoices/[id]/xrechnung/route.ts
      - apps/web/src/app/api/staff/invoices/[id]/zugferd/__tests__/route.test.ts
      - apps/web/src/app/api/staff/invoices/[id]/zugferd/route.ts
      - apps/web/src/app/staff/(protected)/invoices/actions.ts
      - apps/web/src/server/invoicing/__tests__/archive-failure.test.ts
      - apps/web/src/server/invoicing/__tests__/archive-lock-call-sites.test.ts
      - apps/web/src/server/invoicing/__tests__/archive.test.ts
      - apps/web/src/server/invoicing/archive-failure.ts
      - apps/web/src/server/invoicing/archive.ts
    rule_ids:
      - INV-ARCHIVE-EINVOICE-001
      - INV-PORTAL-SHARING-001
      - INV-STORNO-REFERENCE-001
      - INV-LIFECYCLE-FREEZE-001
    reason: >-
      Die Download-Routen für XRechnung und ZUGFeRD nutzen die aus archive.ts
      exportierten Prüfungen (Freigabe, Stammdaten, Entwurf, Käufer-Mapping,
      Recheck) statt eigener Kopien und antworten über eine gemeinsame
      Fehlerzuordnung mit festen deutschen Texten; technische Details stehen nur
      im Server-Log. Reverse-Charge ohne USt-IdNr der Kanzlei liefert in beiden
      Routen 422 mit Grund statt 404. Ein Entwurf, dessen Archivverweis während
      der Vorschau verschwindet, erzeugt kein GoBD-Archiv mehr aus einem GET.
      Archivierung, Rechnungsinhalt, Freigabe- und Storno-Regeln gültiger
      Rechnungen bleiben unverändert. Keine fachliche Freigabe.
    tests:
      - apps/web/src/app/api/staff/invoices/[id]/xrechnung/__tests__/route.test.ts
      - apps/web/src/app/api/staff/invoices/[id]/zugferd/__tests__/route.test.ts
      - apps/web/src/server/invoicing/__tests__/archive-failure.test.ts
      - apps/web/src/server/invoicing/__tests__/archive.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261006-002
    date: '2026-10-06'
    paths:
      - apps/web/src/app/api/portal/documents/__tests__/read-rate-limit.test.ts
      - apps/web/src/app/api/portal/interactions/[id]/document/route.ts
      - apps/web/src/app/api/staff/clients/[id]/subsumtion/[analysisId]/export/route.ts
      - apps/web/src/app/api/staff/documents/__tests__/delivery-access.test.ts
      - apps/web/src/app/api/staff/gwg/export/route.ts
      - apps/web/src/app/api/staff/gwg/identity-source/route.ts
      - apps/web/src/app/gwg-onboarding/__tests__/bound-draft-submit.test.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/__tests__/actions.test.ts
      - apps/web/src/server/client-assistance/download.ts
      - apps/web/src/server/client-assistance/outputs.ts
      - apps/web/src/server/documents/__tests__/delivery.test.ts
      - apps/web/src/server/documents/delivery.ts
      - apps/web/src/server/forms/revision-download.ts
      - apps/web/src/server/gwg/__tests__/identity-source.test.ts
      - apps/web/src/server/gwg/identity-source.ts
      - apps/web/src/server/payroll/download.ts
      - apps/web/src/server/payroll/storage.ts
      - apps/web/src/server/storage/document-preview.ts
      - packages/storage/src/__tests__/verified-read.test.ts
      - packages/storage/src/index.ts
      - packages/storage/src/service.ts
    rule_ids:
      - DOC-VERSION-IMMUTABILITY-001
      - DOC-PORTAL-SHARING-001
      - DOC-UPLOAD-JOURNAL-001
      - TAX-NOTICE-DECISION-001
      - CLIENT-ASSISTANCE-001
      - PAYROLL-INTAKE-001
      - GWG-IDENTIFICATION-EVIDENCE-001
      - GWG-OCR-ASSIST-001
      - GWG-CONTROL-EXPORT-001
      - ACCESS-CLIENT-MODE-001
      - FORM-SCHEMA-SNAPSHOT-001
      - YEAR-END-CAMPAIGN-001
    reason: >-
      Alle Lesepfade für gespeicherte Objekte (Dokument-Download und -Vorschau,
      Bescheid-Rückfrage, Mandantenassistenz, Lohnunterlagen, Formularrevisionen,
      GwG-Ausweisquelle, Postfach-Anhang) lesen über fetchVerifiedObjectBytes bzw.
      streamVerifiedObject aus @taxtronik/storage: gebundene Objektversion,
      Größengrenze und, wo bekannt, Größe und SHA-256 werden immer geprüft;
      abweichende Bytes werden nicht vollständig ausgeliefert. Die Vorschau
      erkennt den Dateityp über die ersten 1 KB per Range-Request. Header,
      Statuscodes, Zugriffsprüfungen, Audit-Ereignisse und ausgelieferte Inhalte
      konsistenter Daten bleiben unverändert. Keine fachliche Freigabe.
    tests:
      - packages/storage/src/__tests__/verified-read.test.ts
      - apps/web/src/app/api/portal/interactions/[id]/document/__tests__/route.test.ts
      - apps/web/src/app/api/staff/mailbox/attachments/[id]/__tests__/route.test.ts
      - apps/web/src/server/documents/__tests__/delivery.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261006-001
    date: '2026-10-06'
    paths:
      - apps/web/src/server/auth/revocation.ts
      - apps/web/src/server/backup/restore.ts
      - apps/web/src/server/gwg/retention.ts
      - apps/worker/src/jobs/backup-drill.ts
      - apps/worker/src/jobs/gwg-expiry-check.ts
      - packages/tax/src/__tests__/gwg-retention.test.ts
      - packages/tax/src/gwg-retention.ts
      - packages/tax/src/index.ts
    rule_ids:
      - GWG-RETENTION-DESTRUCTION-001
      - GWG-REVERIFICATION-VALIDITY-001
      - BACKUP-DRILL-INTEGRITY-001
      - ACCESS-TENANT-RLS-001
      - AUDIT-HASH-CHAIN-001
    reason: >-
      Web und Worker nutzen für den Widerruf von Portal-Sitzungen, die Prädikate
      der GwG-Löschfrist (§ 8 Abs. 4 GwG), die pg_restore-Argumente und den
      Backup-Lauf jeweils eine gemeinsame Implementierung in @taxtronik/crypto,
      @taxtronik/tax und @taxtronik/db/pg-tools statt synchron gehaltener
      Kopien. Referenz ist jeweils die Web-Fassung: Fristbeginn, Löschfrist und
      Höchstfrist sowie die Review-Queue bleiben unverändert; ein
      PostgreSQL-Test belegt die Gleichheit der Filter. Der Worker widerruft
      Sitzungen jetzt wie das Web monoton und fail-closed, der Operator-Backup
      schließt wie der Worker verwaiste RUNNING-Einträge. Keine fachliche
      Freigabe.
    tests:
      - packages/tax/src/__tests__/gwg-retention.test.ts
      - packages/crypto/src/__tests__/session-revocation.test.ts
      - packages/db/src/__tests__/pg-tools.test.ts
      - packages/db/src/__tests__/gwg-retention-count.test.ts
      - apps/worker/src/jobs/__tests__/gwg-expiry-check.test.ts
      - apps/web/src/server/backup/__tests__/runner.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261005-044
    date: '2026-10-05'
    paths:
      - apps/web/src/app/portal/(protected)/forms/page.tsx
    rule_ids:
      - REQ-LIFECYCLE-001
      - TAX-NOTICE-DECISION-001
    reason: >-
      Die Formularliste des Portals nutzt für „offen“ und „Geschlossen“ eine
      gemeinsame Funktion (server/portal/form-open.ts) mit unveränderter Logik:
      Ein Formular ist nur offen, solange es PENDING/DRAFT ist und seine gebundene
      Anforderung offen ist; ohne gebundene Anforderung fail-closed über alle
      verknüpften Anforderungen. Die Portal-Startseite verwendet dieselbe Regel
      und zählt an persönliche Rückfragen gebundene Anforderungen wie
      /portal/requests nicht als allgemeine Anforderung; der gebundene Kontakt
      sieht seine offene Rückfrage als eigenes To-do. Antwortrechte, Status und
      Fristen bleiben unverändert. Keine fachliche Freigabe.
    tests:
      - apps/web/src/server/portal/__tests__/form-open.test.ts
      - apps/web/src/app/portal/(protected)/dashboard/__tests__/page.test.tsx
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261005-043
    date: '2026-10-05'
    paths:
      - .forgejo/workflows/ci.yml
      - .forgejo/workflows/release.yml
    rule_ids:
      - ASSURANCE-RELEASE-EVIDENCE-001
      - AUDIT-RFC3161-ANCHOR-001
      - AUDIT-VERIFY-ALERT-001
    reason: >-
      Die von keiner Plattform gelesene .forgejo/dependabot.yml entfällt; ein
      selbst gehostetes Renovate (renovate.json, Workflow renovate.yml) schlägt
      npm-Updates frühestens nach 7 Tagen sowie neue Image-Digests und Action-SHAs
      vor. In ci.yml und release.yml erhalten die SHA-gepinnten Actions nur ihren
      Release-Tag als Kommentar; die Pins selbst, Release-Gates, Testnachweise,
      RFC-3161-Anker und Prüfalarme bleiben unverändert. Keine fachliche Freigabe.
    tests:
      - scripts/release/tests/check-release-gates.test.mjs
      - scripts/tests/check-docker-bases-pinned.test.mjs
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261005-042
    date: '2026-10-05'
    paths:
      - .forgejo/workflows/ci.yml
      - scripts/release/check-release-gates.mjs
      - scripts/release/tests/check-release-gates.test.mjs
    rule_ids:
      - ASSURANCE-RELEASE-EVIDENCE-001
      - AUDIT-RFC3161-ANCHOR-001
      - AUDIT-VERIFY-ALERT-001
    reason: >-
      Die CI-Jobs db, restore, upgrade-path und e2e-paranoid laufen nach dem
      Quality-Job parallel, jeder mit eigenem PostgreSQL-Port, statt nur wegen
      desselben Host-Ports als serielle Kette. Der separate e2e-smoke-Job geht in
      e2e-paranoid auf, das die Smoke-Spec ohnehin mit ausführt; die wiederholten
      Setup-Schritte bündelt scripts/ci/setup.sh. check-release-gates.mjs prüft
      statt der Serialisierung eindeutige Ports, konsistente Datenbank-URLs und die
      Abhängigkeit vom Quality-Job. Alle bisherigen Prüf-, Test- und
      Nachweisschritte bleiben erhalten; der Testnachweis „Browser E2E“ entfällt
      zugunsten des unveränderten Nachweises „E2E Paranoid“. Keine fachliche
      Freigabe.
    tests:
      - scripts/release/tests/check-release-gates.test.mjs
      - packages/db/src/__tests__/migration-cutoff-ci.test.ts
      - apps/web/src/server/mandate-expansion/__tests__/service-db-ci.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261005-041
    date: '2026-10-05'
    paths:
      - .forgejo/workflows/ci.yml
      - .forgejo/workflows/release.yml
    rule_ids:
      - ASSURANCE-RELEASE-EVIDENCE-001
      - AUDIT-RFC3161-ANCHOR-001
      - AUDIT-VERIFY-ALERT-001
    reason: >-
      Alle Workflows (ci.yml, release.yml u. a.) beziehen die Node-Version aus
      .nvmrc (24.19.0, identisch mit der gepinnten Host-Laufzeit), statt je Schritt
      node-version 24 zu setzen; CI-Jobs installieren ohne --ignore-scripts mit
      genau den in allowBuilds freigegebenen Install-Skripten statt
      handgepflegter pnpm-rebuild-Listen. Web- und Worker-Image teilen eine
      digest-gepinnte Basis. Release-Gates, Signatur- und Manifestprüfung,
      Testnachweise, RFC-3161-Anker und Prüfalarme bleiben unverändert. Keine
      fachliche Freigabe.
    tests:
      - scripts/tests/check-docker-bases-pinned.test.mjs
      - scripts/release/tests/check-release-gates.test.mjs
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261005-040
    date: '2026-10-05'
    paths:
      - .forgejo/workflows/ci.yml
    rule_ids:
      - ASSURANCE-RELEASE-EVIDENCE-001
      - GWG-ACTIVATION-GATE-001
      - GWG-SELF-ONBOARDING-001
    reason: >-
      Die Altbestandstests für die GwG-Migration 034 und den Onboarding-Backfill
      041 stehen nicht mehr als Inline-Bash in ci.yml, sondern als SQL-Fixtures
      und -Erwartungen unter scripts/ci/migration-cutoff, ausgeführt von
      scripts/ci/migration-cutoff.sh. Sie laufen im upgrade-path-Job bei jedem
      CI-Lauf statt nur nach einem v*-Tag und lokal. Das SQL der Fixtures und
      Erwartungen ist gegenüber der bisherigen Fassung unverändert; ein Guard-Test
      hält die Schritte unbedingt und die Cutoffs korrekt. Keine fachliche
      Freigabe.
    tests:
      - packages/db/src/__tests__/migration-cutoff-ci.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261005-039
    date: '2026-10-05'
    paths:
      - .forgejo/workflows/ci.yml
      - scripts/release/generate-update-key.mjs
      - scripts/release/verify-release-version.mjs
    rule_ids:
      - ASSURANCE-RELEASE-EVIDENCE-001
      - AUDIT-RFC3161-ANCHOR-001
      - AUDIT-VERIFY-ALERT-001
    reason: >-
      ESLint läuft je Quality-Lauf nur noch einmal: React-Compiler-Regeln sind
      Fehler, die bestehende Komplexitätsschuld steht je Datei in
      eslint-suppressions.json und kann nur sinken. Der Quality-Job in ci.yml ruft
      deshalb die beiden entfallenen Baseline-Skripte nicht mehr auf. Die
      Release-Skripte generate-update-key.mjs und verify-release-version.mjs sind
      nur neu formatiert (Prettier erfasst jetzt alle .mjs-Dateien). Release-Gates,
      Testnachweise, RFC-3161-Anker und Prüfalarme bleiben unverändert. Keine
      fachliche Freigabe.
    tests:
      - scripts/release/tests/check-release-gates.test.mjs
      - scripts/release/tests/verify-release-version.test.mjs
      - scripts/tests/check-paranoid-e2e.test.mjs
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261005-038
    date: '2026-10-05'
    paths:
      - apps/web/src/app/portal/(protected)/layout.tsx
    rule_ids:
      - ACCESS-TENANT-RLS-001
    reason: >-
      Die Kopfleiste des Mandantenportals erhält nur die CSS-Klasse app-topbar,
      damit der Glaseffekt des modernen Modus ausschließlich die Kopfleiste trifft
      statt sticky Tabellenzellen und Aktionsleisten. Sitzungsprüfung,
      Tenant-Kontext und Zugriffsentscheidungen des Layouts bleiben unverändert.
      Keine fachliche Freigabe.
    tests:
      - apps/web/src/app/__tests__/dark-mode-tokens.test.ts
      - apps/web/src/components/__tests__/accessible-display-css.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261005-037
    date: '2026-10-05'
    paths:
      - apps/web/src/app/staff/(protected)/clients/[id]/_data.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/page.tsx
    rule_ids:
      - ACCESS-SEARCH-SCOPE-001
      - REMINDER-TICKET-001
    reason: >-
      Das Mandanten-Cockpit lädt seine Daten in drei Transaktionen mit je eigenem
      Tenant-Kontext und derselben positiven Zugriffsprüfung wie bisher: Kopf
      (blockierend), Kartenblöcke (parallel gestartet, Abfragen abgeschalteter
      Module entfallen) und Dokumente (unverändert). Die Karten streamen in
      eigenen Suspense-Grenzen nach Kopf und Navigation. Die
      Wiedervorlagen-Abfrage und alle Sichtbarkeitsregeln bleiben unverändert;
      höchstens drei gleichzeitige Transaktionen je Aufruf. Keine fachliche
      Freigabe.
    tests:
      - apps/web/src/app/staff/(protected)/clients/[id]/__tests__/data.test.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/__tests__/page-streaming.test.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/__tests__/page-structure.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261005-036
    date: '2026-10-05'
    paths:
      - .forgejo/workflows/ci.yml
      - apps/web/src/app/staff/(protected)/tax-deadlines/__tests__/page-render.test.tsx
      - apps/web/src/app/staff/(protected)/tax-deadlines/page.tsx
    rule_ids:
      - ACCESS-SEARCH-SCOPE-001
      - TAX-DEADLINE-AUTOREQUEST-001
      - ASSURANCE-RELEASE-EVIDENCE-001
    reason: >-
      Die Monatsansicht der Steuertermine zählt die Termine je Tag per groupBy
      unter derselben Sichtbarkeitsregel, statt alle Termine des Monats samt
      Mandant zu laden; Monatsraster und Tageszellen teilt sie mit dem
      Kanzleikalender. Das gerenderte HTML ist für Monatsansicht, Ansicht mit
      Filter und Suche sowie den Kanzleikalender byteidentisch, nur die Reihenfolge
      der Termine eines Tages ist jetzt fest. Ein Datenbanktest unter der App-Rolle
      mit RLS läuft im DB-CI-Job. Fristberechnung und automatische Anforderungen
      bleiben unverändert. Keine fachliche Freigabe.
    tests:
      - apps/web/src/server/tax-deadlines/__tests__/day-groups-db.test.ts
      - apps/web/src/lib/__tests__/tax-calendar-month.test.ts
      - apps/web/src/app/staff/(protected)/tax-deadlines/__tests__/page-render.test.tsx
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261005-035
    date: '2026-10-05'
    paths:
      - apps/web/src/app/staff/(protected)/clients/page.tsx
      - apps/web/src/app/staff/(protected)/tax-deadlines/__tests__/list-data.test.ts
      - apps/web/src/app/staff/(protected)/tax-deadlines/__tests__/page-render.test.tsx
      - apps/web/src/app/staff/(protected)/tax-deadlines/_list-data.ts
      - apps/web/src/app/staff/(protected)/tax-deadlines/page.tsx
    rule_ids:
      - ACCESS-SEARCH-SCOPE-001
      - TAX-DEADLINE-AUTOREQUEST-001
    reason: >-
      Die Kacheln „Überfällig“ und „Anstehend“ der Steuertermine zählen per
      count() mit exakt den Filtern der Listen einschließlich des
      Sichtbarkeitsfilters, statt die Länge der auf 100 bzw. 200 Zeilen begrenzten
      Listen anzuzeigen; beide Listen sind seitenweise blätterbar. Die
      Mandantenliste zählt wie Mandantenseite und CSV-Export keine gelöschten
      Dokumente mehr. Sichtbarkeitsregeln, Fristberechnung und automatische
      Anforderungen bleiben unverändert. Keine fachliche Freigabe.
    tests:
      - apps/web/src/app/staff/(protected)/tax-deadlines/__tests__/list-data.test.ts
      - apps/web/src/app/staff/(protected)/tax-deadlines/__tests__/page-render.test.tsx
      - apps/web/src/app/staff/(protected)/clients/__tests__/list-document-count.test.tsx
      - apps/web/src/app/portal/(protected)/dashboard/__tests__/page.test.tsx
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261005-034
    date: '2026-10-05'
    paths:
      - apps/web/next.config.mjs
      - apps/web/scripts/verify-standalone-trace.mjs
    rule_ids:
      - MAIL-INBOX-001
    reason: >-
      next.config.mjs führt bcryptjs zusätzlich als externes Serverpaket, weil die
      Staff-Passwortprüfung jetzt in einem begrenzten Worker-Thread-Pool läuft und
      das echte Modul lädt; das Standalone-Prüfskript sichert, dass das
      Produktionspaket bcryptjs auflöst. Die Einträge für den PDF-Vorabcheck der
      Mail-Anhänge (pdf-lib) und die übrigen Worker-Parser bleiben unverändert.
      Hash-Format, Kostenfaktor und Ergebnis der Passwortprüfung bleiben gleich.
      Keine fachliche Freigabe.
    tests:
      - apps/web/src/server/auth/__tests__/password-hash-pool.test.ts
      - apps/web/src/server/auth/__tests__/staff-login-enumeration.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261005-033
    date: '2026-10-05'
    paths:
      - apps/web/src/instrumentation.ts
      - apps/web/src/server/auth/webauthn.ts
      - packages/db/prisma/migrations/20261005120000_fido_mds_snapshot/migration.sql
      - packages/db/prisma/schema.prisma
      - scripts/check-pnpm-supply-chain.sh
    rule_ids:
      - ACCESS-TENANT-RLS-001
      - AUDIT-HASH-CHAIN-001
    reason: >-
      Der signierte FIDO-Metadaten-BLOB wird nicht mehr im Request der
      Hardware-Anmeldung geladen und geprüft, sondern vom Hintergrundjob
      fido-mds-refresh alle 20 Minuten mit unveränderter Prüfung (Signer-Identität,
      Signatur, Kette, CRLs, Seriennummer, nextUpdate). Der geprüfte Stand liegt in
      neuen Snapshot-Spalten des bestehenden owner-only Ankers fido_mds_trust_state
      (Migration 20261005120000); keine neue Tabelle, keine Rechte der App-Rolle,
      keine neue RLS-Ausnahme. Die Web-App liest nur diesen Stand und sperrt
      Hardware-Vorgänge fail-closed, wenn kein Snapshot zur verankerten Serie
      existiert, die letzte Prüfung älter als eine Stunde ist oder nextUpdate
      erreicht ist. webauthn.ts wird ohne Änderung der öffentlichen API und der
      Audit-Ereignisse in Module aufgeteilt. Keine fachliche Freigabe.
    tests:
      - apps/web/src/server/auth/__tests__/webauthn.test.ts
      - apps/worker/src/jobs/__tests__/fido-mds-refresh.test.ts
      - apps/worker/src/jobs/__tests__/fido-mds-verify.test.ts
      - packages/db/src/__tests__/fido-mds-snapshot.test.ts
      - packages/db/src/__tests__/staff-webauthn-migration.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261005-032
    date: '2026-10-05'
    paths:
      - apps/web/next.config.mjs
      - apps/web/scripts/verify-standalone-trace.mjs
      - apps/web/src/server/documents/__tests__/pdf-font-location.test.ts
      - apps/web/src/server/documents/pdf-fonts.ts
    rule_ids:
      - INV-ARCHIVE-EINVOICE-001
      - RISK-ARCHIVE-SNAPSHOT-001
      - CLIENT-ASSISTANCE-001
      - CLIENT-OFFBOARDING-001
      - MANDATE-STRUCTURE-001
      - PAYROLL-INTAKE-001
      - MAIL-INBOX-001
    reason: >-
      Die eingebetteten Noto-Schriften für Rechnungs-, Lohn-, Mandanten-,
      Mandatsstruktur-, Offboarding- und Subsumtions-PDFs liegen nicht mehr unter
      apps/web/public, sondern unter apps/web/assets/fonts/noto, und sind damit ohne
      Sitzung nicht mehr abrufbar. pdf-fonts.ts liest sie dort und prüft weiter die
      SHA-256-Werte aus manifest.json; eine übrig gebliebene Kopie unter public
      wird nicht verwendet. next.config.mjs nimmt das Verzeichnis für alle Routen
      ins Standalone-Paket auf, Prüfskript und Web-Image sichern Vorhandensein und
      Prüfsummen. Schriftdateien, Zeichenabdeckung und erzeugte PDFs bleiben
      unverändert. Keine fachliche Freigabe.
    tests:
      - apps/web/src/server/documents/__tests__/pdf-font-location.test.ts
      - apps/web/src/server/documents/__tests__/pdf-fonts.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261005-031
    date: '2026-10-05'
    paths:
      - apps/web/src/app/api/staff/mailbox/oauth/route.ts
      - apps/web/src/app/staff/(protected)/mailbox/actions.ts
      - apps/web/src/server/settings/quantenlos.ts
      - packages/mail/src/imap.ts
      - packages/mail/src/smtp-settings.ts
    rule_ids:
      - MAIL-INBOX-001
      - AUDIT-HASH-CHAIN-001
    reason: >-
      Neue Secret-Box-Werte (SMTP-Passwort, Quantenlos-Token, n8n-Schlüssel,
      Postfach-Secret und Token-Cache, OAuth-State) werden als v3 mit Schlüssel-ID
      geschrieben und per AAD an Kanzlei, Ablageort und Feld gebunden; ein in der
      Datenbank kopierter Wert lässt sich nicht mehr entschlüsseln. Der optionale
      Schlüsselbund SECRET_BOX_KEYRING erlaubt eine Rotation ohne Ausfall; v1/v2
      bleiben lesbar. Der MAC-Schlüssel der Audit-Checkpoints leitet sich weiter
      allein aus SECRET_BOX_KEY bzw. AUTH_SECRET ab, bestehende Checkpoints bleiben
      gültig. Das Kommando secret-box:rewrap verschlüsselt Bestandswerte ohne
      Klartextänderung neu. Postfachabruf, SMTP-Versand und Audit-Kette bleiben
      fachlich unverändert. Keine fachliche Freigabe.
    tests:
      - packages/crypto/src/__tests__/secret-box.test.ts
      - packages/crypto/src/__tests__/secret-slots.test.ts
      - packages/crypto/src/__tests__/audit-checkpoint-key.test.ts
      - packages/db/src/__tests__/secret-box-rewrap.test.ts
      - packages/mail/src/__tests__/imap.test.ts
      - packages/mail/src/__tests__/microsoft-cache.test.ts
      - apps/web/src/server/mailbox/__tests__/import.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261005-030
    date: '2026-10-05'
    paths:
      - apps/web/src/app/api/staff/documents/[id]/new-version/commit/route.ts
      - apps/web/src/app/api/staff/documents/commit/__tests__/route-toctou.test.ts
      - apps/web/src/app/api/staff/documents/commit/route.ts
      - apps/web/src/app/gwg-onboarding/__tests__/actions-expiry.test.ts
      - apps/web/src/app/gwg-onboarding/__tests__/bound-draft-submit.test.ts
      - apps/web/src/app/gwg-onboarding/actions.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/__tests__/actions.test.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/id-document-actions.ts
      - apps/web/src/server/documents/upload-helpers.ts
      - apps/web/src/server/gwg-onboarding/__tests__/identity-persistence.test.ts
      - apps/web/src/server/gwg-onboarding/identity-persistence.ts
      - apps/web/src/server/gwg-onboarding/submission-transaction.ts
      - apps/web/src/server/gwg/__tests__/identity-pdf-pages.test.ts
      - apps/web/src/server/gwg/__tests__/identity-source.test.ts
      - apps/web/src/server/gwg/identity-pdf-pages.ts
      - apps/web/src/server/gwg/identity-source.ts
      - packages/db/prisma/migrations/20261005140000_document_version_pdf_page_count/migration.sql
      - packages/db/prisma/schema.prisma
    rule_ids:
      - GWG-IDENTIFICATION-EVIDENCE-001
      - GWG-SELF-ONBOARDING-001
      - GWG-OCR-ASSIST-001
      - GWG-PERSON-LINKS-001
      - DOC-UPLOAD-JOURNAL-001
      - DOC-VERSION-IMMUTABILITY-001
      - DOC-OBJECT-LOCK-001
    reason: >-
      Die Seitenzahl einer PDF-Ausweisquelle wird beim Upload (Staff-Upload, neue
      Version, Onboarding) einmalig aus genau diesen Bytes im begrenzten
      Worker-Thread gezählt und in der neuen, nullbaren Spalte
      document_version.pdf_page_count gespeichert (Migration 20261005140000, CHECK
      >= 0, kein Backfill). Die Prüfung der Ausweisausschnitte unter Lifecycle-Lock
      liest keine Originalbytes mehr; Altbestand ohne Wert wird vor der Transaktion
      gezählt und nur für dieselbe Version-ID und denselben SHA-256 akzeptiert.
      Speicherfehler, Hash-Abweichungen und unlesbare PDFs führen an derselben
      Stelle zur selben Ablehnung; eine PDF jenseits der Worker-Grenzen gilt als
      unlesbar. Trigger und Unveränderlichkeitsschutz von document_version bleiben
      unverändert. Keine fachliche Freigabe.
    tests:
      - apps/web/src/server/gwg/__tests__/identity-pdf-pages.test.ts
      - apps/web/src/server/gwg/__tests__/identity-source.test.ts
      - apps/web/src/server/gwg-onboarding/__tests__/identity-persistence.test.ts
      - apps/web/src/app/gwg-onboarding/__tests__/bound-draft-submit.test.ts
      - packages/db/src/__tests__/document-version-pdf-page-count.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261005-029
    date: '2026-10-05'
    paths:
      - apps/web/next.config.mjs
      - apps/web/scripts/verify-standalone-trace.mjs
      - apps/web/src/server/risk/__tests__/extract-text-limits.test.ts
      - apps/web/src/server/risk/__tests__/extract-text.test.ts
      - apps/web/src/server/risk/extract-text.ts
      - packages/mail/src/attachments.ts
    rule_ids:
      - MAIL-INBOX-001
      - RISK-AI-SUGGESTION-001
      - RISK-ARCHIVE-SNAPSHOT-001
    reason: >-
      Der PDF-Vorabcheck für Mail-Anhänge lagert seinen begrenzten Worker-Thread
      unverändert nach @taxtronik/mail/bounded-worker aus; dieselbe Begrenzung
      (30 s, 256 MB Heap, 512 MiB RSS) liest jetzt auch PDF- und DOCX-Texte für die
      Subsumtionsakte außerhalb des Web-Event-Loops. Unlesbare Dateien enden mit
      einer allgemeinen Meldung statt den Prozess zu blockieren. next.config.mjs
      und der Standalone-Prüfer nehmen die Parser-Pakete samt Abhängigkeiten in
      die Produktionsausgabe auf. Annahme- und Ablehnungsregeln für Anhänge,
      extrahierter Text und Analyseablauf bleiben unverändert. Keine fachliche
      Freigabe.
    tests:
      - apps/web/src/server/risk/__tests__/extract-text-limits.test.ts
      - apps/web/src/server/risk/__tests__/extract-text.test.ts
      - apps/web/src/server/util/__tests__/worker-parser.test.ts
      - packages/mail/src/__tests__/attachment-resource-limits.test.ts
      - packages/mail/src/__tests__/attachments.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261005-028
    date: '2026-10-05'
    paths:
      - apps/web/src/server/dsgvo/__tests__/client-retention.test.ts
      - apps/web/src/server/dsgvo/client-retention.ts
      - apps/web/src/server/gwg/retention.ts
      - apps/web/src/server/update/manifest.ts
    rule_ids:
      - ASSURANCE-RELEASE-EVIDENCE-001
      - CLIENT-MANDATE-LIFECYCLE-001
      - DSGVO-MANDATE-ANONYMIZATION-001
      - GWG-RETENTION-DESTRUCTION-001
      - POA-SIGNER-RETENTION-001
      - RISK-ARCHIVE-SNAPSHOT-001
    reason: >-
      Die Admin-Übersicht ruft den Update-Server nicht mehr bei jedem Aufruf ab;
      die unveränderte Prüfung des signierten Manifests (Signatur, striktes Schema,
      Größen- und Zeitgrenzen) wandert nach @taxtronik/config und läuft als
      Hintergrundjob alle sechs Stunden, die Seite liest das gespeicherte Ergebnis.
      Die Kacheln zählen löschreife GwG-Belege und fällige Anonymisierungen per
      COUNT. Der Anonymisierungsfilter ist genau isClientAnonymizationDue, der
      GwG-Filter bildet Fristbeginn und Löschfrist von findDueGwgDeletionDocs nach;
      ein PostgreSQL-Test prüft die Gleichheit zu fünf Stichtagen. Fristlogik,
      Review-Queues und Löschentscheidungen bleiben unverändert. Keine fachliche
      Freigabe.
    tests:
      - apps/worker/src/jobs/__tests__/update-check.test.ts
      - packages/config/src/__tests__/update-check-result.test.ts
      - packages/db/src/__tests__/gwg-retention-count.test.ts
      - apps/web/src/server/dsgvo/__tests__/client-retention.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261005-027
    date: '2026-10-05'
    paths:
      - .forgejo/workflows/ci.yml
      - apps/web/src/app/staff/(protected)/year-end/actions.ts
      - apps/web/src/app/staff/(protected)/year-end/page.tsx
    rule_ids:
      - YEAR-END-CAMPAIGN-001
      - ASSURANCE-RELEASE-EVIDENCE-001
    reason: >-
      Die Jahreswechsel-Übersicht blättert Kampagnen (5 je Seite) und Einträge
      (50 je Seite), ermittelt die Statusverteilung per groupBy und ersetzt
      find()-Schleifen durch Maps; Einreichungen und Anforderungen werden nur für
      angezeigte Einträge geladen. Der Rollout lädt Daten vorab und legt
      Einreichungen, Anforderungen und Zuordnungen gesammelt per createMany an; die
      Berechtigungsprüfung je Mandant und die Grenze von 200 Mandanten je Rollout
      bleiben. Ein opt-in Datenbanktest läuft im DB-CI-Job. Kampagnenlogik und
      Ergebnis je Mandant bleiben unverändert. Keine fachliche Freigabe.
    tests:
      - apps/web/src/server/workflows/__tests__/year-end-rollout.test.ts
      - apps/web/src/server/workflows/__tests__/year-end-db.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261005-026
    date: '2026-10-05'
    paths:
      - apps/web/src/app/staff/(protected)/clients/[id]/tax-schedule/__tests__/actions.test.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/tax-schedule/actions.ts
      - packages/tax/src/__tests__/materialize.test.ts
      - packages/tax/src/materialize.ts
    rule_ids:
      - TAX-DEADLINE-AUTOREQUEST-001
      - TAX-DEADLINE-WORKDAY-001
    reason: >-
      Beim Speichern eines Steuertermin-Zeitplans materialisiert die
      Web-Transaktion nur noch die Termine dieses Mandanten statt aller Termine der
      Kanzlei unter einem kanzleiweiten Lock; MaterializeParams erhält dafür eine
      optionale clientId. Vorwarnung und automatische Anforderung erstellt der
      sofort angestoßene Hintergrundlauf, nicht mehr der Speichervorgang selbst.
      Ein Datenbanktest belegt für den Mandanten dieselben Termine wie der
      kanzleiweite Lauf und unveränderte andere Mandanten. Fristberechnung,
      Werktagsregeln und Anforderungsentscheidungen bleiben unverändert. Keine
      fachliche Freigabe.
    tests:
      - packages/tax/src/__tests__/materialize.test.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/tax-schedule/__tests__/actions.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261005-025
    date: '2026-10-05'
    paths:
      - apps/web/src/app/portal/(protected)/interactions/actions.ts
      - apps/web/src/app/portal/(protected)/layout.tsx
      - apps/web/src/app/staff/(protected)/admin/settings/branding-actions.ts
      - apps/web/src/app/staff/(protected)/interactions/actions.ts
      - apps/web/src/app/staff/(protected)/knowledge/context/actions.ts
      - apps/web/src/app/staff/(protected)/stbvv/actions.ts
      - apps/web/src/app/staff/(protected)/year-end/actions.ts
      - apps/web/src/server/auth/portal-profiles.ts
      - apps/web/src/server/settings/branding.ts
      - apps/web/src/server/settings/legal.ts
      - apps/web/src/server/settings/modules.ts
      - apps/web/src/server/settings/portal-features.ts
      - apps/web/src/server/settings/smtp.ts
      - apps/web/src/server/settings/tax-region.ts
      - apps/web/src/server/settings/tenant-settings.ts
      - packages/mail/src/index.ts
      - packages/mail/src/smtp-settings.ts
    rule_ids:
      - ACCESS-TENANT-RLS-001
      - AUDIT-HASH-CHAIN-001
      - CLIENT-FEEDBACK-001
      - CLIENT-MANDATE-LIFECYCLE-001
      - KNOWLEDGE-CONTEXT-001
      - PORTAL-INBOX-SUBMISSION-001
      - STBVV-CALCULATION-001
      - TAX-DEADLINE-AUTOREQUEST-001
      - TAX-DEADLINE-WORKDAY-001
      - TAX-NOTICE-DECISION-001
      - WORKFLOW-LIFECYCLE-001
      - YEAR-END-CAMPAIGN-001
    reason: >-
      Staff- und Portal-Layout laden ihre Einstellungen (Branding, Module,
      Portal-Funktionen, Darstellung) mit Glocke beziehungsweise Mandantenprofil in
      einer Transaktion und je Request gecacht; nur das Branding wird prozessweit
      60 Sekunden gecacht und beim Schreiben geleert. getSetupStatus läuft in einer
      Transaktion; Modulprüfungen innerhalb laufender Transaktionen nutzen die
      Tx-Variante statt einer zweiten Verbindung. App- und Owner-Pools werden je
      Dienst über eigene Variablen bemessen, doctor prüft die Summe gegen
      max_connections. Geprüfte Einstellungen, Modulentscheidungen und
      Zugriffsregeln bleiben unverändert. Keine fachliche Freigabe.
    tests:
      - apps/web/src/server/settings/__tests__/layout-settings.test.ts
      - apps/web/src/server/settings/__tests__/module-checks-in-transactions.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261005-024
    date: '2026-10-05'
    paths:
      - apps/web/src/app/staff/(protected)/clients/[id]/reminders/actions.ts
      - apps/worker/src/jobs/reminder-done-notify.ts
    rule_ids:
      - REMINDER-TICKET-001
    reason: >-
      Der verzögerte Auftrag „Wiedervorlage erledigt“ trägt in Redis nur noch
      Tenant, Wiedervorlage und Mitarbeitenden; Betreff und Name lädt der Worker aus
      der Datenbank. Erledigte Aufträge werden nach 24 Stunden, fehlgeschlagene
      nach 7 Tagen entfernt, Altaufträge beim Worker-Start bereinigt und im alten
      Format weiterhin verarbeitet. Empfänger, Zeitpunkt und Inhalt der
      Benachrichtigung bleiben unverändert. Keine fachliche Freigabe.
    tests:
      - apps/worker/src/jobs/__tests__/reminder-done-notify.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261005-023
    date: '2026-10-05'
    paths:
      - apps/worker/src/jobs/audit-rotate.ts
      - apps/worker/src/jobs/gwg-expiry-check.ts
      - apps/worker/src/jobs/poa-expiry-check.ts
      - apps/worker/src/jobs/reminders-daily.ts
    rule_ids:
      - AUDIT-ARCHIVE-001
      - GWG-REVERIFICATION-VALIDITY-001
      - POA-LIFECYCLE-001
      - TAX-NOTICE-APPEAL-001
      - REMINDER-TICKET-001
    reason: >-
      Fünf Worker-Jobs registrieren ihren eigenen failed-Handler nicht mehr
      zusätzlich zur Worker-Fabrik, sodass Job-Fehler nicht doppelt im Log stehen.
      Die Web-Hilfen für Steuertermin-Materialisierung und erledigte
      Wiedervorlagen protokollieren fehlgeschlagene Entfernungen eingeplanter
      Aufträge, statt sie zu verschlucken. Joblogik, Zeitpläne und Ergebnisse
      bleiben unverändert. Keine fachliche Freigabe.
    tests:
      - apps/worker/src/__tests__/worker-registry.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261005-022
    date: '2026-10-05'
    paths:
      - apps/worker/src/jobs/audit-verify-check.ts
      - apps/worker/src/jobs/backup-drill.ts
      - apps/worker/src/jobs/gwg-expiry-check.ts
      - apps/worker/src/jobs/invoice-overdue-check.ts
      - apps/worker/src/jobs/poa-expiry-check.ts
      - apps/worker/src/jobs/reminder-done-notify.ts
      - apps/worker/src/jobs/reminders-daily.ts
      - apps/worker/src/jobs/sanctions-refresh.ts
      - apps/worker/src/jobs/tax-deadline-materialize.ts
      - packages/db/src/notification.ts
    rule_ids:
      - ACCESS-NOTIFICATION-RECIPIENT-001
      - AUDIT-VERIFY-ALERT-001
      - BACKUP-DRILL-INTEGRITY-001
      - GWG-RETENTION-DESTRUCTION-001
      - GWG-REVERIFICATION-VALIDITY-001
      - GWG-SCREENING-001
      - INV-DUE-OVERDUE-001
      - POA-LIFECYCLE-001
      - REMINDER-TICKET-001
      - TAX-CONTROL-STATUS-001
      - TAX-DEADLINE-AUTOREQUEST-001
      - TAX-NOTICE-APPEAL-001
    reason: >-
      Alle Worker-Benachrichtigungen laufen über eine gemeinsame, batchfähige
      notify-Funktion auf Basis von upsertNotificationTx mit Textbereinigung, auch
      die RSS-Titel externer Feeds; Empfänger und Deduplizierung je Tag bleiben.
      Konflikte mit dem Tages-Deduplizierungsindex brechen die Transaktion nicht
      mehr ab. Eine Kettenbruch-Warnung zu einer neuen Bruchstelle wird als eigene
      Meldung geführt, weil die bisherige Aktualisierung der offenen Meldung am
      Scope-Trigger scheiterte und den Prüflauf abbrach. Empfängerregeln,
      Benachrichtigungsarten und Inhalte bleiben unverändert. Keine fachliche
      Freigabe.
    tests:
      - packages/db/src/__tests__/notification-batch.test.ts
      - apps/worker/src/__tests__/notify.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261005-021
    date: '2026-10-05'
    paths:
      - apps/worker/src/jobs/audit-rotate.ts
      - apps/worker/src/jobs/storage-orphan-cleanup.ts
    rule_ids:
      - AUDIT-ARCHIVE-001
      - DOC-UPLOAD-JOURNAL-001
      - DOC-VERSION-IMMUTABILITY-001
      - DSGVO-OPERATIONAL-RETENTION-001
    reason: >-
      audit-rotate archiviert je Lauf aufeinanderfolgende Segmente und
      storage-orphan-cleanup arbeitet Stapel ab, bis nichts mehr fällig ist oder ein
      Zeitbudget von etwa zehn Minuten erreicht ist (beim Herunterfahren des Workers
      früher); bisher galten feste Mengen von 5.000 Einträgen pro Woche
      beziehungsweise 400 Objekten pro Tag. Beide Jobs melden den verbleibenden
      Rückstand, den die Jobübersicht anzeigt. Auswahl, Prüfungen vor Archivierung
      und Löschung, Segmentinhalt und Aufbewahrungsregeln bleiben unverändert.
      Keine fachliche Freigabe.
    tests:
      - apps/worker/src/jobs/__tests__/audit-rotate.test.ts
      - apps/worker/src/jobs/__tests__/storage-orphan-cleanup.test.ts
      - apps/worker/src/__tests__/run-budget.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261005-020
    date: '2026-10-05'
    paths:
      - apps/worker/src/jobs/sanctions-refresh.ts
      - packages/tax/src/screening/core.ts
      - packages/tax/src/screening/persistence.ts
      - packages/tax/src/screening/prepared.test.ts
    rule_ids:
      - GWG-SCREENING-001
    reason: >-
      Der EU-Sanktionsabgleich bereitet die Aliasliste einmal je Lauf vor
      (normalisierte Namen und Bigramm-Mengen); ein Test belegt für 501 Einträge
      und 302 Prüfsubjekte identische Treffer, Bewertungen und Kürzungen wie der
      bisherige Algorithmus. Folgeläufe entstehen weiterhin idempotent je neuer
      Quellversion, aber nur noch für Läufe ohne Folgelauf zur aktuellen Version.
      Interne Hinweise gehen bei Namenstreffern wie bisher je Mandant an die Admins,
      ohne Treffer höchstens als ein Sammelhinweis je Kanzlei und Lauf statt je
      Mandant. Fehler beim Listenabruf werden protokolliert. Trefferlogik,
      Schwellen, Freigabesperren und Audit bleiben unverändert. Keine fachliche
      Freigabe; Wortlaut und Empfänger des Sammelhinweises sind fachlich zu
      bestätigen.
    tests:
      - packages/tax/src/screening/prepared.test.ts
      - apps/worker/src/jobs/__tests__/sanctions-refresh.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261005-019
    date: '2026-10-05'
    paths:
      - .forgejo/workflows/ci.yml
      - apps/worker/src/jobs/reminders-daily.ts
      - packages/db/src/staff-client-access.ts
    rule_ids:
      - TAX-NOTICE-APPEAL-001
      - TAX-CONTROL-STATUS-001
      - ACCESS-NOTIFICATION-RECIPIENT-001
      - ACCESS-CLIENT-MODE-001
      - REMINDER-TICKET-001
      - ASSURANCE-RELEASE-EVIDENCE-001
    reason: >-
      Die tägliche Erinnerungsrunde verarbeitet je Kanzlei Abschnitte von 200
      Mandanten in eigenen kurzen Transaktionen und prüft den Mandantenzugriff der
      Empfänger mit der neuen Batch-Variante filterStaffAccessClientsTx, die Policy
      und Rollen einmal liest; ein Datenbanktest belegt paarweise Gleichheit mit
      der Einzelprüfung und dieselben Benachrichtigungen wie der bisherige Lauf.
      Der DB-CI-Job führt die neuen Worker-DB-Tests aus. Fälligkeiten, Empfänger
      und Benachrichtigungsinhalte bleiben unverändert. Keine fachliche Freigabe.
    tests:
      - packages/db/src/__tests__/staff-client-access-batch.test.ts
      - apps/worker/src/jobs/__tests__/reminders-daily-db.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261005-018
    date: '2026-10-05'
    paths:
      - apps/worker/src/jobs/audit-anchor.ts
      - apps/worker/src/jobs/audit-rotate.ts
      - apps/worker/src/jobs/audit-verify-check.ts
      - apps/worker/src/jobs/backup-drill.ts
      - apps/worker/src/jobs/evidence-seal.ts
      - packages/db/prisma/migrations/20261005110100_audit_archive_tsa_status/migration.sql
      - packages/db/prisma/schema.prisma
      - packages/evidence/src/cli/verify.ts
    rule_ids:
      - AUDIT-ARCHIVE-001
      - AUDIT-RFC3161-ANCHOR-001
      - AUDIT-VERIFY-ALERT-001
      - BACKUP-DRILL-INTEGRITY-001
      - AUDIT-HASH-CHAIN-001
    reason: >-
      Alle Worker-Pfade wählen die Zeitstempelstelle über eine gemeinsame Funktion
      resolveTsa(tenantId, 'stamp' | 'verify') in derselben Reihenfolge (Kanzlei,
      TIMESTAMP_AUTHORITY_URL, Standard-TSA); die Prüfung vorhandener Tokens braucht
      in Produktion kein Netz. Scheitert beim Archivieren der RFC-3161-Stempel,
      wird das Segment wie bisher ohne Token archiviert, jetzt aber als PENDING
      geführt und von einem späteren Lauf nach Prüfung von Größe, SHA-256 und Kette
      des gesperrten Objekts nachgestempelt (STAMPED_LATE). Der Update-Trigger
      erlaubt ausschließlich diesen einmaligen Übergang und nur für die Token-
      Felder; Segmentgrenzen, Kettenanker, Datei-Hash und Speicherort bleiben
      unveränderlich. Keine fachliche Freigabe; die Prüffrage zur Nachholung bleibt
      offen.
    tests:
      - packages/db/src/__tests__/audit-archive-tsa-status.test.ts
      - apps/worker/src/__tests__/tsa-port.test.ts
      - apps/worker/src/jobs/__tests__/audit-rotate.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261005-017
    date: '2026-10-05'
    paths:
      - .forgejo/workflows/ci.yml
      - packages/db/prisma/migrations/20261005110000_workflow_n8n_dispatch_settlement/migration.sql
      - packages/db/prisma/schema.prisma
    rule_ids:
      - WORKFLOW-LIFECYCLE-001
      - ASSURANCE-RELEASE-EVIDENCE-001
      - ACCESS-TENANT-RLS-001
    reason: >-
      Workflow-Übergaben an n8n, die nicht abonniert sind, bei abgeschaltetem n8n
      anfallen oder keine aktive Route haben (SKIPPED, UNROUTED, INVALID_EVENT),
      werden mit settled_status und settled_at abschließend verbucht statt
      minütlich erneut geholt; UNROUTED öffnet erst ein Admin-Replay wieder.
      Echte Schreibfehler werden mit Backoff von einer Minute bis einer Stunde
      wiederholt und auch bei vielen verbuchten Einträgen nachgezogen. Der
      DB-CI-Job führt die neuen Worker-DB-Tests aus. Workflow-Status und
      Ereignisinhalte bleiben unverändert. Keine fachliche Freigabe.
    tests:
      - apps/worker/src/jobs/__tests__/workflow-n8n-dispatch.test.ts
      - apps/worker/src/jobs/__tests__/workflow-n8n-dispatch-db.test.ts
      - apps/worker/src/__tests__/worker-db-ci.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261005-016
    date: '2026-10-05'
    paths:
      - apps/worker/src/jobs/gwg-expiry-check.ts
      - apps/worker/src/jobs/poa-expiry-check.ts
    rule_ids:
      - GWG-REVERIFICATION-VALIDITY-001
      - GWG-RETENTION-DESTRUCTION-001
      - POA-LIFECYCLE-001
      - ACCESS-NOTIFICATION-RECIPIENT-001
    reason: >-
      GwG- und Vollmachts-Ablaufwarnungen gehen nur noch an zuständige
      Mitarbeitende, die aktiv sind und den Mandanten nach der bestehenden
      Zugriffsregel sehen dürfen; bleibt niemand übrig, an aktive ADMIN/PARTNER mit
      Zugriff. Bisher erhielten deaktivierte oder nicht mehr berechtigte Zuständige
      die Warnung, und der Admin-Fallback griff nur ohne jede Zuständigkeit.
      Fristen, Stufen und Inhalte der Warnungen bleiben unverändert. Keine
      fachliche Freigabe.
    tests:
      - apps/worker/src/__tests__/notification-recipients.test.ts
      - apps/worker/src/jobs/__tests__/gwg-expiry-check.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261005-015
    date: '2026-10-05'
    paths:
      - apps/web/src/server/auth/portal.ts
      - apps/web/src/server/auth/staff.ts
    rule_ids:
      - ACCESS-TENANT-RLS-001
      - CLIENT-MANDATE-LIFECYCLE-001
    reason: >-
      Sitzungen im Kanzlei- und Mandantenportal enden spätestens 24 Stunden nach
      der ursprünglichen, signierten Anmeldezeit. Die Session-Fabrik begrenzt jede
      Erneuerung, Profilwechsel und direkte Ausstellung auf diese Grenze und weist
      ältere Tokens ab; Cookies ohne Anmeldezeit werden nie verlängert. Bisher
      verlängerte jeder Aufruf des Auth.js-Session-Endpunkts eine Sitzung um volle
      24 Stunden. Widerrufs-, Revisions- und Mandatsprüfungen bleiben unverändert.
      Keine fachliche Freigabe.
    tests:
      - apps/web/src/server/auth/__tests__/session-renewal.test.ts
      - apps/web/src/server/auth/__tests__/session-factory.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261005-014
    date: '2026-10-05'
    paths:
      - apps/web/src/app/staff/(auth)/login/actions.ts
      - apps/web/src/app/staff/(auth)/login/page.tsx
      - apps/web/src/app/staff/(auth)/login/password/route.ts
      - apps/web/src/server/auth/staff.ts
    rule_ids:
      - ACCESS-TENANT-RLS-001
    reason: >-
      Die Mitarbeiteranmeldung prüft das Passwort nur noch einmal im neuen
      Staff-Login-Service. Der zweite Schritt (TOTP, Recovery-Code,
      TOTP-Ersteinrichtung) löst statt einer erneuten Passwortprüfung ein fünf
      Minuten gültiges Einmal-Ticket ein, das an Zweck, Konto, Tenant,
      Auth-Revision und Passwort-Hash gebunden ist und in Redis nur als Hash liegt;
      ohne Redis schlägt die Anmeldung geschlossen fehl. Passwort-, TOTP-, Replay-
      und Backup-Code-Prüfungen, Limits, Sperrlogik und Audit-Ereignisse bleiben
      unverändert. Keine fachliche Freigabe.
    tests:
      - apps/web/src/server/auth/__tests__/staff-login-ticket.test.ts
      - apps/web/src/app/staff/(auth)/login/__tests__/totp-enrollment.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261005-013
    date: '2026-10-05'
    paths:
      - apps/web/src/app/staff/(auth)/login/actions.ts
      - apps/web/src/server/auth/staff.ts
      - apps/web/src/server/rate-limit/index.ts
    rule_ids:
      - ACCESS-TENANT-RLS-001
    reason: >-
      Die Mitarbeiteranmeldung antwortet für unbekannte Kanzlei, unbekanntes,
      deaktiviertes, gesperrtes oder auf Hardware-Schlüssel umgestelltes Konto und
      falsches Passwort mit derselben Meldung und führt in jedem Fall genau einen
      bcrypt-Vergleich aus, bei nicht zulässigen Konten gegen einen festen
      Dummy-Hash gleicher Kosten. Konto- und E-Mail-gebundene Limits sowie die
      Sperrlogik bleiben unverändert. Keine fachliche Freigabe.
    tests:
      - apps/web/src/server/auth/__tests__/staff-login-enumeration.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261005-012
    date: '2026-10-05'
    paths:
      - apps/web/src/app/api/portal/logout/route.ts
      - apps/web/src/app/staff/(auth)/login/password/route.ts
      - apps/web/src/server/auth/portal-session.ts
      - apps/web/src/server/auth/portal.ts
      - apps/web/src/server/auth/staff.ts
    rule_ids:
      - ACCESS-TENANT-RLS-001
      - CLIENT-MANDATE-LIFECYCLE-001
    reason: >-
      Session-Cookies von Kanzlei und Mandantenportal werden nur noch über eine
      Session-Fabrik je Oberfläche gelesen, ausgestellt und gelöscht; Auth.js
      erhält Sitzungseinstellungen, JWT-Codec und Cookie-Namen aus dieser Fabrik. In
      Produktion akzeptiert der Server ausschließlich den konfigurierten
      __Host-/__Secure-Namen. Der ungenutzte Portal-Credentials-Provider entfällt,
      der über /api/auth/portal/callback/credentials einen zweiten, öffentlich
      erreichbaren Anmeldeweg bot und einen Magic-Link verbrauchen konnte; der
      Magic-Link-Ablauf bleibt unverändert. Die wirkungslose Angabe updateAge
      entfällt. Widerrufs-, Revisions- und Mandatsprüfungen bleiben unverändert.
      Keine fachliche Freigabe.
    tests:
      - apps/web/src/server/auth/__tests__/session-factory.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261005-011
    date: '2026-10-05'
    paths:
      - apps/web/src/app/gwg-onboarding/__tests__/actions-expiry.test.ts
      - apps/web/src/app/gwg-onboarding/__tests__/bound-draft-submit.test.ts
      - apps/web/src/app/gwg-onboarding/__tests__/identity-source.test.ts
      - apps/web/src/app/gwg-onboarding/actions.ts
      - apps/web/src/server/gwg-onboarding/__tests__/invite-uploads.test.ts
      - apps/web/src/server/gwg-onboarding/__tests__/submission-validation.test.ts
      - apps/web/src/server/gwg-onboarding/invite-uploads.ts
      - apps/web/src/server/gwg-onboarding/submission-validation.ts
      - packages/db/prisma/migrations/20261005100700_gwg_invite_uploads_by_fk/migration.sql
      - packages/db/prisma/schema.prisma
    rule_ids:
      - GWG-SELF-ONBOARDING-001
      - GWG-IDENTIFICATION-EVIDENCE-001
      - GWG-OCR-ASSIST-001
      - DOC-UPLOAD-JOURNAL-001
      - ACCESS-TENANT-RLS-001
    reason: >-
      Alle Lesepfade des GwG-Onboardings ordnen Uploads der Einladung über den
      Fremdschlüssel document.gwg_onboarding_invite_id zu, beschränkt auf Dokumente
      mit sauberer Version; für offene Einladungen ist das genau die bisherige
      Menge. Die Verwerfen-Funktion prüft nicht mehr das JSON-Array; Attribute,
      Rechte und Meldungen bleiben. Das Array uploaded_document_ids wird nach dem
      Expand/Contract-Verfahren für Rollbacks weiter gepflegt, aber nicht mehr
      gelesen. Die Onboarding-Übersicht der Kanzlei zeigt einzeln vernichtete
      Belege nicht mehr an. Zulässige Uploads und Verwerfen-Regeln des anonymen
      Ablaufs bleiben unverändert. Keine fachliche Freigabe.
    tests:
      - apps/web/src/server/gwg-onboarding/__tests__/invite-uploads.test.ts
      - packages/db/src/__tests__/gwg-onboarding-document-discard.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261005-010
    date: '2026-10-05'
    paths:
      - packages/db/prisma/migrations/20261005100600_status_text_checks/migration.sql
      - packages/db/prisma/schema.prisma
    rule_ids:
      - MAIL-INBOX-001
      - BWA-PROJECTION-001
    reason: >-
      inbound_message.status und bwa_plan.status erhalten CHECK-Constraints mit
      genau den Werten, die der Code schreibt (PENDING, BLOCKED, COMPLETE
      beziehungsweise DRAFT, FINAL). Eine vorgeschaltete Datenprüfung bricht die
      Migration bei abweichendem Bestand mit Werten und Anzahl ab. Schreibpfade,
      Statusübergänge und Regeln bleiben unverändert. Keine fachliche Freigabe.
    tests:
      - packages/db/src/__tests__/status-text-checks.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261005-009
    date: '2026-10-05'
    paths:
      - packages/db/prisma/migrations/20261005100500_drop_redundant_indexes/migration.sql
      - packages/db/prisma/schema.prisma
    rule_ids:
      - AUDIT-HASH-CHAIN-001
      - TAX-CONTROL-STATUS-001
      - DOC-VERSION-IMMUTABILITY-001
    reason: >-
      Die Migration entfernt 18 B-Tree-Indizes, die jeweils vollständig durch einen
      anderen Index mit denselben führenden Spalten gedeckt sind, darunter
      document_version_document_id_idx und audit_seal_tenant_id_seal_date_idx.
      Alle Unique-Constraints bleiben; der redundante, aber von der
      GwG-Invariante 043 verlangte Index gwg_representative_gwg_check_id_idx bleibt.
      Abfragen nutzen die deckenden Indizes; Daten, Regeln und Zugriffe bleiben
      unverändert. Keine fachliche Freigabe.
    tests:
      - packages/db/src/__tests__/redundant-indexes.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261005-008
    date: '2026-10-05'
    paths:
      - .forgejo/workflows/ci.yml
      - packages/db/prisma/migrations/20261005100400_fk_indexes_followup/migration.sql
      - packages/db/prisma/schema.prisma
    rule_ids:
      - ASSURANCE-RELEASE-EVIDENCE-001
      - INV-STORNO-REFERENCE-001
      - INV-TIME-ENTRY-CLAIM-001
      - WORKFLOW-DEPENDENCY-001
      - TAX-NOTICE-APPEAL-001
    reason: >-
      Neue Indizes auf time_entry.invoice_id, workflow_dependency.successor_item_id
      und tax_notice.filing_id beschleunigen Fremdschlüsselprüfungen bei Storno und
      Löschung sowie Workflow-Bereitschaft und Bescheidzuordnung. Die neue
      CI-Prüfung verify:fk-indexes läuft im db-Job direkt nach verify:rls und meldet
      Fremdschlüssel ohne führenden Index mit begründeter Allowlist. Bestehende
      Gates, Regeln und Datenzugriffe bleiben unverändert. Keine fachliche Freigabe.
    tests:
      - packages/db/src/__tests__/fk-index-gate.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261005-007
    date: '2026-10-05'
    paths:
      - packages/db/prisma/migrations/20261005100300_rls_policies_current_tenant_helper/migration.sql
    rule_ids:
      - ACCESS-TENANT-RLS-001
    reason: >-
      Sechs RLS-Policies lesen den Tenant-Kontext über app.current_tenant_id()
      statt über current_setting(...)::uuid; Name, Befehl, Rollen und permissiver
      Modus bleiben. Ein fehlender oder geleerter Kontext auf einer wiederverwendeten
      Pool-Verbindung liefert damit keine Zeilen statt eines Cast-Fehlers. Die
      Kontextfunktionen app.current_tenant_id, current_actor_id und
      current_actor_type sind PARALLEL SAFE. Sichtbare Zeilen bei gesetztem Kontext
      bleiben identisch. Keine fachliche Freigabe.
    tests:
      - packages/db/src/__tests__/rls-current-tenant-helper.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261005-006
    date: '2026-10-05'
    paths:
      - packages/db/prisma/migrations/20261005100200_audit_log_action_actor_indexes/migration.sql
      - packages/db/prisma/schema.prisma
    rule_ids:
      - AUDIT-HASH-CHAIN-001
      - DSGVO-CONTACT-EXPORT-001
      - RISK-CATALOG-FOUR-EYES-001
      - TCMS-SAMPLE-PROOF-001
      - ACCESS-TENANT-RLS-001
    reason: >-
      Zwei neue Indizes auf audit_log, (tenant_id, action, id) und (tenant_id,
      actor_id, actor_type), beschleunigen Los-Liste, Vier-Augen-Prüfung des
      Risikokatalogs, Kategoriefilter der Audit-Seite und DSGVO-Kontaktauskunft.
      Die Reihenfolge der Akteur-Spalten folgt den unter RLS als Indexbedingung
      zulässigen LEAKPROOF-Operatoren. Hash-Kette, Inhalte und Leserechte von
      audit_log bleiben unverändert. Keine fachliche Freigabe.
    tests:
      - packages/db/src/__tests__/audit-log-reader-indexes.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261005-005
    date: '2026-10-05'
    paths:
      - apps/web/src/app/api/staff/search/route.ts
      - packages/db/prisma/migrations/20261005100100_staff_search_trigram_candidates/migration.sql
    rule_ids:
      - ACCESS-SEARCH-SCOPE-001
      - ACCESS-TENANT-RLS-001
      - ACCESS-CLIENT-MODE-001
    reason: >-
      Die globale Kanzleisuche ermittelt je Kategorie zuerst Kandidaten-IDs über
      die Trigramm-Indizes mit der SECURITY-DEFINER-Funktion
      app.staff_search_candidates, deren Tenant ausschließlich aus
      app.current_tenant_id() stammt, und lädt danach nur diese IDs unter RLS mit
      den unveränderten Zugriffsfiltern und demselben Suchfilter. Was die zweite
      Stufe nicht sieht, erscheint nicht. Bekannte Grenze: Die erste Stufe prüft nur
      den Tenant; sehr breite Suchbegriffe können bei stark eingeschränkter
      Sichtbarkeit weniger Treffer liefern, weil höchstens fünf Kandidatenblöcke
      geladen werden. Keine fachliche Freigabe.
    tests:
      - packages/db/src/__tests__/staff-search-candidates.test.ts
      - apps/web/src/server/search/__tests__/staff-candidates.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261005-004
    date: '2026-10-05'
    paths:
      - .forgejo/workflows/ci.yml
      - apps/web/src/app/api/staff/documents/__tests__/bulk-download-audit.test.ts
      - apps/web/src/app/api/staff/documents/__tests__/bulk-download-filenames.test.ts
      - apps/web/src/app/api/staff/documents/__tests__/bulk-download-readiness.test.ts
      - apps/web/src/app/api/staff/documents/__tests__/bulk-download-stream.test.ts
      - apps/web/src/app/api/staff/documents/download/route.ts
      - apps/web/src/app/api/staff/invoices/export/__tests__/module-gate.test.ts
      - apps/web/src/app/api/staff/invoices/export/route.ts
      - apps/web/src/app/api/staff/search/route.ts
      - apps/web/src/app/staff/(protected)/clients/page.tsx
      - apps/web/src/app/staff/(protected)/dashboard/actions.ts
      - apps/web/src/app/staff/(protected)/dashboard/page.tsx
      - apps/web/src/app/staff/(protected)/dashboard/widgets/my-work-basket.tsx
      - apps/web/src/app/staff/(protected)/documents/page.tsx
      - apps/web/src/app/staff/(protected)/invoices/__tests__/page.test.tsx
      - apps/web/src/app/staff/(protected)/invoices/page.tsx
      - apps/web/src/app/staff/(protected)/poa/page.tsx
      - apps/web/src/app/staff/(protected)/tax-deadlines/group/page.tsx
      - apps/web/src/app/staff/(protected)/tax-deadlines/page.tsx
      - apps/web/src/server/auth/rbac.ts
      - apps/web/src/server/dashboard/my-day.ts
      - apps/web/src/server/fristen/__tests__/kontrollbuch.test.ts
      - apps/web/src/server/fristen/kontrollbuch.ts
      - apps/web/src/server/work/basket.ts
    rule_ids:
      - ACCESS-CLIENT-MODE-001
      - ACCESS-TENANT-RLS-001
      - ACCESS-SEARCH-SCOPE-001
      - ACCESS-STAFF-PERMISSION-001
      - REMINDER-TICKET-001
      - ASSURANCE-RELEASE-EVIDENCE-001
      - AUDIT-RFC3161-ANCHOR-001
      - AUDIT-VERIFY-ALERT-001
      - DOC-UPLOAD-JOURNAL-001
      - DOC-VERSION-IMMUTABILITY-001
      - INV-DUE-OVERDUE-001
      - PORTAL-INBOX-SUBMISSION-001
      - TAX-CONTROL-STATUS-001
      - TAX-DEADLINE-AUTOREQUEST-001
    reason: >-
      Die Mandantensichtbarkeit (vertrauliche Mandanten, RESTRICTED-Modus) wird in
      Listen, Kalender, Dashboard, Arbeitskorb, Fristenkontrollbuch, Exporten,
      ZIP-Download und globaler Suche als Relationsfilter accessibleClientsWhereFor
      statt über NOT-IN-Listen aller gesperrten Mandanten-IDs geprüft; der alte
      Helfer entfällt. Ein PostgreSQL-Test belegt identische sichtbare Zeilen für
      OPEN und RESTRICTED, Admin und Mitarbeitende. Einzige beabsichtigte Änderung:
      Das Dashboard-Widget zeigt interne Wiedervorlagen ohne Mandant auch dann,
      wenn ein Mandant gesperrt ist. Der DB-CI-Job führt den neuen Test aus.
      Zugriffsentscheidungen bleiben unverändert. Keine fachliche Freigabe.
    tests:
      - apps/web/src/server/auth/__tests__/client-access-filter.test.ts
      - apps/web/src/server/auth/__tests__/client-access-filter-db.test.ts
      - apps/web/src/server/auth/__tests__/client-access-filter-ci.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261005-003
    date: '2026-10-05'
    paths:
      - apps/web/src/app/staff/(protected)/clients/[id]/workflows/actions.ts
      - apps/web/src/server/workflows/auto-resume.ts
      - packages/db/src/workflow-lifecycle.ts
    rule_ids:
      - WORKFLOW-LIFECYCLE-001
      - CLIENT-FEEDBACK-001
    reason: >-
      Pausierte Workflows mit erreichtem Pausentermin setzt ein Worker-Job alle
      fünf Minuten fort, je Instanz in einer kurzen Tenant-Transaktion mit
      demselben Compare-and-Set auf PAUSED und erreichten Termin und derselben
      Evidence mit tatsächlichem Endstatus; bisher geschah das nur beim Rendern der
      Workflow-Seite eines Mandanten. Die Seite schreibt nicht mehr und zeigt eine
      abgelaufene Pause bis zum nächsten Lauf an. Statusregeln, Pausen- und
      Abbruchschutz bleiben unverändert. Keine fachliche Freigabe.
    tests:
      - apps/worker/src/jobs/__tests__/workflow-auto-resume.test.ts
      - apps/web/src/server/workflows/__tests__/auto-resume.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261005-002
    date: '2026-10-05'
    paths:
      - apps/worker/src/jobs/risk-analyse-llm.ts
      - packages/db/src/risk-analysis.ts
    rule_ids:
      - RISK-AI-SUGGESTION-001
      - RISK-ARCHIVE-SNAPSHOT-001
    reason: >-
      Der Auftrag der KI-Subsumtion in Redis enthält nur noch Tenant, Analyse und
      den Hash des Sachverhalts; der Worker lädt den Text unter der bestehenden
      Analysesperre aus der Datenbank und arbeitet nur bei übereinstimmendem Hash.
      Erledigte Aufträge werden nach 24 Stunden, fehlgeschlagene nach 7 Tagen
      entfernt, Altaufträge beim Worker-Start bereinigt; Altaufträge mit Volltext
      werden weiterhin verarbeitet. Die drei bestehenden Aktualitätsprüfungen,
      Vorschlagslogik und Archivstand bleiben unverändert. Keine fachliche
      Freigabe.
    tests:
      - apps/worker/src/jobs/__tests__/risk-analyse-llm.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261005-001
    date: '2026-10-05'
    paths:
      - apps/web/src/app/gwg-onboarding/__tests__/bound-draft-submit.test.ts
      - apps/web/src/app/gwg-onboarding/__tests__/identity-source.test.ts
      - apps/web/src/app/gwg-onboarding/actions.ts
      - apps/web/src/app/staff/(auth)/login/actions.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/__tests__/actions.test.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/id-document-actions.ts
      - apps/web/src/server/gwg-onboarding/__tests__/identity-persistence.test.ts
      - apps/web/src/server/gwg-onboarding/identity-persistence.ts
      - apps/web/src/server/gwg/__tests__/identity-source.test.ts
      - apps/web/src/server/gwg/identity-source.ts
      - apps/worker/src/jobs/audit-anchor.ts
      - apps/worker/src/jobs/audit-rotate.ts
      - apps/worker/src/jobs/audit-verify-check.ts
      - apps/worker/src/jobs/backup-drill.ts
      - apps/worker/src/jobs/dsgvo-retention.ts
      - apps/worker/src/jobs/evidence-seal.ts
      - apps/worker/src/jobs/gwg-expiry-check.ts
      - apps/worker/src/jobs/invoice-overdue-check.ts
      - apps/worker/src/jobs/magic-link-cleanup.ts
      - apps/worker/src/jobs/n8n-retention.ts
      - apps/worker/src/jobs/poa-expiry-check.ts
      - apps/worker/src/jobs/portal-inbox-cleanup.ts
      - apps/worker/src/jobs/reminder-done-notify.ts
      - apps/worker/src/jobs/reminders-daily.ts
      - apps/worker/src/jobs/risk-analyse-llm.ts
      - apps/worker/src/jobs/storage-orphan-cleanup.ts
      - apps/worker/src/jobs/tax-deadline-materialize.ts
      - apps/worker/src/jobs/workflow-feedback.ts
      - packages/mail/src/index.ts
    rule_ids:
      - ACCESS-TENANT-RLS-001
      - GWG-IDENTIFICATION-EVIDENCE-001
      - GWG-SELF-ONBOARDING-001
      - GWG-OCR-ASSIST-001
      - DOC-UPLOAD-JOURNAL-001
      - AUDIT-HASH-CHAIN-001
      - AUDIT-ARCHIVE-001
      - AUDIT-RFC3161-ANCHOR-001
      - AUDIT-VERIFY-ALERT-001
      - BACKUP-DRILL-INTEGRITY-001
      - DSGVO-OPERATIONAL-RETENTION-001
      - TAX-DEADLINE-AUTOREQUEST-001
      - INV-DUE-OVERDUE-001
      - POA-LIFECYCLE-001
      - REMINDER-TICKET-001
      - RISK-AI-SUGGESTION-001
      - WORKFLOW-LIFECYCLE-001
      - CLIENT-FEEDBACK-001
    reason: >-
      Alle 26 Worker entstehen über eine Fabrik, die fehlgeschlagene Jobs und
      Worker-Fehler protokolliert; die Job-Dateien ändern nur den Konstruktoraufruf
      und entfernen doppelte failed-Handler. Im Web werden Fehler beim
      Fehlversuchs-Audit geloggt statt verworfen, das Sammel-Schließen von
      Anfragen schließt die übrigen und nennt nicht geschlossene mit Grund,
      Speicherfehler bei GwG-Ausweisen erscheinen als Speicherfehler statt als
      Aufforderung zur Neuerfassung, und Datenbankfehler gehen an die zentrale
      Fehlerbehandlung. Ist die Kanzlei-SMTP-Konfiguration wegen eines
      Datenbankfehlers nicht lesbar, bricht der Versand ab, statt still über den
      ENV-Server zu senden; der dokumentierte Rückfall bei fehlender Konfiguration
      bleibt. Prüfregeln, Fristen, Zustellklassifikation und Audit-Inhalte bleiben
      unverändert. Keine fachliche Freigabe.
    tests:
      - apps/worker/src/__tests__/worker-factory.test.ts
      - apps/worker/src/__tests__/worker-registry.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261004-018
    date: '2026-10-04'
    paths:
      - apps/web/src/app/staff/(protected)/mailbox/page.tsx
    rule_ids:
      - MAIL-INBOX-001
      - ACCESS-SEARCH-SCOPE-001
    reason: >-
      Der Posteingang ermittelt Zuordnungsvorschläge je Seite mit einer
      Datenbankabfrage (E-Mail-Abgleich mit derselben Zugriffs- und Aktivregel wie
      der Import) statt alle Kontakte zu laden, bietet je Anhang die serverseitige
      Mandantensuche statt einer vollständigen Auswahlliste und verlinkt importierte
      Dokumente auf die bestehende Dokumentansicht. Import, Prüfungen und Ablage
      bleiben unverändert. Keine fachliche Freigabe.
    tests:
      - apps/web/src/app/staff/(protected)/mailbox/__tests__/page.test.tsx
      - apps/web/src/server/mailbox/__tests__/suggestions.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261004-017
    date: '2026-10-04'
    paths:
      - apps/web/src/app/staff/(protected)/gwg/page.tsx
      - apps/web/src/app/staff/(protected)/interactions/page.tsx
      - apps/web/src/app/staff/(protected)/invoices/new/__tests__/page.test.tsx
      - apps/web/src/app/staff/(protected)/invoices/new/external-form.tsx
      - apps/web/src/app/staff/(protected)/invoices/new/form.tsx
      - apps/web/src/app/staff/(protected)/invoices/new/page.tsx
      - apps/web/src/app/staff/(protected)/payroll/actions.ts
      - apps/web/src/app/staff/(protected)/payroll/page.tsx
      - apps/web/src/app/staff/(protected)/poa/__tests__/client-context.test.ts
      - apps/web/src/app/staff/(protected)/poa/__tests__/client-selection.test.ts
      - apps/web/src/app/staff/(protected)/poa/actions.ts
      - apps/web/src/app/staff/(protected)/poa/new/client-selection.ts
      - apps/web/src/app/staff/(protected)/poa/new/form.tsx
      - apps/web/src/app/staff/(protected)/poa/new/page.tsx
      - apps/web/src/app/staff/(protected)/reminders/page.tsx
      - apps/web/src/app/staff/(protected)/year-end/page.tsx
      - apps/web/src/server/mandate-expansion/service.ts
    rule_ids:
      - ACCESS-CLIENT-MODE-001
      - ACCESS-SEARCH-SCOPE-001
      - CLIENT-FEEDBACK-001
      - CLIENT-MANDATE-LIFECYCLE-001
      - GWG-CONTROL-EXPORT-001
      - MANDATE-STRUCTURE-001
      - WORKFLOW-DEPENDENCY-001
      - PAYROLL-INTAKE-001
      - POA-LIFECYCLE-001
      - POA-SIGNING-CONFIRMATION-001
      - POA-SIGNING-SNAPSHOT-001
      - REMINDER-TICKET-001
      - YEAR-END-CAMPAIGN-001
    reason: >-
      Mandantenauswahlen in Terminen, Wiedervorlagen, Zeiterfassung,
      Mandanten-Assistent, Vollmacht, Rechnung, Lohn, StBVV, Jahreswechsel,
      Workflows, GwG-Kontrollliste, Interaktionen und Mandatsorganisation laden
      nicht mehr den ganzen Bestand oder die ersten 500 beziehungsweise 1.000
      Mandanten, sondern suchen serverseitig mit derselben Sichtbarkeitsregel und
      denselben Einschlussregeln (aktiv, nicht beendet, nicht anonymisiert) wie
      bisher. Spätere Mandanten sind dadurch wieder auswählbar. Vollmacht-,
      Rechnungs- und StBVV-Formulare wählen keinen Mandanten mehr still vor. Die
      Aktionen, ihre Prüfungen und fachlichen Abläufe bleiben unverändert. Keine
      fachliche Freigabe.
    tests:
      - apps/web/src/app/staff/(protected)/invoices/new/__tests__/page.test.tsx
      - apps/web/src/app/staff/(protected)/poa/__tests__/client-selection.test.ts
      - apps/web/src/app/staff/(protected)/poa/__tests__/client-context.test.ts
      - apps/web/src/server/clients/__tests__/picker.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261004-016
    date: '2026-10-04'
    paths:
      - apps/web/src/app/staff/(protected)/clients/[id]/requests/__tests__/actions.test.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/requests/actions.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/requests/new/form.tsx
      - apps/web/src/server/rate-limit/index.ts
    rule_ids:
      - REQ-LIFECYCLE-001
      - REQ-INTERNAL-COMMENT-001
      - ACCESS-TENANT-RLS-001
      - ACCESS-SEARCH-SCOPE-001
    reason: >-
      Die Mandantenauswahl der Anfrageerfassung nutzt die neue gemeinsame
      serverseitige Mandantensuche (GET /api/staff/clients/search) mit derselben
      Sichtbarkeitsregel accessibleClientsWhereFor statt der bisherigen eigenen
      Such-Action, die entfällt. Die Suche hat ein eigenes Rate-Limit je
      Mitarbeitendem. Anlage, Prüfung, Statusübergänge und Kommentare von Anfragen
      bleiben unverändert. Keine fachliche Freigabe.
    tests:
      - apps/web/src/server/clients/__tests__/picker.test.ts
      - apps/web/src/app/api/staff/clients/search/__tests__/route.test.ts
      - apps/web/src/components/ui/__tests__/client-combobox.test.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/requests/__tests__/actions.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261004-015
    date: '2026-10-04'
    paths:
      - apps/web/src/app/staff/(protected)/admin/audit/__tests__/actions-result.test.ts
      - apps/web/src/app/staff/(protected)/admin/audit/__tests__/page.test.tsx
      - apps/web/src/app/staff/(protected)/admin/audit/actions.ts
      - apps/web/src/app/staff/(protected)/admin/audit/audit-chain-status.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/contacts/actions.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/__tests__/actions.test.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/actions.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/privacy/__tests__/actions.test.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/privacy/actions.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/privacy/page.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/reminders/actions.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/requests/__tests__/actions.test.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/requests/actions.ts
      - apps/web/src/app/staff/(protected)/mailbox/actions.ts
      - apps/web/src/app/staff/(protected)/mailbox/page.tsx
      - apps/web/src/app/staff/(protected)/notifications/__tests__/actions.test.ts
      - apps/web/src/app/staff/(protected)/notifications/actions.ts
      - apps/web/src/app/staff/(protected)/notifications/page.tsx
      - apps/web/src/app/staff/(protected)/requests/[id]/page.tsx
      - apps/web/src/server/invoicing/__tests__/invoice-actions.test.ts
    rule_ids:
      - REQ-LIFECYCLE-001
      - REQ-INTERNAL-COMMENT-001
      - AUDIT-VERIFY-ALERT-001
      - AUDIT-HASH-CHAIN-001
      - DSGVO-CONSENT-SNAPSHOT-001
      - GWG-ACTIVATION-GATE-001
      - GWG-REPRESENTATIVE-AUTHORITY-001
      - GWG-REVERIFICATION-VALIDITY-001
      - GWG-RISK-REVIEW-001
      - GWG-SCREENING-001
      - GWG-IDENTIFICATION-EVIDENCE-001
      - GWG-OCR-ASSIST-001
      - GWG-RETENTION-DESTRUCTION-001
      - ACCESS-TENANT-RLS-001
      - ACCESS-NOTIFICATION-RECIPIENT-001
      - MAIL-INBOX-001
      - REMINDER-TICKET-001
      - KNOWLEDGE-CONTEXT-001
      - INV-LIFECYCLE-FREEZE-001
      - INV-VAT-TOTALS-001
    reason: >-
      Die übrigen Server-Actions ohne Rückkanal (Abwesenheiten, Audit und
      Archiv, Einrichtung, BWA, Kontakte, GwG-Prüfung, Einwilligungswiderruf,
      Anfragen, Wissen, Smart-Mailbox, Benachrichtigungen, Telefonnotizen,
      Zeiterfassung) geben Fehler als ActionResult an das Formular zurück;
      bisher verworfene Ergebnisse von withStaff und den Action-Guards werden
      ausgewertet. Regeln, die bisher still ignoriert wurden (etwa das
      Vier-Augen-Prinzip beim eigenen Urlaubsantrag), zeigen jetzt ihre
      bestehende Meldung. Prüfregeln, Berechtigungen, Audit-Ereignisse und
      Datenänderungen bleiben unverändert. Keine fachliche Freigabe.
    tests:
      - apps/web/src/app/staff/(protected)/admin/audit/__tests__/actions-result.test.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/__tests__/actions.test.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/privacy/__tests__/actions.test.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/requests/__tests__/actions.test.ts
      - apps/web/src/app/staff/(protected)/notifications/__tests__/actions.test.ts
      - apps/web/src/__tests__/action-result-contract.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261004-014
    date: '2026-10-04'
    paths:
      - apps/web/src/app/staff/(protected)/admin/dsgvo/[id]/anonymize-contact-button.tsx
      - apps/web/src/app/staff/(protected)/admin/dsgvo/[id]/page.tsx
      - apps/web/src/app/staff/(protected)/admin/dsgvo/__tests__/actions.test.ts
      - apps/web/src/app/staff/(protected)/admin/dsgvo/actions.ts
      - apps/web/src/app/staff/(protected)/admin/dsgvo/new/page.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/notices/__tests__/create-notice-action.test.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/notices/actions.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/notices/new/page.tsx
      - apps/web/src/app/staff/(protected)/clients/onboarding/[id]/actions.ts
      - apps/web/src/app/staff/(protected)/invoices/[id]/invoice-status-actions.tsx
      - apps/web/src/app/staff/(protected)/invoices/actions.ts
      - apps/web/src/app/staff/(protected)/poa/[id]/revoke-poa-form.tsx
      - apps/web/src/app/staff/(protected)/poa/__tests__/actions.test.ts
      - apps/web/src/app/staff/(protected)/poa/actions.ts
      - apps/web/src/app/staff/(protected)/tax-deadlines/__tests__/actions.test.ts
      - apps/web/src/app/staff/(protected)/tax-deadlines/actions.ts
      - apps/web/src/app/staff/(protected)/tax-deadlines/group/page.tsx
      - apps/web/src/app/staff/(protected)/tax-deadlines/page.tsx
      - apps/web/src/server/invoicing/__tests__/invoice-actions.test.ts
      - apps/web/src/server/invoicing/__tests__/invoice-concurrency-db.test.ts
    rule_ids:
      - TAX-NOTICE-APPEAL-001
      - TAX-NOTICE-DATARETRIEVAL-001
      - TAX-DEADLINE-AUTOREQUEST-001
      - TAX-CONTROL-STATUS-001
      - DSGVO-REQUEST-DEADLINE-001
      - DSGVO-REQUEST-EVIDENCE-001
      - DSGVO-CONTACT-EXPORT-001
      - INV-LIFECYCLE-FREEZE-001
      - INV-STORNO-REFERENCE-001
      - INV-VAT-TOTALS-001
      - POA-LIFECYCLE-001
      - POA-SIGNING-CONFIRMATION-001
      - POA-SIGNING-SNAPSHOT-001
      - CLIENT-MANDATE-LIFECYCLE-001
      - ACCESS-TENANT-RLS-001
      - ACCESS-SEARCH-SCOPE-001
    reason: >-
      Server-Actions der Bescheid- und Fristerfassung, der DSGVO-Anträge, der
      Mandantenanlage und des Onboardings, des Rechnungsstatus und des
      Vollmachtswiderrufs geben Validierungs-, Berechtigungs- und Fachfehler als
      ActionResult an das Formular zurück, statt sie zu werfen oder zu
      verwerfen; die Eingaben bleiben erhalten. Der Vollmachtswiderruf meldet
      Erfolg nur noch, wenn der Wrapper ihn bestätigt. Prüfregeln, Fehlertexte,
      Berechtigungsprüfungen, Audit-Ereignisse und Datenänderungen bleiben
      unverändert; geändert ist nur der Rückweg des Fehlers in die Oberfläche.
      Keine fachliche Freigabe.
    tests:
      - apps/web/src/app/staff/(protected)/clients/[id]/notices/__tests__/create-notice-action.test.ts
      - apps/web/src/app/staff/(protected)/admin/dsgvo/__tests__/actions.test.ts
      - apps/web/src/app/staff/(protected)/tax-deadlines/__tests__/actions.test.ts
      - apps/web/src/app/staff/(protected)/poa/__tests__/actions.test.ts
      - apps/web/src/server/invoicing/__tests__/invoice-actions.test.ts
      - apps/web/src/__tests__/action-result-contract.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261004-013
    date: '2026-10-04'
    paths:
      - apps/web/src/server/rate-limit/index.ts
      - apps/web/src/server/auth/staff.ts
      - apps/web/src/server/auth/magic-link-entry.ts
      - apps/web/src/app/portal/(auth)/login/actions.ts
      - apps/web/src/app/staff/(auth)/login/actions.ts
      - apps/web/src/app/gwg-onboarding/actions.ts
      - apps/web/src/app/gwg-onboarding/page.tsx
      - apps/web/src/app/poa/sign/document/route.ts
      - apps/web/src/app/staff/(protected)/poa/sign-actions.ts
      - apps/web/src/server/payroll/capability.ts
    rule_ids:
      - ACCESS-TENANT-RLS-001
      - GWG-SELF-ONBOARDING-001
      - GWG-OCR-ASSIST-001
      - DOC-UPLOAD-JOURNAL-001
      - POA-SIGNING-SNAPSHOT-001
      - POA-SIGNING-CONFIRMATION-001
      - POA-LIFECYCLE-001
      - PAYROLL-INTAKE-001
    reason: >-
      Ohne vertrauenswürdige Client-IP fallen die öffentlichen Rate-Limits nicht
      mehr auf einen kleinen gemeinsamen Zähler aller Nutzer zurück, sondern auf
      konto- beziehungsweise E-Mail-gebundene Zähler (HMAC statt Klartext) und
      eine großzügige globale Sturm-Obergrenze; Fehlversuche ohne Client-IP
      sperren Staff-Konten nicht mehr 30 Minuten, die kontogebundenen Limits vor
      Passwort- und TOTP-Prüfung bleiben. Mit Proxy-Vertrauen stammt die
      Client-IP vom rechten Ende von X-Forwarded-For (TRUST_PROXY_HOPS) statt
      aus dem vom Client setzbaren linken Eintrag; dieselbe Adresse landet in
      Vollmacht-, GwG- und Lohn-Nachweisen. Token-, OTP- und Signaturgrenzen,
      Nachweisinhalte und fachliche Abläufe bleiben unverändert. Keine
      fachliche Freigabe.
    tests:
      - apps/web/src/server/rate-limit/__tests__/client-ip.test.ts
      - apps/web/src/server/rate-limit/__tests__/ip-or-global-limit.test.ts
      - apps/web/src/server/auth/__tests__/staff-login-without-client-ip.test.ts
      - apps/web/src/server/auth/__tests__/magic-link-request-limit.test.ts
      - apps/web/src/server/auth/__tests__/lockout.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261004-012
    date: '2026-10-04'
    paths:
      - .forgejo/workflows/ci.yml
    rule_ids:
      - ASSURANCE-RELEASE-EVIDENCE-001
      - GWG-ACTIVATION-GATE-001
      - GWG-IDENTIFICATION-EVIDENCE-001
      - GWG-RETENTION-DESTRUCTION-001
      - GWG-SELF-ONBOARDING-001
    reason: >-
      Der db-Job und der upgrade-path-Job prüfen nach der Migration zusätzlich
      die GwG-Schutzinvarianten aus packages/db/invariants gegen die echte
      Datenbank. Es sind dieselben Prüfungen, mit denen ops-lib.sh beim
      Kunden-Update über den Start schreibender Dienste entscheidet; Inhalt
      und Ergebnis der Prüfungen sind unverändert. Bestehende Schritte, Gates
      und Release-Nachweise bleiben unverändert. Keine fachliche Freigabe.
    tests:
      - packages/db/src/__tests__/db-invariants-ci.test.ts
      - packages/db/src/__tests__/db-invariants.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261004-011
    date: '2026-10-04'
    paths:
      - apps/web/src/app/staff/(protected)/clients/[id]/page.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/bwa/[periodId]/page.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/bwa/plans/page.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/bwa/plans/new/page.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/change-requests/page.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/page.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/__tests__/page-render.test.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/notices/page.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/notices/new/page.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/privacy/page.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/privacy/__tests__/page.test.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/requests/new/page.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/subsumtion/_guard.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/tax-schedule/page.tsx
    rule_ids:
      - ACCESS-CLIENT-MODE-001
      - BWA-TAX-ESTIMATE-001
      - BWA-IMPORT-MAPPING-001
      - BWA-PROJECTION-001
      - TAX-MASTER-DATA-001
      - GWG-BENEFICIAL-OWNERS-001
      - GWG-IDENTIFICATION-EVIDENCE-001
      - GWG-REPRESENTATIVE-AUTHORITY-001
      - GWG-RETENTION-DESTRUCTION-001
      - GWG-REVERIFICATION-VALIDITY-001
      - GWG-RISK-REVIEW-001
      - GWG-SELF-ONBOARDING-001
      - TAX-NOTICE-APPEAL-001
      - TAX-NOTICE-DATARETRIEVAL-001
      - TAX-CONTROL-STATUS-001
      - ACCESS-SEARCH-SCOPE-001
      - DSGVO-CONSENT-SNAPSHOT-001
    reason: >-
      Alle Seiten unter /staff/clients/[id] rufen vor jedem Datenzugriff den
      request-gecachten Seiten-Guard requireClientPageAccess auf, der dieselbe
      canAccessClient-Entscheidung wie bisher das Segment-Layout trifft und bei
      Verweigerung wie bisher auf die Mandantenliste umleitet. Bisher prüfte
      für 16 Seiten nur das Layout, das bei Navigation zwischen Unterseiten
      nicht erneut läuft. Die Entscheidungstabelle von ACCESS-CLIENT-MODE-001,
      Seiteninhalte und alle fachlichen Abläufe bleiben unverändert; an den
      Seiten ändern sich nur Import und Reihenfolge des Guards. Keine fachliche
      Freigabe.
    tests:
      - apps/web/src/__tests__/client-page-authz.test.ts
      - apps/web/src/server/auth/__tests__/client-page-access.test.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/__tests__/page-render.test.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/privacy/__tests__/page.test.tsx
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261004-010
    date: '2026-10-04'
    paths:
      - apps/web/src/server/invoicing/zugferd.ts
      - apps/web/src/server/invoicing/__tests__/zugferd.test.ts
      - apps/web/src/server/documents/pdf-fonts.ts
      - apps/web/src/server/documents/__tests__/pdf-fonts.test.ts
      - apps/web/src/server/risk/export/to-pdf.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/subsumtion/export-panel.tsx
    rule_ids:
      - INV-ARCHIVE-EINVOICE-001
      - STBVV-CALCULATION-001
      - CLIENT-ASSISTANCE-001
      - CLIENT-OFFBOARDING-001
      - MANDATE-STRUCTURE-001
      - PAYROLL-INTAKE-001
      - RISK-ARCHIVE-SNAPSHOT-001
    reason: >-
      Neu erzeugte ZUGFeRD-PDFs für Rechnungen und Korrekturbelege betten die
      hashgeprüften Noto-Schriften als Teilmenge ein statt WinAnsi-Helvetica zu
      nutzen. Namen und Texte mit ı, Ş, ğ, Ł oder ř brechen Ausstellung und
      Storno nicht mehr ab; nicht abgedeckte Zeichen wie Emoji oder CJK sperren
      die Erzeugung weiterhin, jetzt mit Angabe der Zeichen. Positionen,
      Beträge, factur-x.xml und XMP-Metadaten bleiben unverändert; archivierte
      Fassungen werden weiter byte-identisch ausgeliefert und nicht neu
      gerendert. Der gemeinsame PDF-Schrifthelfer setzt Tabulatoren als
      Leerzeichen und misst Ersatzglyphen in ihrer tatsächlichen Schrift, was
      Zeilenumbrüche in Lohn-, Mandanten-, Mandatsstruktur- und
      Offboarding-PDFs nur bei bisher zu schmal gemessenen Zeichen ändert. Der
      Subsumtions-Export zeigt nicht darstellbare Zeichen im Exportfenster an.
      Keine fachliche Freigabe.
    tests:
      - apps/web/src/server/invoicing/__tests__/zugferd.test.ts
      - apps/web/src/server/documents/__tests__/pdf-fonts.test.ts
      - apps/web/src/server/risk/export/__tests__/to-pdf.test.ts
      - apps/web/src/lib/__tests__/route-download.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261004-009
    date: '2026-10-04'
    paths:
      - apps/web/src/server/risk/export/to-pdf.ts
      - apps/web/src/server/risk/export/__tests__/to-pdf.test.ts
      - apps/web/src/app/api/staff/clients/[id]/subsumtion/[analysisId]/export/route.ts
    rule_ids:
      - RISK-ARCHIVE-SNAPSHOT-001
      - ACCESS-CLIENT-MODE-001
    reason: >-
      Der PDF-Export der Subsumtionsanalyse setzt Texte mit den vorhandenen,
      hashgeprüften Noto-Schriften statt mit WinAnsi-Helvetica. Zeichen wie ı,
      Ş, ğ, Ł oder ř wurden bisher still verstümmelt und erscheinen jetzt
      korrekt; nicht abgedeckte Zeichen wie Emoji sperren den PDF-Export mit
      HTTP 422 und Angabe der Zeichen, ohne Audit-Eintrag, statt fehlerhafter
      Ausgabe. Inhalt, Gliederung, Zugriffsprüfung, Archivstand und der
      DOCX-Export bleiben unverändert. Keine fachliche Freigabe.
    tests:
      - apps/web/src/server/risk/export/__tests__/to-pdf.test.ts
      - apps/web/src/app/api/staff/clients/[id]/subsumtion/[analysisId]/export/__tests__/route.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261004-008
    date: '2026-10-04'
    paths:
      - apps/web/src/app/api/staff/clients/[id]/datev-belege-export/route.ts
      - apps/web/src/app/api/staff/documents/download/route.ts
      - apps/web/src/app/api/staff/documents/__tests__/bulk-download-audit.test.ts
      - apps/web/src/app/api/staff/documents/__tests__/bulk-download-filenames.test.ts
      - apps/web/src/app/api/staff/documents/__tests__/bulk-download-readiness.test.ts
      - apps/web/src/app/api/staff/documents/__tests__/bulk-download-stream.test.ts
    rule_ids:
      - DOC-UPLOAD-JOURNAL-001
      - DOC-VERSION-IMMUTABILITY-001
    reason: >-
      Sammel-Download und DATEV-Belegexport erzeugen das ZIP als Datenstrom aus
      dem Object-Store statt es bis zu 1 GiB mehrfach im Webprozess zu puffern;
      der Export-Slot bleibt bis zum Ende der Übertragung belegt. Auswahl,
      Auslieferbarkeitsprüfung vor Abrufnachweis und Store-Zugriff,
      Versionsbindung, Größen- und Eintragsgrenzen sowie Dateiinhalte bleiben
      unverändert. Im DATEV-Export stehen index.csv und manifest.txt am Ende
      des Archivs, weil sie fehlende Belege melden; ihr Inhalt bleibt gleich.
      Ein Fehler nach Beginn der Übertragung bricht den Download ab, statt ein
      unvollständiges Archiv zu liefern. Keine fachliche Freigabe.
    tests:
      - apps/web/src/app/api/staff/documents/__tests__/bulk-download-stream.test.ts
      - apps/web/src/app/api/staff/documents/__tests__/bulk-download-readiness.test.ts
      - apps/web/src/app/api/staff/clients/[id]/datev-belege-export/__tests__/route.test.ts
      - apps/web/src/server/export/__tests__/zip-stream.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261004-007
    date: '2026-10-04'
    paths:
      - apps/web/src/app/api/staff/documents/download/route.ts
      - apps/web/src/server/documents/delivery.ts
      - apps/web/src/server/audit/labels.ts
      - apps/web/src/app/api/staff/admin/audit/export/route.ts
      - apps/web/src/app/api/portal/documents/__tests__/read-rate-limit.test.ts
      - apps/web/src/app/api/staff/documents/__tests__/bulk-download-audit.test.ts
      - apps/web/src/app/api/staff/documents/__tests__/bulk-download-filenames.test.ts
      - apps/web/src/app/api/staff/documents/__tests__/bulk-download-readiness.test.ts
      - apps/web/src/app/api/staff/documents/__tests__/delivery-access.test.ts
      - apps/web/src/server/documents/__tests__/delivery.test.ts
    rule_ids:
      - DOC-UPLOAD-JOURNAL-001
      - DOC-VERSION-IMMUTABILITY-001
      - DOC-PORTAL-SHARING-001
      - ACCESS-STAFF-PERMISSION-001
      - AUDIT-HASH-CHAIN-001
      - TCMS-SAMPLE-PROOF-001
    reason: >-
      Ein Sammel-Download als ZIP schreibt statt eines document.download je
      Dokument genau ein Ereignis document.download.bulk, dessen Nachher-Zustand
      alle gelieferten Dokument-IDs vollständig, dedupliziert und in
      Archivreihenfolge sowie Anzahl und Ordner enthält; Einzeldownloads bleiben
      bei document.download. Vorschauen werden nur noch beim Byte-Abruf
      protokolliert, nicht zusätzlich bei der Metadatenanfrage; Zugriffs- und
      Auslieferbarkeitsprüfung laufen für beide Anfragen unverändert. Gesperrte
      Versionen erscheinen weiterhin weder im Archiv noch im Abrufnachweis. Der
      Audit-CSV-Export erhält eine Spalte Details mit Anzahl und IDs, die neue
      Aktion ein Label. Die Form des Abrufnachweises ändert sich, Umfang und
      Zugriffsentscheidungen nicht. Keine fachliche Freigabe; Compliance und
      Archiv sollen die neue Nachweisform bestätigen.
    tests:
      - apps/web/src/app/api/staff/documents/__tests__/bulk-download-audit.test.ts
      - apps/web/src/app/api/staff/documents/__tests__/bulk-download-readiness.test.ts
      - apps/web/src/server/documents/__tests__/delivery.test.ts
      - apps/web/src/app/api/staff/admin/audit/export/__tests__/route.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261004-006
    date: '2026-10-04'
    paths:
      - apps/web/src/app/api/staff/clients/[id]/datev-belege-export/route.ts
      - apps/web/src/app/api/staff/documents/download/route.ts
      - apps/web/src/app/api/staff/documents/__tests__/bulk-download-readiness.test.ts
    rule_ids:
      - DOC-UPLOAD-JOURNAL-001
      - DOC-VERSION-IMMUTABILITY-001
    reason: >-
      DATEV-Belegexport und Sammel-Download schreiben ihren Abrufnachweis erst,
      nachdem Größen-, Eintrags- und Slot-Prüfung bestanden sind, und vor dem
      Laden des ersten Objekts. Mit 413 oder 429 abgelehnte Exporte erscheinen
      dadurch nicht mehr als Abruf im Prüfprotokoll. Die Eintragszahl wird jetzt
      vor dem Laden geprüft statt erst beim ZIP-Bau. Audit-Inhalt,
      Zugriffsprüfung, Versionsbindung und gelieferte Dateien bleiben
      unverändert. Keine fachliche Freigabe.
    tests:
      - apps/web/src/app/api/staff/clients/[id]/datev-belege-export/__tests__/route.test.ts
      - apps/web/src/app/api/staff/documents/__tests__/bulk-download-readiness.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261004-005
    date: '2026-10-04'
    paths:
      - packages/evidence/src/service.ts
      - packages/evidence/src/__tests__/chain-walk.test.ts
    rule_ids:
      - AUDIT-HASH-CHAIN-001
      - AUDIT-RFC3161-ANCHOR-001
    reason: >-
      verifyChain und verifyRecoverySegment nutzen einen gemeinsamen
      Kettendurchlauf walkChain und eine gemeinsame Siegelprüfung verifySeals
      statt zweier kopierter Implementierungen. Ergebnisfelder, Bruchdetails mit
      erwartetem und tatsächlichem Hash, der frühe Abbruch vor Siegel- und
      Ankerprüfung, die Siegelzählung und der Umfang des Recovery-Segments ohne
      Rolling-Anker und ohne Unanchored-Policy bleiben unverändert. Die neuen
      Tests bestehen auch gegen die vorherige Implementierung. Keine fachliche
      Freigabe.
    tests:
      - packages/evidence/src/__tests__/chain-walk.test.ts
      - packages/evidence/src/__tests__/service-anchor.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261004-004
    date: '2026-10-04'
    paths:
      - packages/db/prisma/migrations/20261004121000_tenant_client_pair_key_share_lock/migration.sql
    rule_ids:
      - ACCESS-TENANT-RLS-001
    reason: >-
      Der Paar-Guard app.enforce_tenant_client_pair_integrity sperrt den
      Mandanten mit FOR KEY SHARE statt FOR SHARE; Prüfung, Fehlercodes,
      search_path und Rechte bleiben identisch. FOR KEY SHARE blockiert
      weiterhin Löschung, Schlüsseländerungen und explizites SELECT FOR UPDATE,
      mit denen Anonymisierung, Offboarding und Stammdatenpflege serialisieren.
      Nur gewöhnliche Stammdaten-Updates warten nicht mehr auf parallele
      Kind-Inserts. Die Tenant-/Mandanten-Paarinvariante ändert sich nicht.
      Keine fachliche Freigabe.
    tests:
      - packages/db/src/__tests__/tenant-client-pair-lock.test.ts
      - packages/db/src/__tests__/rls-cross-tenant.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261004-003
    date: '2026-10-04'
    paths:
      - .forgejo/workflows/ci.yml
    rule_ids:
      - ASSURANCE-RELEASE-EVIDENCE-001
      - MANDATE-STRUCTURE-001
      - GWG-BENEFICIAL-OWNERS-001
      - GWG-RISK-REVIEW-001
      - GWG-RETENTION-DESTRUCTION-001
    reason: >-
      Der blockierende DB-Job führt den bereits als Nachweis katalogisierten
      PostgreSQL-Test service-db.test.ts zusätzlich gegen eine frische,
      isolierte Datenbank aus und lädt dessen Protokoll mit den übrigen
      DB-Testberichten hoch. Bestehende Schritte, Gates und Release-Nachweise
      bleiben unverändert; Regeln, Testinhalte und Produktverhalten ändern sich
      nicht. Keine fachliche Freigabe.
    tests:
      - apps/web/src/server/mandate-expansion/__tests__/service-db-ci.test.ts
      - apps/web/src/server/mandate-expansion/__tests__/service-db.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261004-002
    date: '2026-10-04'
    paths:
      - apps/web/src/server/auth/rbac.ts
    rule_ids:
      - ACCESS-STAFF-PERMISSION-001
      - ACCESS-CLIENT-MODE-001
    reason: >-
      toActionError protokolliert bekannte Prisma-Fehler zusätzlich im
      Server-Log: P2025 und P2002 als warn, alle übrigen Codes als error, jeweils
      mit Prisma-Code, Modell, SQLSTATE, Constraint, Meldung und Stack, aber ohne
      die rohen meta-Daten mit möglichen Zeilenwerten. Rückgabewerte,
      UI-Meldungen, Rollen- und Rechteprüfungen sowie der Mandantenzugriff
      bleiben unverändert. Keine fachliche Freigabe.
    tests:
      - apps/web/src/server/auth/__tests__/rbac.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20261004-001
    date: '2026-10-04'
    paths:
      - packages/db/prisma/migrations/20261004120000_rls_resource_uuid_lookup/migration.sql
    rule_ids:
      - ACCESS-NOTIFICATION-RECIPIENT-001
      - PORTAL-INBOX-SUBMISSION-001
      - ACCESS-TENANT-RLS-001
      - ACCESS-STAFF-PERMISSION-001
      - DOC-PORTAL-SHARING-001
      - MANDATE-STRUCTURE-001
      - CLIENT-OFFBOARDING-001
    reason: >-
      Die Migration ersetzt in app.notification_resource_scope,
      app.mandate_artifact_document_allowed und
      app.document_payroll_scope_allowed ausschließlich den ID-Vergleich
      `id::text = p` durch `id = app.canonical_uuid_or_null(p)`. Der Helfer
      akzeptiert nur die kanonische Textform, die uuid::text immer liefert;
      jede Eingabe trifft daher dieselben Zeilen wie bisher, und
      Nicht-UUID-Werte wie BIGINT-Audit-IDs treffen weiterhin nichts.
      Signaturen, Policies und Grants sowie Empfänger-, Mandanten-, Lohn- und
      Artefaktentscheidungen bleiben unverändert; Primär- und Unique-Indizes
      werden lediglich nutzbar. Keine fachliche Freigabe.
    tests:
      - packages/db/src/__tests__/rls-resource-uuid-lookup.test.ts
      - packages/db/src/__tests__/notification-client-scope-rls.test.ts
      - packages/db/src/__tests__/portal-inbox-rls.test.ts
      - packages/db/src/__tests__/mailbox-rls.test.ts
      - packages/db/src/__tests__/rls-cross-tenant.test.ts
    reviewer: Claude (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20260914-001
    date: '2026-09-14'
    paths:
      - apps/web/src/app/staff/(protected)/poa/new/page.tsx
    rule_ids:
      - POA-LIFECYCLE-001
      - ACCESS-STAFF-PERMISSION-001
    reason: >-
      Die Vollmachtsanlage erhält mobile Außenabstände und einen neutralen
      Leerzustand mit Link zur Mandantenliste. Der Aufnahmeweg erscheint nur
      mit dem bestehenden CLIENT_CREATE-Recht. Mandantenauswahl, expliziter
      Onboarding-Kontext, Modul- und Adminprüfung, Uploadkontext, Server-Actions
      und fachliche Statusmaschine bleiben unverändert. Der bisher pauschale
      Hinweis auf eine noch abzuschließende GwG-Prüfung wird nicht länger als
      Erklärung eines unbekannten Grundes verwendet. Keine fachliche Freigabe.
    tests:
      - apps/web/src/app/staff/(protected)/poa/new/__tests__/return-context.test.ts
      - apps/web/src/app/staff/(protected)/invoices/new/__tests__/page.test.tsx
      - apps/web/src/server/client-assistance/__tests__/page.test.tsx
      - apps/e2e/tests/12-accessibility.spec.ts
    reviewer: Codex (technischer Layout- und Leerzustandsabgleich, keine fachliche Freigabe)
  - id: FK-EXC-20260910-001
    date: '2026-09-10'
    paths:
      - packages/tax/package.json
    rule_ids:
      - GWG-SCREENING-001
    reason: >-
      Ausschließlich die Entwicklungsabhängigkeit Vitest wird von ^4.1.7
      auf den Sicherheitsstand 4.1.11 gepinnt (GHSA-82fw-gwwq-j7x9).
      Der in GWG-SCREENING-001 referenzierte Paketpfad erhält keine Änderung
      an Laufzeitabhängigkeiten, Exporten oder Skripten. Quellenprüfung,
      Namensabgleich, Nachweisbindung, Persistenz und GwG-Freigabesperren
      bleiben unverändert. Die bestehenden Screening-Tests dienen dem
      technischen Regressionsabgleich mit dem aktualisierten Testwerkzeug;
      dies ist keine fachliche Freigabe.
    tests:
      - packages/tax/src/screening/screening.test.ts
      - packages/tax/src/screening/persistence.test.ts
      - apps/web/src/server/screening/__tests__/gwg-gate.test.ts
    reviewer: Codex (technischer Dependency-Diff-Abgleich, keine fachliche Freigabe)
  - id: FK-EXC-20260907-004
    date: '2026-09-07'
    paths:
      - apps/web/src/app/staff/(protected)/clients/[id]/subsumtion/subsumtion-workspace.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/subsumtion/subsumtion-document.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/subsumtion/subsumtion-compose.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/subsumtion/subsumtion-review-controls.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/subsumtion/subsumtion-selection-panel.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/subsumtion/use-format-autosave.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/subsumtion/use-subsumtion-llm.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/subsumtion/workspace-types.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/subsumtion/__tests__/compose-editor-structure.test.ts
    rule_ids:
      - RISK-AI-SUGGESTION-001
      - RISK-ARCHIVE-SNAPSHOT-001
    reason: >-
      Die Editoransicht trennt Erfassung, Prüfung, Auswahl und technische
      Speicherzustände. Importierter Text wird an das bestehende Rich-Text-
      Dokument angehängt, ohne vorhandene Formatierungen oder zwischenzeitlich
      eingegebene Titel zu überschreiben. Fehlgeschlagene Formatierungssaves
      wiederholen den neuesten unveränderten Inhaltsstand. Fachanalyse,
      Berechtigungen, fachliche Prüfmarkierung, Provenienz und Archivierung
      bleiben unverändert; Inhaltsänderungen verhindern die Formatierungssave-
      Wiederholung. Browsertests nutzen echte Komponenten mit synthetischen
      Action-Grenzen, keine fachliche Freigabe.
    tests:
      - apps/e2e/tests/20-subsumtion-editor-state.spec.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/subsumtion/__tests__/compose-editor-structure.test.ts
    reviewer: Codex (technische Zustands- und Komponentenprüfung, keine fachliche Freigabe)
  - id: FK-EXC-20260907-003
    date: '2026-09-07'
    paths:
      - apps/web/src/app/staff/(protected)/notifications/page.tsx
      - apps/web/src/app/staff/(protected)/notifications/__tests__/page.test.tsx
    rule_ids:
      - ACCESS-NOTIFICATION-RECIPIENT-001
    reason: >-
      Die Listenansicht sortiert ungelesene Einträge ausdrücklich vor
      gelesenen und zählt alle aktuell sichtbaren ungelesenen Hinweise
      unabhängig vom 100er-Anzeigefenster. Liste und Count bleiben in
      derselben Tenant-Transaktion mit demselben persönlichen oder
      kanzleiweiten Empfängerfilter, ausdrücklicher Tenantbedingung
      und bestehender RLS. Keine
      Empfängerauswahl, Zugriffsentscheidung oder Gelesen-Mutation ändert sich.
    tests:
      - apps/web/src/app/staff/(protected)/notifications/__tests__/page.test.tsx
      - apps/web/src/app/staff/(protected)/notifications/__tests__/actions.test.ts
    reviewer: Codex (technischer Anzeigeabgleich, keine fachliche Freigabe)
  - id: FK-EXC-20260907-002
    date: '2026-09-07'
    paths:
      - apps/web/src/app/staff/(protected)/admin/audit/__tests__/hash-column.test.ts
      - apps/web/src/app/staff/(protected)/admin/audit/audit-access-card.tsx
      - apps/web/src/app/staff/(protected)/admin/audit/rolling-anchor-card.tsx
    rule_ids:
      - AUDIT-HASH-CHAIN-001
      - AUDIT-VERIFY-ALERT-001
    reason: >-
      Der Hash-Spaltentest wird als TSX-Test an der tatsächlich gerenderten
      Tabelle fortgeführt. Prüfer-Link und Rolling-Ankerkarte werden mit
      unveränderter Tokenbindung, Laufzeit und Statusdarstellung aus der
      bereits geschützten Audit-Seite extrahiert. Diese Verschiebungen
      ändern keine Zugriffsentscheidung, Audit-Aktion oder fachliche
      Bewertung. Die getrennte Korrektur des Kanzlei-Zählers ist direkt
      in AUDIT-HASH-CHAIN-001 dokumentiert.
    tests:
      - apps/web/src/app/staff/(protected)/admin/audit/__tests__/hash-column.test.tsx
      - apps/web/src/app/staff/(protected)/admin/audit/__tests__/page.test.tsx
      - apps/web/src/app/staff/(protected)/admin/audit/__tests__/audit-verify-refresh-ui.test.ts
    reviewer: Codex (technischer Refactoring-Abgleich, keine fachliche Freigabe)
  - id: FK-EXC-20260907-001
    date: '2026-09-07'
    paths:
      - apps/web/src/app/api/staff/documents/download/route.ts
      - apps/web/src/app/api/staff/documents/__tests__/bulk-download-filenames.test.ts
    rule_ids:
      - DOC-VERSION-IMMUTABILITY-001
    reason: >-
      Technische Fortsetzung der kollisionsfreien ZIP-Transportnamen:
      Benötigte Verzeichnisse einschließlich aller Elternpfade werden vor
      Dateien reserviert. Eine namensgleiche Datei kann dadurch das Entpacken
      eines ausgewählten Ordners nicht blockieren. Zugriff, Dokumentauswahl,
      Originalbytes, gespeicherte Namen, Versionen und Aufbewahrung bleiben
      unverändert. Geändert werden ausschließlich Pfade der Downloadkopie.
    tests:
      - apps/web/src/app/api/staff/documents/__tests__/bulk-download-filenames.test.ts
      - apps/web/src/server/export/__tests__/zip.test.ts
    reviewer: Codex (technischer Verhaltensabgleich, keine fachliche Freigabe)
  - id: FK-EXC-20260906-003
    date: '2026-09-06'
    paths:
      - apps/web/src/app/api/staff/documents/download/route.ts
      - apps/web/src/app/api/staff/documents/__tests__/bulk-download-filenames.test.ts
    rule_ids:
      - DOC-VERSION-IMMUTABILITY-001
    reason: >-
      Die technische ZIP-Auslieferung reserviert eindeutige Transportnamen
      einschließlich erzeugter Suffixe, Groß-/Kleinschreibung und
      Unicode-Normalisierung. So überschreibt ein Archiveintrag beim Entpacken
      keinen anderen ausgewählten Beleg. Dokumentauswahl, Autorisierung,
      Quelldaten, Versionsbindung und Aufbewahrung bleiben unverändert;
      es werden ausschließlich die Namen in der heruntergeladenen Kopie
      kollisionsfrei vergeben, keine archivierten Dokumentnamen geändert.
    tests:
      - apps/web/src/app/api/staff/documents/__tests__/bulk-download-filenames.test.ts
      - apps/web/src/server/export/__tests__/zip.test.ts
    reviewer: Codex (technischer Verhaltensabgleich, keine fachliche Freigabe)
  - id: FK-EXC-20260906-001
    date: '2026-09-06'
    paths:
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/__tests__/ui-state.test.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/add-id-doc-form.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/identity-document-review.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/legal-entity-details-form.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/use-gwg-document-search.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/subsumtion/new-marking-panel.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/subsumtion/norm-ref-editor.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/subsumtion/subsumtion-workspace.tsx
      - apps/web/src/app/staff/(protected)/invoices/[id]/page.tsx
      - apps/web/src/app/staff/(protected)/invoices/new/form.tsx
    rule_ids:
      - GWG-IDENTIFICATION-EVIDENCE-001
      - GWG-BENEFICIAL-OWNERS-001
      - RISK-AI-SUGGESTION-001
      - RISK-ARCHIVE-SNAPSHOT-001
      - INV-VAT-TOTALS-001
      - INV-LIFECYCLE-FREEZE-001
    reason: >-
      Rein technische React-Zustandsbereinigung und Extraktion bestehender
      Ansichten. Auswahlentwürfe werden an ihre Eingabe gebunden, Suchantworten
      gegen überholte Anfragen geschützt, URL-Ansichten über Browsersubscriptions
      synchronisiert und Ereignis-Refs nach dem Render aktualisiert. Fachliche
      Eingaben, Berechnungen, Normvorschläge, Prüfentscheidungen, Server-Actions,
      Autorisierung und Archivierung werden dadurch nicht geändert. Die
      Rechnungsdetailansicht verwendet einen gemeinsamen Zeitpunkt pro Request;
      das neue Rechnungsformular initialisiert denselben Datumsdefault einmalig.
      Fachliche Rechnungsänderungen sind separat in den betroffenen Regeln erfasst.
    tests:
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/__tests__/ui-state.test.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/__tests__/actions.test.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/subsumtion/__tests__/document-selection.test.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/subsumtion/__tests__/compose-editor-structure.test.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/subsumtion/__tests__/katalog-overlay.test.ts
      - apps/web/src/server/invoicing/__tests__/archive-lock-call-sites.test.ts
    reviewer: Codex (technischer Strukturabgleich, keine fachliche Freigabe)
  - id: FK-EXC-20260906-002
    date: '2026-09-06'
    paths:
      - apps/web/src/server/bwa/liquidity.ts
      - apps/web/src/server/bwa/tax-estimator.ts
      - apps/web/src/server/bwa/__tests__/liquidity.test.ts
      - packages/tax/src/materialize.ts
    rule_ids:
      - BWA-TAX-ESTIMATE-001
      - BWA-PROJECTION-001
      - TAX-DEADLINE-AUTOREQUEST-001
      - TAX-DEADLINE-WORKDAY-001
    reason: >-
      Bestehende Berechnungsschritte, Optionsdefaults und Datensatzabbildungen
      werden unverändert in benannte Helfer aufgeteilt. Formeln, Tarifwerte,
      Vorzeichen, Rundungen, Terminregeln, Anspruchs- und Anforderungsauswahl,
      Tenantfilter und Transaktionsgrenzen bleiben erhalten. Der zusätzliche
      Liquiditätstest fixiert die bereits bestehende Berechnung; die laufenden
      Steuer- und Materialisierungstests prüfen Ergebnisse und Nebenwirkungen.
    tests:
      - apps/web/src/server/bwa/__tests__/liquidity.test.ts
      - apps/web/src/server/bwa/__tests__/tax-estimator.test.ts
      - packages/tax/src/__tests__/materialize.test.ts
    reviewer: Codex (technischer Strukturabgleich, keine fachliche Freigabe)
  - id: FK-EXC-20260830-012
    date: '2026-08-30'
    paths:
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/page.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/add-id-doc-form.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/identity-document-review.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/person-roles-panel.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/invite-section.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/id-document-actions.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/owner-actions.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/subsumtion/subsumtion-document.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/subsumtion/subsumtion-workspace.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/__tests__/actions.test.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/__tests__/gwg-layout.test.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/subsumtion/__tests__/document-selection.test.ts
    rule_ids:
      - GWG-IDENTIFICATION-EVIDENCE-001
      - GWG-BENEFICIAL-OWNERS-001
      - GWG-REPRESENTATIVE-AUTHORITY-001
      - GWG-SELF-ONBOARDING-001
      - GWG-REVERIFICATION-VALIDITY-001
      - RISK-AI-SUGGESTION-001
      - RISK-ARCHIVE-SNAPSHOT-001
    reason: >-
      Der Integrationsabschluss extrahiert unveränderte JSX-Abschnitte,
      Statusanzeigen, Vergleiche und Datenabbildungen in kleine lokale
      Komponenten und Helfer. Rollen, Ausweiszuordnung, Datumsprüfung,
      Revisionsvergleich, Transaktions- und Sperrreihenfolge, Auditinhalt,
      Editorbefehle, Snapshot und Persistenz bleiben unverändert. Die
      Ref-Synchronisierung des Editors erfolgt vor Browserereignissen in
      Layout-Effects statt während des Renderns; bestehende Speicher- und
      Markierungsbefehle bleiben erhalten. Die
      Komplexitätsbaseline wird nur nach unten korrigiert; neue oder höhere
      Warnungen werden nicht durch eine gelockerte Grenze akzeptiert.
    tests:
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/__tests__/actions.test.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/__tests__/gwg-layout.test.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/__tests__/ui-state.test.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/subsumtion/__tests__/compose-editor-structure.test.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/subsumtion/__tests__/guards-tx.test.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/subsumtion/__tests__/document-selection.test.ts
      - apps/web/src/components/__tests__/presentation-extraction.test.ts
      - apps/e2e/tests/12-accessibility.spec.ts
    reviewer: Codex (technischer Strukturabgleich ohne fachliche Freigabe)
  - id: FK-EXC-20260830-011
    date: '2026-08-30'
    paths:
      - apps/web/src/app/staff/(protected)/tax-deadlines/group/page.tsx
    rule_ids:
      - TAX-DEADLINE-AUTOREQUEST-001
      - TAX-CONTROL-STATUS-001
    reason: >-
      Nach Integration des main-Refactorings verbleibt ausschließlich der
      Wechsel vom Markenfarb-Fokusring auf den gemeinsamen kontrastgeprüften
      Fokus-Token an der Auswahlcheckbox. Auswahlwerte, zugänglicher Name,
      Filter, Fristen, Zuständigkeit, Actions und Persistenz bleiben unverändert.
    tests:
      - apps/web/src/app/staff/(protected)/tax-deadlines/__tests__/actions.test.ts
      - apps/web/src/lib/__tests__/brand-palette.test.ts
    reviewer: Codex (technischer UI-Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20260830-010
    date: '2026-08-30'
    paths:
      - packages/db/prisma/migrations/20260830233000_personal_display_options/migration.sql
      - packages/db/prisma/schema.prisma
    rule_ids:
      - ACCESS-TENANT-RLS-001
    reason: >-
      Additive Profilspalten speichern nur Schriftgröße, Zeilenabstand,
      Kontrast und Bewegungsreduktion. Fachentscheidungen, Tenantgrenzen,
      Berechtigungen, bestehende RLS-Policies und Grants bleiben unverändert.
      Die Actions schreiben ausschließlich erlaubte Anzeigefelder am aktiven
      Sitzungsprofil; Einzeländerungen überschreiben keine anderen Optionen.
    tests:
      - apps/web/src/lib/__tests__/accessible-display-options.test.ts
      - apps/web/src/server/actions/__tests__/accessible-display.test.ts
      - apps/web/src/server/settings/__tests__/accessible-display.test.ts
      - apps/e2e/tests/13-accessible-display.spec.ts
    reviewer: Codex (technischer UI-Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20260830-009
    date: '2026-08-30'
    paths:
      - packages/db/prisma/migrations/20260830220000_personal_accessible_display/migration.sql
      - packages/db/prisma/schema.prisma
    rule_ids:
      - ACCESS-TENANT-RLS-001
    reason: >-
      Zwei additive Boolean-Spalten speichern ausschließlich die persönliche
      Anzeigepräferenz an bestehenden StaffUser- und ClientContact-Profilen.
      Fachentscheidungen, Mandatsdaten, Tabellenzuordnung, RLS-Policies,
      Grants und Berechtigungen bleiben unverändert. Lesen und Schreiben
      verwenden den vorhandenen Tenantkontext und ausschließlich das aktive,
      angemeldete Profil; Portal-Schreibfilter binden zusätzlich den Mandanten.
    tests:
      - apps/web/src/server/settings/__tests__/accessible-display.test.ts
      - apps/web/src/server/actions/__tests__/accessible-display.test.ts
      - apps/e2e/tests/13-accessible-display.spec.ts
    reviewer: Codex (automatisierter technischer UI-Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20260830-008
    date: '2026-08-30'
    paths:
      - apps/web/src/app/staff/(protected)/documents/[id]/page.tsx
      - apps/web/src/app/staff/(protected)/invoices/[id]/page.tsx
      - apps/web/src/app/staff/(protected)/invoices/new/form.tsx
      - apps/web/src/app/staff/(protected)/invoices/new/page.tsx
      - apps/web/src/app/staff/(protected)/poa/[id]/page.tsx
      - apps/web/src/app/staff/(protected)/poa/new/page.tsx
    rule_ids:
      - DOC-VERSION-IMMUTABILITY-001
      - INV-NUMBER-ALLOCATION-001
      - INV-LIFECYCLE-FREEZE-001
      - POA-LIFECYCLE-001
    reason: >-
      Reine A11Y-Korrekturen geben symbolischen Zurück-Links zugängliche Namen
      und kennzeichnen die nur angezeigte automatische Rechnungsnummer nicht
      länger fälschlich als Formular-Label. Dokumentversionen,
      Rechnungsnummernvergabe, Festschreibung, Vollmachtsstatus, Actions,
      Eingabewerte und gespeicherte Ergebnisse bleiben unverändert.
    tests:
      - apps/e2e/tests/12-accessibility.spec.ts
      - apps/web/src/app/staff/(protected)/documents/__tests__/retag-race.test.ts
      - apps/web/src/server/invoicing/__tests__/number.test.ts
      - apps/web/src/app/staff/(protected)/poa/__tests__/actions.test.ts
    reviewer: Codex (automatisierter technischer UI-Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20260830-007
    date: '2026-08-30'
    paths:
      - apps/web/src/app/staff/(protected)/clients/[id]/subsumtion/editor-toolbar.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/subsumtion/export-panel.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/subsumtion/page.tsx
    rule_ids:
      - RISK-AI-SUGGESTION-001
      - RISK-ARCHIVE-SNAPSHOT-001
    reason: >-
      Die Formatierleiste erhält Toolbar-, Zustands- und Tastatursemantik; das
      Exportpanel erhält Fokus-Rückgabe, Escape-Bedienung und benannte
      Beziehungen, der Zurück-Link einen zugänglichen Namen. Editorbefehle,
      Exportauswahl und -payload, Vorschlagsprovenienz, Archivierung,
      Inhaltsguards und gespeicherte Ergebnisse bleiben unverändert.
    tests:
      - apps/e2e/tests/12-accessibility.spec.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/subsumtion/__tests__/compose-editor-structure.test.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/subsumtion/__tests__/guards-tx.test.ts
    reviewer: Codex (automatisierter technischer UI-Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20260830-006
    date: '2026-08-30'
    paths:
      - apps/web/src/app/staff/(protected)/clients/[id]/notices/new/page.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/requests/new/form.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/requests/new/page.tsx
      - apps/web/src/app/staff/(protected)/tax-deadlines/page.tsx
    rule_ids:
      - TAX-NOTICE-APPEAL-001
      - TAX-NOTICE-DATARETRIEVAL-001
      - REQ-LIFECYCLE-001
      - TAX-CONTROL-STATUS-001
      - TAX-DEADLINE-AUTOREQUEST-001
    reason: >-
      Formularbeschriftungen werden über stabile IDs mit ihren bestehenden
      Feldern verbunden, Symbol-Links erhalten zugängliche Namen und aktive
      Filter nutzen die semantische Kontrastfarbe. Feldnamen, Werte,
      Pflichtlogik, Bescheid- und Fristberechnung, Anforderungsstatus,
      Versandautomatik, Actions und Persistenz bleiben unverändert.
    tests:
      - apps/e2e/tests/12-accessibility.spec.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/notices/__tests__/notice-assessment.test.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/requests/__tests__/actions.test.ts
      - apps/web/src/app/staff/(protected)/tax-deadlines/__tests__/actions.test.ts
    reviewer: Codex (automatisierter technischer UI-Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20260830-005
    date: '2026-08-30'
    paths:
      - apps/web/src/app/staff/(protected)/admin/audit/[id]/page.tsx
      - apps/web/src/app/staff/(protected)/admin/dsgvo/new/page.tsx
      - apps/web/src/app/staff/(protected)/admin/privacy/config-form.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/privacy/consent-editor.tsx
    rule_ids:
      - AUDIT-HASH-CHAIN-001
      - DSGVO-REQUEST-EVIDENCE-001
      - DSGVO-CONSENT-SNAPSHOT-001
    reason: >-
      Symbol-Links erhalten zugängliche Namen, Beschriftungen und Hilfetexte
      werden programmatisch mit den unveränderten Formularfeldern verbunden
      und vorhandene Rückmeldungen als Status oder Fehler angekündigt.
      Auditkette, Abschlussnachweise, Einwilligungssnapshots, Formulardaten,
      Actions und gespeicherte Ergebnisse bleiben unverändert.
    tests:
      - apps/e2e/tests/12-accessibility.spec.ts
      - packages/evidence/src/__tests__/hash-chain.test.ts
      - apps/web/src/server/dsgvo/__tests__/workflow.test.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/privacy/__tests__/actions.test.ts
    reviewer: Codex (automatisierter technischer UI-Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20260830-004
    date: '2026-08-30'
    paths:
      - apps/web/src/app/gwg-onboarding/wizard-steps.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/risk-assessment-form.tsx
    rule_ids:
      - GWG-SELF-ONBOARDING-001
      - GWG-RISK-REVIEW-001
    reason: >-
      Der Onboarding-Wizard und die Risikomaske erhalten ausschließlich
      programmatisch zugeordnete Labels und Hilfetexte, Live-Statussemantik
      sowie kontrastfähige semantische Textfarben. Eingabewerte,
      Dokumentzuordnung, Score, PEP-Override, Einladung, Einreichung,
      Freigabe, Actions und Persistenz bleiben unverändert.
    tests:
      - apps/e2e/tests/12-accessibility.spec.ts
      - apps/web/src/app/gwg-onboarding/__tests__/bound-draft-submit.test.ts
      - apps/web/src/server/gwg/__tests__/risk-score.test.ts
    reviewer: Codex (automatisierter technischer UI-Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20260830-003
    date: '2026-08-30'
    paths:
      - apps/web/src/app/staff/(protected)/clients/[id]/subsumtion/[analysisId]/page.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/subsumtion/_guard.ts
    rule_ids:
      - RISK-AI-SUGGESTION-001
      - RISK-ARCHIVE-SNAPSHOT-001
    reason: >-
      Die Subsumtionsseite reicht ausschließlich eine tenantweite
      Bedienvorgabe für die optionale schwebende Formatierleiste durch und
      vergrößert die bereits vorhandene Editorfläche; die feste Leiste wird
      auch im Review sichtbar. Analyse- und Archivierungsaktionen, Markierungen,
      Vorschlagscharakter, Inhaltsguards und der Schreibschutz archivierter
      Stände bleiben unverändert.
    tests:
      - apps/web/src/app/staff/(protected)/clients/[id]/subsumtion/__tests__/compose-editor-structure.test.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/subsumtion/__tests__/guards-tx.test.ts
    reviewer: Codex (automatisierter technischer UI-Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20260830-002
    date: '2026-08-30'
    paths:
      - apps/web/src/app/staff/(protected)/clients/[id]/subsumtion/new/page.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/subsumtion/subsumtion-document.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/subsumtion/__tests__/compose-editor-structure.test.ts
    rule_ids:
      - RISK-AI-SUGGESTION-001
    reason: >-
      Der Anlagemodus nutzt ausschließlich eine größere Schreibfläche und den
      bereits in der Wissensdatenbank verwendeten Kartenaufbau. Editorinhalt,
      Plaintext-Serialisierung, Dokumentimport, Analyse-Action, Engine-Eingaben,
      Vorschlagscharakter und gespeicherte Ergebnisse bleiben unverändert.
    tests:
      - apps/web/src/app/staff/(protected)/clients/[id]/subsumtion/__tests__/compose-editor-structure.test.ts
    reviewer: Codex (automatisierter technischer UI-Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20260830-001
    date: '2026-08-30'
    paths:
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/owner-actions.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/person-general-form.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/person-general-conflict.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/__tests__/actions.test.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/__tests__/person-general-conflict.test.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/__tests__/ui-state.test.ts
    rule_ids:
      - GWG-BENEFICIAL-OWNERS-001
      - GWG-IDENTIFICATION-EVIDENCE-001
      - GWG-REPRESENTATIVE-AUTHORITY-001
    reason: >-
      Die bestehende CAS-Sperre für parallel geänderte allgemeine
      Personenangaben bleibt unverändert fail-closed. Der Konfliktpfad liefert
      dem Staff-Formular zusätzlich den aktuellen Lesestand und seine Revision;
      das UI aktualisiert die Serveransicht automatisch, übernimmt neue Werte
      ausschließlich für lokal unberührte Felder und bewahrt bewusste Eingaben
      für eine erneute Prüfung und Speicherung. Rollen-, Identitäts-,
      Verifikations-, Audit- und Persistenzentscheidungen ändern sich nicht.
    tests:
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/__tests__/actions.test.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/__tests__/person-general-conflict.test.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/__tests__/ui-state.test.ts
    reviewer: Codex (automatisierter technischer UI-Abgleich ohne fachliche Freigabe)
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
  - id: FK-EXC-20260827-003
    date: '2026-08-27'
    paths:
      - apps/web/src/app/portal/(protected)/forms/[id]/filler.tsx
      - apps/web/src/app/staff/(protected)/admin/dsgvo-retention/anonymize-button.tsx
      - apps/web/src/app/staff/(protected)/admin/dsgvo/[id]/page.tsx
      - apps/web/src/app/staff/(protected)/admin/gwg-retention/delete-button.tsx
      - apps/web/src/app/staff/(protected)/admin/privacy/consent-options-editor.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/decision-forms.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/invite-section.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/start-check-cycle-form.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/notices/filings/filings-section.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/subsumtion/marking-panel.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/subsumtion/norm-ref-editor.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/subsumtion/research-composer.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/subsumtion/subsumtion-workspace.tsx
    rule_ids:
      - ACCESS-CLIENT-MODE-001
      - DSGVO-CONSENT-SNAPSHOT-001
      - DSGVO-MANDATE-ANONYMIZATION-001
      - DSGVO-REQUEST-EVIDENCE-001
      - FORM-PRESUBMIT-UPLOAD-001
      - GWG-RETENTION-DESTRUCTION-001
      - GWG-REVERIFICATION-VALIDITY-001
      - GWG-RISK-REVIEW-001
      - GWG-SELF-ONBOARDING-001
      - POA-SIGNER-RETENTION-001
      - RISK-AI-SUGGESTION-001
      - RISK-ARCHIVE-SNAPSHOT-001
      - RISK-CATALOG-FOUR-EYES-001
      - RISK-EXTERNAL-ANONYMIZATION-001
    reason: >-
      Die UI-Konsolidierung ersetzt native Browserdialoge und verstreute
      Portal-Overlays durch die gemeinsame Modal-Infrastruktur und vereinheitlicht
      Checkbox- sowie Layoutklassen. Bestätigungstexte, Form-Submitter,
      Server-Actions, Eingaben, Rollen- und Statusprüfungen sowie gespeicherte
      Ergebnisse bleiben unverändert; die Änderung betrifft ausschließlich
      Bedienung, Fokusführung und Darstellung.
    tests:
      - apps/web/src/components/ui/__tests__/modal-consolidation.test.ts
      - apps/web/src/app/portal/(protected)/forms/[id]/__tests__/actions.test.ts
      - apps/web/src/app/staff/(protected)/admin/dsgvo-retention/__tests__/poa-signer-actions.test.ts
      - apps/web/src/app/staff/(protected)/admin/gwg-retention/__tests__/actions.test.ts
      - apps/web/src/app/staff/(protected)/admin/privacy/__tests__/actions.test.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/__tests__/actions.test.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/__tests__/decision-forms.test.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/subsumtion/__tests__/guards-tx.test.ts
      - apps/web/src/server/risk/__tests__/catalog-review.test.ts
      - apps/web/src/server/risk/__tests__/research-payload.test.ts
    reviewer: Codex (automatisierter technischer UI-Abgleich ohne fachliche Freigabe)
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
  - id: FK-EXC-20260826-001
    date: '2026-08-26'
    paths:
      - packages/db/prisma/migrations/20260826021500_kb_article_attachments/migration.sql
    rule_ids:
      - ACCESS-TENANT-RLS-001
      - DOC-RETENTION-CLASS-001
      - DOC-VERSION-IMMUTABILITY-001
    reason: >-
      Die Migration ergänzt ausschließlich eine mandantengetrennte Zuordnung
      zwischen Wissensartikeln und bereits nach den bestehenden Dokumentregeln
      gespeicherten Dokumenten. Sie erzwingt RLS, verändert aber weder
      Klassifikations- und Aufbewahrungsentscheidung noch Versionierung,
      Object-Lock oder die Auslieferungsbedingungen bestehender Dokumente.
    tests:
      - packages/db/src/__tests__/knowledge-attachment-migration.test.ts
      - apps/web/src/app/staff/(protected)/knowledge/__tests__/editor-structure.test.ts
    reviewer: Codex (automatisierter technischer Abgleich ohne fachliche Freigabe)
  - id: FK-EXC-20260824-001
    date: '2026-08-24'
    paths:
      - packages/tax/src/legal-assessments.ts
      - packages/mail/src/dispatch.ts
      - apps/web/src/server/fristen/kontrollbuch.ts
      - apps/web/src/app/staff/(protected)/tax-deadlines/group/page.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/notices/actions.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/notices/data-retrieval.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/notices/notice-assessment.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/notices/page.tsx
      - apps/web/src/app/staff/(protected)/clients/[id]/notices/transitions.ts
      - apps/worker/src/jobs/tax-deadline-notification.ts
    rule_ids:
      - TAX-NOTICE-APPEAL-001
      - TAX-NOTICE-DATARETRIEVAL-001
      - TAX-DEADLINE-WORKDAY-001
      - TAX-CONTROL-STATUS-001
      - TAX-DEADLINE-AUTOREQUEST-001
      - ACCESS-NOTIFICATION-RECIPIENT-001
    reason: >-
      Prettier ändert ausschließlich das Layout; die Complexity-Korrektur
      verschiebt vorhandene Prüfungen, Abbildungen und JSX-Blöcke unverändert
      in lokale Helfer oder Komponenten. Eingaben, Berechnungen,
      Statusentscheidungen, Empfängerauswahl, Persistenz und Ergebnisse bleiben
      unverändert.
    tests:
      - packages/tax/src/__tests__/legal-assessments.test.ts
      - packages/mail/src/__tests__/dispatch-profile-context.test.ts
      - apps/web/src/server/fristen/__tests__/kontrollbuch.test.ts
      - apps/web/src/app/staff/(protected)/tax-deadlines/__tests__/actions.test.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/notices/__tests__/data-retrieval.test.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/notices/__tests__/notice-assessment.test.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/notices/__tests__/notice-transition.test.ts
      - apps/worker/src/jobs/__tests__/tax-deadline-notification.test.ts
    reviewer: Codex (automatisierter technischer Refactoring-Abgleich)
  - id: FK-EXC-20260827-006
    date: '2026-08-27'
    paths:
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/invite-section.tsx
    rule_ids:
      - GWG-SELF-ONBOARDING-001
    reason: >-
      Die Einladung wird ohne fachliche Änderung in den neuen Seitenaufbau
      eingebettet. Das Zurückziehen verwendet den gemeinsamen App-Dialog statt
      des nativen Browserdialogs; Ziel-ID, Server-Action, Bestätigungstext und
      Wirkung der Aktion bleiben unverändert.
    tests:
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/__tests__/gwg-layout.test.ts
      - apps/web/src/app/staff/(protected)/clients/[id]/gwg/__tests__/actions.test.ts
    reviewer: Codex (automatisierter technischer UI-Abgleich ohne fachliche Freigabe)
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

- 2026-10-06: `FK-EXC-20261006-021` dokumentiert eigene Server-Services für
  Anlage, Versand und Widerruf von Vollmachten. Prüfungen, Snapshot und Audit
  bleiben unverändert.

- 2026-10-06: `FK-EXC-20261006-020` dokumentiert die Umklassifizierung über
  einen gemeinsamen Dokument-Service. Sperren, Re-Store und Audit bleiben
  unverändert.

- 2026-10-06: `FK-EXC-20261006-019` dokumentiert die plattformunabhängige
  Zeilenenden-Normalisierung im Quelltext-Test des GwG-Einladungs-Lifecycles.
  Einladungslogik und Prüfaussagen bleiben unverändert.

- 2026-10-06: `FK-EXC-20261006-018` dokumentiert Bulk-Aktionen des
  Dokumenten-Explorers als eine Server Action je Auswahl. Zugriffsprüfung,
  Freigaberegeln und Audit je Dokument bleiben unverändert.

- 2026-10-06: `FK-EXC-20261006-017` dokumentiert binäre Uploads über Server
  Actions mit zentralen Grenzen je Upload-Art. Prüfungen und Aufbewahrung
  bleiben unverändert.

- 2026-10-06: `FK-EXC-20261006-016` dokumentiert journalisierte Speicherabsichten
  vor jedem direkten Upload. Prüfungen und Aufbewahrung bleiben unverändert;
  der Umsetzungstext von DOC-UPLOAD-JOURNAL-001 ist nachzuziehen.

- 2026-10-06: `FK-EXC-20261006-015` dokumentiert die ausdrückliche
  Registrierung der Mail-Integrationen und die typisierte SSRF-Grenze.
  Versand und Zeitstempelung bleiben unverändert.

- 2026-10-06: `FK-EXC-20261006-014` dokumentiert den Versand der
  Mandanten-Mails über eine Outbox mit Wiederholung und Zustellstatus.
  Inhalte und Empfänger bleiben unverändert.

- 2026-10-06: `FK-EXC-20261006-013` dokumentiert zentrale Bezeichnungen, eine
  gemeinsame Schutzstufen-Regel und die korrigierte GwG-Kennzeichnung der
  Dokument-Detailseite.

- 2026-10-06: `FK-EXC-20261006-012` dokumentiert die zentrale Einordnung von
  Action-Fehlern. Prüfungen, Berechtigungen und Audit-Ereignisse bleiben
  unverändert.

- 2026-10-06: `FK-EXC-20261006-011` dokumentiert verschobene UI-Module und
  die abgesicherten Schichtgrenzen der Web-App. Fachlogik bleibt
  unverändert.

- 2026-10-06: `FK-EXC-20261006-010` dokumentiert das in Quell-Adapter zerlegte
  Kontrollbuch mit seitenweiser Fristenseite. Fristberechnung und
  Kontrollpflichten bleiben unverändert.

- 2026-10-06: `FK-EXC-20261006-009` dokumentiert den entfernten veralteten
  Fristen-Rechenkern und den Feiertags-Cache. Fristergebnisse bleiben
  unverändert; der Regeltext zu TAX-NOTICE-APPEAL-001 ist nachzuziehen.

- 2026-10-06: `FK-EXC-20261006-008` dokumentiert entfernte ungenutzte
  Server-Actions und Komponenten. Erreichbare Abläufe und Audit-Ereignisse
  bleiben unverändert.

- 2026-10-06: `FK-EXC-20261006-007` dokumentiert die E2E-Suite gegen den
  Standalone-Produktionsserver ohne Testwiederholungen. Umfang und Nachweis
  der Suite bleiben unverändert.

- 2026-10-06: `FK-EXC-20261006-006` dokumentiert das gemeinsame Dokument-DTO,
  serverseitige Ordner- und Suchfilter und den gemeinsamen Löschdialog.
  Zugriffsprüfung und Audit bleiben unverändert.

- 2026-10-06: `FK-EXC-20261006-005` dokumentiert die gemeinsame
  Modul-Registry und die Modulprüfung je Seite. Fachabläufe und
  Zugriffsregeln bleiben unverändert.

- 2026-10-06: `FK-EXC-20261006-004` dokumentiert den gemeinsamen Dienst für
  Rechnungsentwürfe aller drei Pfade. Gültige Rechnungen bleiben unverändert;
  die Rückdatierungsgrenze bleibt Prüffrage.

- 2026-10-06: `FK-EXC-20261006-003` dokumentiert gemeinsame Prüfungen und
  Fehlerantworten der E-Rechnungs-Downloads. Archivierung gültiger
  Rechnungen bleibt unverändert.

- 2026-10-06: `FK-EXC-20261006-002` dokumentiert den einheitlich geprüften
  Lesepfad für gespeicherte Objekte. Zugriffsprüfungen und Inhalte
  konsistenter Daten bleiben unverändert.

- 2026-10-06: `FK-EXC-20261006-001` dokumentiert gemeinsame Implementierungen
  für Sitzungswiderruf, GwG-Löschfristen und Backup-Lauf in Web und Worker.
  Fristlogik und Review-Queue bleiben unverändert.

- 2026-10-05: `FK-EXC-20261005-044` dokumentiert die gemeinsame Regel für
  offene Portal-Formulare und die Startseite ohne Rückfrage-Anforderungen.
  Antwortrechte und Fristen bleiben unverändert.

- 2026-10-05: `FK-EXC-20261005-043` dokumentiert Renovate statt Dependabot
  und kommentierte Action-Pins in den Workflows. Pins und Nachweise bleiben
  unverändert.

- 2026-10-05: `FK-EXC-20261005-042` dokumentiert die parallelen CI-Jobs
  auf eigenen PostgreSQL-Ports und den zusammengelegten E2E-Job. Prüf- und
  Nachweisschritte bleiben erhalten.

- 2026-10-05: `FK-EXC-20261005-041` dokumentiert Node aus `.nvmrc` und
  Installationen mit geprüften Install-Skripten in allen Workflows.
  Release-Gates und Nachweise bleiben unverändert.

- 2026-10-05: `FK-EXC-20261005-040` dokumentiert die Altbestandstests
  für Migration 034 und 041 als SQL-Dateien in jedem CI-Lauf. Geprüfte
  Erwartungen bleiben unverändert.

- 2026-10-05: `FK-EXC-20261005-039` dokumentiert den zusammengelegten
  ESLint-Lauf mit Bulk-Suppressions. Release-Gates und Testnachweise bleiben
  unverändert.

- 2026-10-05: `FK-EXC-20261005-038` dokumentiert die CSS-Klasse der
  Portal-Kopfleiste. Zugriff und Tenant-Kontext bleiben unverändert.

- 2026-10-05: `FK-EXC-20261005-037` dokumentiert das gestreamte
  Mandanten-Cockpit in drei Transaktionen. Zugriffsprüfung und
  Wiedervorlagen-Abfrage bleiben unverändert.

- 2026-10-05: `FK-EXC-20261005-036` dokumentiert die per groupBy gezählte
  Monatsansicht der Steuertermine und ihren DB-Test im CI. Fristberechnung
  und Sichtbarkeit bleiben unverändert.

- 2026-10-05: `FK-EXC-20261005-035` dokumentiert gezählte Kennzahlen der
  Steuertermine und der Mandantenliste. Sichtbarkeitsregeln und
  Fristberechnung bleiben unverändert.

- 2026-10-05: `FK-EXC-20261005-034` dokumentiert bcryptjs als externes
  Serverpaket für den Passwort-Pool. Mail-Anhangsprüfung bleibt unverändert.

- 2026-10-05: `FK-EXC-20261005-033` dokumentiert die FIDO-Metadatenprüfung
  als Hintergrundjob mit gespeichertem Snapshot. Prüfkette und fail-closed
  Verhalten der Hardware-Anmeldung bleiben erhalten.

- 2026-10-05: `FK-EXC-20261005-032` dokumentiert die Ablage der
  PDF-Schriften außerhalb des öffentlichen Verzeichnisses. Schriften und
  erzeugte PDFs bleiben unverändert.

- 2026-10-05: `FK-EXC-20261005-031` dokumentiert die kontextgebundene
  Secret-Box (v3) mit Schlüsselbund und Re-Wrap. Postfachabruf, Versand und
  Audit-Kette bleiben fachlich unverändert.

- 2026-10-05: `FK-EXC-20261005-030` dokumentiert die beim Upload gezählte
  Seitenzahl von PDF-Ausweisquellen. Annahme- und Ablehnungsentscheidungen
  bleiben unverändert.

- 2026-10-05: `FK-EXC-20261005-029` dokumentiert die Textextraktion der
  Subsumtionsakte im begrenzten Worker-Thread. Anhangsregeln und
  Analyseablauf bleiben unverändert.

- 2026-10-05: `FK-EXC-20261005-028` dokumentiert den Update-Check als
  Hintergrundjob und die COUNT-Kacheln der Admin-Übersicht. Fristlogik und
  Review-Queues bleiben unverändert.

- 2026-10-05: `FK-EXC-20261005-027` dokumentiert die seitenweise
  Jahreswechsel-Übersicht und den gesammelten Rollout. Kampagnenlogik und
  Rollout-Grenze bleiben unverändert.

- 2026-10-05: `FK-EXC-20261005-026` dokumentiert die mandantenbezogene
  Materialisierung beim Speichern eines Zeitplans. Fristberechnung und
  Anforderungsentscheidungen bleiben unverändert.

- 2026-10-05: `FK-EXC-20261005-025` dokumentiert das Laden der
  Layout-Einstellungen in einer Transaktion und getrennt bemessene Pools.
  Einstellungen, Modulentscheidungen und Zugriffsregeln bleiben unverändert.

- 2026-10-05: `FK-EXC-20261005-024` dokumentiert, dass Aufträge für erledigte
  Wiedervorlagen nur Kennungen tragen und befristet gespeichert werden.
  Empfänger und Inhalt bleiben unverändert.

- 2026-10-05: `FK-EXC-20261005-023` dokumentiert das Entfernen doppelter
  Fehler-Handler und protokollierte Queue-Entfernungen. Joblogik und Ergebnisse
  bleiben unverändert.

- 2026-10-05: `FK-EXC-20261005-022` dokumentiert den gemeinsamen
  Benachrichtigungspfad des Workers mit Textbereinigung. Empfängerregeln und
  Inhalte bleiben unverändert.

- 2026-10-05: `FK-EXC-20261005-021` dokumentiert Archivierung und
  Orphan-Bereinigung mit Zeitbudget statt fester Mengen. Prüfungen und
  Aufbewahrungsregeln bleiben unverändert.

- 2026-10-05: `FK-EXC-20261005-020` dokumentiert den vorbereiteten
  EU-Aliasabgleich und Hinweise nur bei Treffern beziehungsweise als
  Sammelhinweis. Trefferlogik und Freigabesperren bleiben unverändert.

- 2026-10-05: `FK-EXC-20261005-019` dokumentiert die abschnittsweise tägliche
  Erinnerungsrunde mit gebündelter Zugriffsprüfung. Fälligkeiten, Empfänger
  und Inhalte bleiben unverändert.

- 2026-10-05: `FK-EXC-20261005-018` dokumentiert die gemeinsame Wahl der
  Zeitstempelstelle und das Nachstempeln ausstehender Archivsegmente.
  Segmentgrenzen, Kettenanker und Datei-Hash bleiben unveränderlich.

- 2026-10-05: `FK-EXC-20261005-017` dokumentiert das abschließende Verbuchen
  nicht weitergeleiteter n8n-Workflow-Übergaben. Workflow-Status und
  Ereignisinhalte bleiben unverändert.

- 2026-10-05: `FK-EXC-20261005-016` dokumentiert, dass Ablaufwarnungen nur an
  aktive, zugriffsberechtigte Zuständige und sonst an Admins und Partner gehen.
  Fristen und Inhalte bleiben unverändert.

- 2026-10-05: `FK-EXC-20261005-015` dokumentiert die absolute Obergrenze von
  24 Stunden ab Anmeldung für alle Sitzungserneuerungen. Widerrufs- und
  Mandatsprüfungen bleiben unverändert.

- 2026-10-05: `FK-EXC-20261005-014` dokumentiert die einmalige Passwortprüfung
  mit Einmal-Ticket für den zweiten Anmeldeschritt. Prüfungen, Limits und Audit
  bleiben unverändert.

- 2026-10-05: `FK-EXC-20261005-013` dokumentiert einheitliche Antworten und
  genau einen Passwortvergleich je Anmeldeversuch. Limits und Sperrlogik
  bleiben unverändert.

- 2026-10-05: `FK-EXC-20261005-012` dokumentiert die zentrale Session-Fabrik
  je Oberfläche und das Entfernen des ungenutzten Portal-Credentials-Logins.
  Widerrufs- und Mandatsprüfungen bleiben unverändert.

- 2026-10-05: `FK-EXC-20261005-011` dokumentiert die Zuordnung von
  Onboarding-Uploads über den Fremdschlüssel statt über das JSON-Array der
  Einladung. Zulässige Uploads und Verwerfen-Regeln bleiben unverändert.

- 2026-10-05: `FK-EXC-20261005-010` dokumentiert CHECK-Constraints für zwei
  bisher ungeprüfte Statusfelder. Schreibpfade und Statusübergänge bleiben
  unverändert.

- 2026-10-05: `FK-EXC-20261005-009` dokumentiert das Entfernen von 18
  redundanten Indizes. Unique-Constraints, Daten und Regeln bleiben
  unverändert.

- 2026-10-05: `FK-EXC-20261005-008` dokumentiert drei Fremdschlüssel-Indizes
  und die CI-Prüfung auf Fremdschlüssel ohne führenden Index. Regeln und
  Datenzugriffe bleiben unverändert.

- 2026-10-05: `FK-EXC-20261005-007` dokumentiert, dass alle RLS-Policies den
  Tenant-Kontext über `app.current_tenant_id()` lesen. Sichtbare Zeilen
  bleiben bei gesetztem Kontext identisch.

- 2026-10-05: `FK-EXC-20261005-006` dokumentiert zwei Leseindizes auf
  `audit_log`. Hash-Kette, Inhalte und Leserechte bleiben unverändert.

- 2026-10-05: `FK-EXC-20261005-005` dokumentiert die zweistufige globale Suche
  über Trigramm-Kandidaten und anschließendes Laden unter RLS. Sichtbarkeit
  und Zugriffsfilter bleiben unverändert.

- 2026-10-05: `FK-EXC-20261005-004` dokumentiert die Mandantensichtbarkeit als
  Relationsfilter statt NOT-IN-Listen. Sichtbare Zeilen und
  Zugriffsentscheidungen bleiben unverändert.

- 2026-10-05: `FK-EXC-20261005-003` dokumentiert, dass ein Worker-Job
  pausierte Workflows mit erreichtem Termin fortsetzt statt das Rendern der
  Workflow-Seite. Statusregeln und Pausenschutz bleiben unverändert.

- 2026-10-05: `FK-EXC-20261005-002` dokumentiert, dass KI-Aufträge der
  Subsumtion keinen Sachverhalt mehr in Redis tragen und befristet gespeichert
  werden. Vorschlagslogik und Archivstand bleiben unverändert.

- 2026-10-05: `FK-EXC-20261005-001` dokumentiert die protokollierte
  Fehlerbehandlung in Worker, Web und Mailversand. Prüfregeln, Fristen und
  Zustellklassifikation bleiben unverändert.

- 2026-10-04: `FK-EXC-20261004-018` dokumentiert SQL-basierte
  Zuordnungsvorschläge und die Mandantensuche je Anhang im Posteingang.
  Import und Ablage bleiben unverändert.

- 2026-10-04: `FK-EXC-20261004-017` dokumentiert die serverseitige
  Mandantensuche in allen Mandantenauswahlen statt gekappter oder
  vollständiger Bestandslisten. Sichtbarkeits- und Einschlussregeln bleiben
  unverändert.

- 2026-10-04: `FK-EXC-20261004-016` dokumentiert die gemeinsame
  serverseitige Mandantensuche, die die eigene Such-Action der
  Anfrageerfassung ersetzt. Sichtbarkeitsregel und Anfrageablauf bleiben
  unverändert.

- 2026-10-04: `FK-EXC-20261004-015` dokumentiert die Rückgabe von Fehlern an
  das Formular für die übrigen Server-Actions und die Auswertung bisher
  verworfener Prüfergebnisse. Prüfregeln, Berechtigungen und Audit bleiben
  unverändert.

- 2026-10-04: `FK-EXC-20261004-014` dokumentiert, dass die Kern-Formulare
  (Bescheide, Fristen, DSGVO, Mandantenanlage, Rechnungsstatus,
  Vollmachtswiderruf) Fehler an das Formular zurückgeben statt sie zu werfen.
  Prüfregeln, Berechtigungen und Audit bleiben unverändert.

- 2026-10-04: `FK-EXC-20261004-013` dokumentiert konto- und E-Mail-gebundene
  Login-Limits ohne Client-IP, den Verzicht auf die harte Kontosperre ohne
  vertrauenswürdige IP und die IP-Ermittlung vom rechten Ende von
  `X-Forwarded-For`. Token-, OTP- und Signaturgrenzen bleiben unverändert.

- 2026-10-04: `FK-EXC-20261004-012` dokumentiert, dass CI die GwG-
  Schutzinvarianten des Deploy-Gates jetzt gegen die echte, migrierte
  Datenbank prüft. Prüfinhalt und Deploy-Verhalten bleiben unverändert.

- 2026-10-04: `FK-EXC-20261004-011` dokumentiert, dass jede Mandanten-
  Detailseite die bestehende Zugriffsentscheidung selbst prüft statt nur im
  Layout. Entscheidungstabelle und Seiteninhalte bleiben unverändert.

- 2026-10-04: `FK-EXC-20261004-010` dokumentiert eingebettete Unicode-Schriften
  in neu erzeugten ZUGFeRD-PDFs und die genauere Breitenmessung des
  gemeinsamen PDF-Schrifthelfers. Archivierte Rechnungsfassungen, Beträge und
  XML bleiben unverändert.

- 2026-10-04: `FK-EXC-20261004-009` dokumentiert die Unicode-Schriften im
  PDF-Export der Subsumtionsanalyse. Bisher verstümmelte Zeichen erscheinen
  korrekt, nicht darstellbare sperren den Export; Inhalt und Zugriff bleiben
  unverändert.

- 2026-10-04: `FK-EXC-20261004-008` dokumentiert die gestreamte Erzeugung von
  Sammel-Download und DATEV-Belegexport. Auswahl, Auslieferbarkeitsprüfung,
  Abrufnachweis und Dateiinhalte bleiben unverändert.

- 2026-10-04: `FK-EXC-20261004-007` dokumentiert den gebündelten
  Abrufnachweis `document.download.bulk` für Sammel-Downloads und die
  einfache Protokollierung von Vorschauen beim Byte-Abruf. Umfang des
  Nachweises und Zugriffsentscheidungen bleiben unverändert; die neue
  Nachweisform ist fachlich noch zu bestätigen.

- 2026-10-04: `FK-EXC-20261004-006` dokumentiert, dass ZIP-Exporte ihren
  Abrufnachweis erst nach Größen-, Eintrags- und Slot-Prüfung schreiben.
  Abgelehnte Exporte erscheinen nicht mehr als Abruf; Audit-Inhalt und
  Zugriffsprüfung bleiben unverändert.

- 2026-10-04: `FK-EXC-20261004-005` dokumentiert die Zusammenführung von
  Kettendurchlauf und Siegelprüfung im EvidenceService. Prüfergebnisse,
  Bruchmeldungen und der Umfang der Recovery-Prüfung bleiben unverändert.

- 2026-10-04: `FK-EXC-20261004-004` dokumentiert die schwächere, für den
  Paar-Guard ausreichende Sperre FOR KEY SHARE. Die Paarinvariante und die
  Serialisierung mit Löschung und FOR UPDATE bleiben unverändert.

- 2026-10-04: `FK-EXC-20261004-003` dokumentiert, dass der DB-CI-Job den
  katalogisierten Nachweis `service-db.test.ts` jetzt tatsächlich ausführt.
  Regeln und Produktverhalten bleiben unverändert.

- 2026-10-04: `FK-EXC-20261004-002` dokumentiert das zusätzliche Logging
  bekannter Prisma-Fehler in `toActionError`. Rückgaben, UI-Meldungen und
  Zugriffsentscheidungen bleiben unverändert.

- 2026-10-04: `FK-EXC-20261004-001` dokumentiert die Umstellung der
  RLS-Lookup-Funktionen für Benachrichtigungen, Lohnakten und Mandatsartefakte
  auf indexfähige UUID-Vergleiche. Treffermengen, Policies und Grants bleiben
  unverändert; keine fachliche Freigabe wurde erteilt oder verändert.

- 2026-09-10: `FK-EXC-20260910-001` dokumentiert den reinen
  Vitest-Sicherheitswechsel im von `GWG-SCREENING-001` referenzierten
  Tax-Paketmanifest. Fachlogik, Regelinhalt und fachlicher Prüfstatus
  bleiben unverändert.

- 2026-09-07: Dritter gemeinsamer Qualitätsdurchlauf. `AUDIT-HASH-CHAIN-001`
  und `AUDIT-ARCHIVE-001` erhalten vollständige Bindung eigener JSON-Schlüssel
  einschließlich `__proto__`; historische Sonderfälle werden ausdrücklich
  dokumentiert und niemals umgeschrieben. `BWA-IMPORT-MAPPING-001`,
  `BWA-PROJECTION-001` und `BWA-TAX-ESTIMATE-001` korrigieren DATEV-Positionen,
  fehlende Werte, Vorsteuerbasis und die belegbare automatische Planvorbelegung.
  `POA-LIFECYCLE-001` und `ACCESS-NOTIFICATION-RECIPIENT-001` binden Ablauf,
  Nachweis und aktuelle Empfänger an dieselbe Transaktion.
  `DOC-UPLOAD-JOURNAL-001`, `DOC-VERSION-IMMUTABILITY-001` und
  `DOC-PORTAL-SHARING-001` sperren die Auslieferung nicht vollständig
  finalisierter Versionen. Die vorhandenen Zugriffsregeln
  `ACCESS-TENANT-RLS-001` und `ACCESS-CLIENT-MODE-001` bleiben bei der
  konkurrierenden Terminabsage und den DATEV-Transportkorrekturen erhalten.
  `FK-EXC-20260907-004` dokumentiert die technische Editorreparatur.
  Restore erhält zusätzlich eine obligatorische Prüfung effektiver Rollen,
  erreichbarer privilegierter Rollen, Audit-Schreibsperren und RLS vor jedem
  Erfolg (`ACCESS-TENANT-RLS-001`, `AUDIT-HASH-CHAIN-001`). Fehler verhindern
  die Dienstfreigabe; sie rollen den bereits angewendeten Restore nicht zurück.
  Keine fachliche Freigabe wurde erteilt oder verändert.

- `FK-EXC-20260830-012` — verhaltensneutrale Komponenten- und
  Helferextraktionen zum Integrationsabschluss; Fachprüfungen und
  Speicherreihenfolge bleiben unverändert.
- `FK-EXC-20260830-011` — kontrastgeprüfter Fokus-Token für die
  Gruppen-Fristenauswahl bei unveränderter Fachlogik.
- `FK-EXC-20260830-010` — einzeln speicherbare Optionen für Schriftgröße,
  Zeilenabstand, Kontrast und Bewegungsreduktion ohne fachliche Regelwirkung.
- `FK-EXC-20260830-009` — persönliche Anzeigepräferenzen an bestehenden
  Benutzerprofilen; Tenant-Isolation und fachliche Entscheidungen unverändert.
- `FK-EXC-20260830-008` — zugängliche Symbol-Links und korrekte Semantik für
  die angezeigte Rechnungsnummer bei unveränderten Dokument-, Rechnungs- und
  Vollmachtsregeln.
- `FK-EXC-20260830-007` — Tastatur- und Fokussemantik für Subsumtions-Toolbar
  und Exportpanel bei unveränderten Editor-, Export- und Archivregeln.
- `FK-EXC-20260830-006` — verknüpfte Formularlabels, zugängliche Symbol-Links
  und Kontrastfarben bei unveränderten Bescheid-, Anforderungs- und
  Fristenregeln.
- `FK-EXC-20260830-005` — zugängliche Namen, Formularbeziehungen und
  Statusankündigungen bei unveränderter Audit-, DSGVO- und
  Einwilligungslogik.
- `FK-EXC-20260830-004` — Labels, Live-Status und Kontrast im GwG-Onboarding
  und in der Risikomaske bei unveränderter Einreichungs-, Score- und
  Freigabelogik.
- `FK-EXC-20260830-003` — feste und optional schwebende Editorleiste sowie
  größere Subsumtions-Arbeitsfläche und kontrastreiche interne Notizen bei
  unveränderten Fach-, Archiv- und Kanalregeln.
- `FK-EXC-20260830-002` — größere, zusammenhängende Schreibfläche für neue
  Subsumtionen bei unveränderter Analyse-Action und Plaintext-Grundlage.
- `FK-EXC-20260830-001` — automatischer Abgleich parallel geänderter
  GwG-Personenangaben bei unveränderter CAS-Sperre, Persistenz- und
  Verifikationslogik.
- `FK-EXC-20260827-001` — zentrale Queue-Namen ersetzen identische Literale in
  Worker-Registrierungen; Jobverarbeitung und Fachentscheidungen bleiben
  unverändert.
- `FK-EXC-20260827-002` — gemeinsame Dokumentauslieferung und
  Tenant-Setting-Persistenz bei unveränderten Zugriffs-, Audit- und
  Einstellungsregeln.
- `FK-EXC-20260827-003` — zentrale App-Dialoge und einheitliche UI-Klassen bei
  unveränderten Server-Actions und Fachentscheidungen.
- `FK-EXC-20260827-004` — Entfernung des fachlich unverbundenen State-Builders
  einschließlich seiner drei Datenbanktabellen.
- `FK-EXC-20260827-005` — atomare Wiederherstellung der bereits dokumentierten
  ACL-, Nachweis-, Empfänger- und RLS-Guards für zwei exakt attestierte
  Pre-Release-Migrationsstände.
- `FK-EXC-20260826-001` — mandantengetrennte Verknüpfung von
  Wissensanhängen mit dem bestehenden Dokumentenspeicher; keine Änderung der
  Klassifikations-, Aufbewahrungs- oder Unveränderbarkeitsregeln.
- `FK-EXC-20260824-001` — mechanische Prettier-Formatierung und reine
  Helper-/Komponentenextraktion in bereits dokumentierten Frist-, Bescheid- und
  Benachrichtigungsabläufen; keine Regelwirkung.
- `FK-EXC-20260827-006` — Einbettung der GwG-Einladung in den neuen Seitenaufbau
  und gemeinsamer Bestätigungsdialog bei unveränderter Einladungslogik.

## 2026-09-07 — Wiedervorlagen als Tickets

Neue Produktregel `REMINDER-TICKET-001`: kanzleiweite Nummern, ausdrückliche
Erwähnungen mit Rückverweisen und getrenntes Archiv erledigter Aufgaben.
Die Erweiterung des aktiven Katalog-Scope von 80 auf 81 Regeln ist ausdrücklich
in `SCOPE.md` erfasst. Keine fachliche Freigabe wird behauptet oder geändert.

Nummern werden für sämtliche Erzeuger atomar in der Datenbank vergeben;
Bestands-UUIDs bleiben erhalten. Rechercheherkunft wird unabhängig vom
aktuellen Delegationszeiger gespeichert. Das Archiv verlangt Abschlusszeit
und abschließende Person, bleibt schreibgeschützt und bewahrt Verweise.
Wiederherstellung aus dem Ticketarchiv behält den Arbeitsabschluss.

Die Berechtigung eines Verweises wird bei Erzeugung und Anzeige geprüft;
Ketten und Anhänge verwenden ebenfalls aktuelle Mandanten- bzw. interne
Beteiligungsrechte. Ein gemeinsamer Row-Lock verhindert, dass die endgültige
Anhangzuordnung die Archivierung überholt. Die Restore-Sicherheitsabnahme
prüft die Owner-Rechte des Zählers und die nur ergänzbaren Referenzkanten.

Technische Nachweise stehen in der neuen Regel und unter
`docs/reviews/2026-09-07-wiedervorlagen-tickets.md`. Fachliche Ergebnisfreigaben,
Fristenkontrolle und getrennte Aufbewahrungs-/Löschverfahren bleiben eigene
Entscheidungen.
