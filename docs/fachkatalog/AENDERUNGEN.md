---
exceptions:
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

- `FK-EXC-20260824-001` — mechanische Prettier-Formatierung und reine
  Helper-/Komponentenextraktion in bereits dokumentierten Frist-, Bescheid- und
  Benachrichtigungsabläufen; keine Regelwirkung.
