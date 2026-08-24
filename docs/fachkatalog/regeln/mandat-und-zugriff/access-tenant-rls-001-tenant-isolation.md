---
id: ACCESS-TENANT-RLS-001
title: Tenantdaten mit Kontext und erzwungener Row-Level-Security isolieren
domain: mandat-und-zugriff
rule_type: product_rule
jurisdiction: EU/DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Datenschutzverantwortliche Kanzlei
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: implemented
  summary: >-
    Registrierte Tenant-Tabellen werden durch transaktionsgebundenen
    Tenantkontext, eine App-Rolle ohne BYPASSRLS sowie ENABLE/FORCE-RLS und
    Policies isoliert. Ein CI-Gate sucht nach neuen Tabellen ohne diesen
    Backstop; privilegierte Owner-Pfade bleiben gesondert zu kontrollieren.
sources:
  - kind: product_documentation
    citation: ADR 0002 — Doppelte Verteidigung durch RLS und App-Level-Tenancy
    path: docs/adr/0002-rls-und-app-level-tenancy.md
    checked_at: '2026-08-24'
    primary: true
  - kind: product_documentation
    citation: Architektur, Tenant-Trennung und Compliance-Mapping
    path: docs/architecture.md
    checked_at: '2026-08-24'
    primary: false
  - kind: official_law
    citation: Art. 5 Abs. 1 Buchst. f, Art. 25 und Art. 32 DSGVO
    url: https://eur-lex.europa.eu/eli/reg/2016/679/oj?locale=de
    checked_at: '2026-08-24'
    primary: false
  - kind: official_law
    citation: § 203 Abs. 1 Nr. 3, Abs. 3 und 4 StGB
    url: https://www.gesetze-im-internet.de/stgb/__203.html
    checked_at: '2026-08-24'
    primary: false
code_refs:
  - packages/db/src/tenant-context.ts
  - packages/db/prisma/schema.prisma
  - packages/db/prisma/migrations/20260623000000_iter42_force_rls/migration.sql
  - packages/db/scripts/verify-rls.ts
test_refs:
  - packages/db/src/__tests__/rls-cross-tenant.test.ts
feature_refs:
  - docs/architecture.md
  - docs/adr/0002-rls-und-app-level-tenancy.md
  - docs/development/module/zugriffsschutz.md
related_rules:
  - ACCESS-CLIENT-MODE-001
  - ACCESS-STAFF-PERMISSION-001
  - ACCESS-NOTIFICATION-RECIPIENT-001
tags:
  - rls
  - tenant-isolation
  - defense-in-depth
---

# ACCESS-TENANT-RLS-001 — Tenantdaten mit Kontext und erzwungener Row-Level-Security isolieren

## Kurzfassung

Anwendungszugriffe auf Tenantdaten laufen in einer Transaktion mit gesetztem
Tenant-, Akteur- und Akteurtyp-Kontext. PostgreSQL erzwingt auf den erfassten
Tabellen Row-Level-Security auch für den Tabellenowner der App-Rolle. Die
Schicht ist ein technischer Backstop gegen Cross-Tenant-Zugriffe, kein Ersatz
für Objektberechtigungen innerhalb einer Kanzlei.

## Wann gilt die Regel?

Die Regel gilt für die Rolle `taxtronik_app` und alle nicht ausdrücklich
ausgenommenen Tabellen im öffentlichen Schema. Owner-Verbindungen für
Migration, Setup und ausgewählte Systemprozesse können RLS umgehen und fallen
nicht allein unter diesen Schutz.

## Benötigte Angaben

- Tenant-ID
- Akteur-ID oder Systemkontext
- Akteurtyp STAFF, CLIENT_CONTACT oder SYSTEM
- App-Datenbankrolle ohne BYPASSRLS
- ENABLE/FORCE-RLS und mindestens eine Policy je geschützter Tabelle
- zusätzliche Parent-/Tenant-Paar-Constraints bei clientgebundenen Tabellen

## Entscheidungslogik

| Wenn                                                      | Dann                                                     | Begründung                                           |
| --------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------- |
| App-Zugriff startet                                       | Transaktion öffnen und Kontext lokal setzen              | Sessionvariablen dürfen nicht verbindungsweit leaken |
| Kontext fehlt oder Tenant stimmt nicht                    | Zeile nicht sichtbar beziehungsweise Mutation blockieren | fail-closed Tenantgrenze                             |
| Tabelle trägt Mandantendaten                              | ENABLE und FORCE RLS plus Policy verlangen               | DB-Backstop                                          |
| neue Tabelle erfüllt Gate nicht                           | CI/Verifikation fehlschlagen lassen                      | Drift früh erkennen                                  |
| Tabelle ist ausdrücklich global und begründet ausgenommen | RLS-Gate darf sie überspringen                           | dokumentierte enge Ausnahme                          |
| Owner-Verbindung wird genutzt                             | eigene Autorisierung und Tenantbegrenzung verlangen      | Owner kann RLS umgehen                               |

## Ausnahmen und Grenzfälle

Die Allowlist enthält Prisma-Migrationen und den globalen Steuernachrichten-
Cache. RLS verhindert keine unzulässige Einsicht eines berechtigten
Mitarbeiters innerhalb desselben Tenants. SECURITY-DEFINER-Funktionen und
Owner-Clients benötigen eine eigene, enge Prüfung. Restore, Replikation und
direkter Datenbankbetrieb liegen außerhalb des Anwendungstests.

## Beispiele

### Normalfall

Session A setzt Tenant A und fragt alle Mandanten ab. Zeilen von Tenant B sind
für die App-Rolle unsichtbar, auch wenn ein App-Filter versehentlich fehlt.

### Grenzfall

Eine neue tenantbezogene Tabelle wird migriert, aber nicht mit FORCE RLS und
Policy versehen. `verify:rls` muss den Build stoppen; bis zur Ergänzung besteht
keine behauptete Abdeckung für diese Tabelle.

## Umsetzung in TaxTronik

`withTenantContext` setzt die drei `app.current_*`-Werte transaktionslokal und
serialisiert Queries auf der Verbindung. Die Migration aktiviert und erzwingt
RLS. `verify-rls.ts` inventarisiert Tabellen, RLS-Flags und Policies; der
Cross-Tenant-Test verwendet getrennte App-Sessions für Lesen und Mutieren.

## Bekannte Abweichungen und Grenzen

Für die registrierten Tabellen ist der beschriebene Backstop implementiert.
Der Status ist an das laufende Drift-Gate gebunden: neue Tabellen,
SECURITY-DEFINER-Funktionen oder Owner-Pfade können neue Risiken schaffen. Der
Nachweis ist weder Penetrationstest noch Aussage über Netzwerk-, Backup- oder
Host-Isolation.

## Fachliche Prüffragen

- Sind alle tatsächlich tenantbezogenen Tabellen und Funktionen inventarisiert?
- Welche Owner- und SECURITY-DEFINER-Pfade sind betrieblich zulässig?
- Reichen die dokumentierten globalen Ausnahmen weiterhin aus?
- Wie wird die RLS-Prüfung in jeder Zielumgebung nachgewiesen?

## Technische Nachweise

Der Datenbanktest belegt Cross-Tenant-Sperren für Lesen, Einfügen, Aktualisieren
und Löschen sowie Paar-Guards ausgewählter Tabellen. Das Skript belegt den
Schema-Inventurmechanismus. Beides beweist nicht die Sicherheit privilegierter
Zugänge oder eine vollständige Angriffssimulation.
