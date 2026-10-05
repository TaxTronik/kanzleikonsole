---
exceptions:
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
