---
exceptions:
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
