---
id: ACCESS-STAFF-PERMISSION-001
title: Aktionsrechte getrennt vom Mandantenzugriff prüfen
domain: mandat-und-zugriff
rule_type: product_rule
jurisdiction: EU/DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Berufsträger Kanzleiorganisation
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: implemented
  summary: >-
    ADMIN und PARTNER besitzen die definierten Einzelrechte implizit. Andere
    Mitarbeiter benötigen den ausdrücklichen Grant; das Aktionsrecht wird
    zusätzlich und unabhängig von einem etwaigen Mandantenzugriff geprüft.
sources:
  - kind: product_documentation
    citation: Fachkatalog-Inventur, Einzelrechte und getrennte Gates
    path: docs/fachkatalog/SCOPE.md
    checked_at: '2026-08-24'
    primary: true
  - kind: product_documentation
    citation: Technische Modulbeschreibung Zugriffsschutz und Benutzerverwaltung
    path: docs/development/module/zugriffsschutz.md
    checked_at: '2026-08-24'
    primary: false
  - kind: official_law
    citation: Art. 32 Abs. 1 und 4 DSGVO
    url: https://eur-lex.europa.eu/eli/reg/2016/679/oj?locale=de
    checked_at: '2026-08-24'
    primary: false
code_refs:
  - apps/web/src/server/auth/rbac.ts
  - apps/web/src/server/actions/staff-action.ts
  - apps/web/src/lib/staff-permissions.ts
test_refs:
  - apps/web/src/server/auth/__tests__/rbac.test.ts
  - apps/web/src/server/actions/__tests__/staff-action.test.ts
  - apps/web/src/server/actions/__tests__/staff-action-policy.property.test.ts
feature_refs:
  - FEATURES.md
  - docs/development/module/zugriffsschutz.md
related_rules:
  - ACCESS-CLIENT-MODE-001
  - ACCESS-TENANT-RLS-001
tags:
  - rbac
  - einzelrechte
  - least-privilege
---

# ACCESS-STAFF-PERMISSION-001 — Aktionsrechte getrennt vom Mandantenzugriff prüfen

## Kurzfassung

Ein sichtbarer Mandant allein berechtigt nicht automatisch zu jeder Aktion.
TaxTronik prüft für die dafür eingerichteten Funktionen zusätzlich ein
Einzelrecht. ADMIN und PARTNER haben diese Rechte implizit; andere Mitarbeiter
benötigen einen expliziten Grant.

## Wann gilt die Regel?

Die Regel gilt nur für Actions, die über `staffActionGuard` oder `withStaff`
ein `requirePermission` verlangen. Der aktuelle Katalog umfasst
`CLIENT_CREATE`, `INVOICE_MANAGE`, `INVOICE_SEND` und `ABSENCE_DECIDE`. Andere
Funktionen folgen Rollen-, Mandanten- oder modulspezifischen Gates.

## Benötigte Angaben

- authentifizierte, aktive Staff-Session
- Rollen der Person
- aktuell geladene Grants
- für die Action verlangtes Einzelrecht
- gegebenenfalls zusätzlich Mandantenzugriff und Modulstatus

## Entscheidungslogik

| Wenn                                         | Dann                                          | Begründung                           |
| -------------------------------------------- | --------------------------------------------- | ------------------------------------ |
| keine Staff-Session                          | Action verweigern                             | Authentifizierung fehlt              |
| ADMIN oder PARTNER                           | definiertes Einzelrecht implizit erfüllen     | produktseitiges Rollenmodell         |
| sonstiger Mitarbeiter mit passendem Grant    | Permission-Gate passieren                     | ausdrücklich delegiertes Recht       |
| sonstiger Mitarbeiter ohne Grant             | Action verweigern                             | Least-Privilege im definierten Scope |
| Permission vorhanden, Mandantenzugriff fehlt | mandantengebundene Action trotzdem verweigern | getrennte, kumulative Gates          |
| Modul ist OFF                                | Action unabhängig vom Grant verweigern        | Betriebsmodus hat Vorrang            |

## Ausnahmen und Grenzfälle

Nicht jede Produktaktion besitzt ein Einzelrecht; das Modell ist keine
vollständige Berechtigungsmatrix. Ein Grant sagt nichts über fachliche
Qualifikation, interne Zeichnungsbefugnis oder Vier-Augen-Anforderungen aus.
ADMIN/PARTNER können nicht nach Einzelrechten eingeschränkt werden.

## Beispiele

### Normalfall

Ein EMPLOYEE darf einen nicht vertraulichen Mandanten im OPEN-Modus sehen und
besitzt `INVOICE_MANAGE`. Die Rechnungsbearbeitung ist erlaubt; ein Versand
bleibt ohne `INVOICE_SEND` gesperrt.

### Grenzfall

Eine Person besitzt `CLIENT_CREATE`, hat aber keinen Zugriff auf einen bereits
vertraulichen Mandanten. Das Einzelrecht ersetzt das Objekt-Gate nicht.

## Umsetzung in TaxTronik

`staff-permissions.ts` ist die typisierte Liste der vier Rechte.
`hasStaffPermission` implementiert den Rollen-Override und den Grant-Check.
`staffActionGuard` kombiniert Session, optionale Adminanforderung,
Einzelrecht und Modulstatus; mandantengebundene Actions müssen anschließend
zusätzlich das Client-Gate aufrufen.

## Bekannte Abweichungen und Grenzen

Die Implementierung ist im definierten Modell konsistent. Die aktuelle
Moduldokumentation nennt in ihrer Aufzählung jedoch nur die drei älteren
Rechte und lässt `CLIENT_CREATE` aus; Code und Katalog führen den tatsächlich
verfügbaren vierten Wert. Die Tests belegen die Guard-Logik, nicht die
fachliche Angemessenheit jeder Rechtezuordnung oder die Vollständigkeit aller
Call-Sites.

## Fachliche Prüffragen

- Welche Funktionen benötigen zusätzliche Einzelrechte oder Vier-Augen-Gates?
- Sollen ADMIN/PARTNER in bestimmten Bereichen ebenfalls explizit beschränkbar sein?
- Wer darf Grants vergeben und in welchem Turnus werden sie rezertifiziert?
- Ist die Kombination aus Rolle, Grant, Mandantenzugriff und Modulstatus verständlich dokumentiert?

## Technische Nachweise

Die Unit- und Property-Tests belegen die Wahrheitstabelle für Session,
Adminanforderung und Permission. RBAC-Tests belegen implizite Rechte und den
fail-closed-Fall ohne Session oder Grant. Sie prüfen keine vollständige
rollenfachliche Rezertifizierung.
