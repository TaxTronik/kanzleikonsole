---
id: ACCESS-CLIENT-MODE-001
title: Kanzleiweiten Mandantenzugriff nach OPEN, RESTRICTED und Vertraulichkeit steuern
domain: mandat-und-zugriff
rule_type: product_rule
jurisdiction: EU/DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Berufsträger Datenschutz und Kanzleiorganisation
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: implemented
  summary: >-
    Die zentrale Policy erlaubt aktiven Mitarbeitern im Modus OPEN Zugriff auf
    nicht vertrauliche Mandanten. RESTRICTED und das Vertraulichkeitsflag
    verlangen eine Berufsträger- oder Hauptbearbeiterzuordnung; ADMIN und
    PARTNER bleiben unabhängig davon berechtigt.
sources:
  - kind: product_documentation
    citation: Feature-Katalog, Zugriffsmodell OPEN/RESTRICTED
    path: FEATURES.md
    checked_at: '2026-08-24'
    primary: true
  - kind: product_documentation
    citation: Technische Modulbeschreibung Zugriffsschutz und Benutzerverwaltung
    path: docs/development/module/zugriffsschutz.md
    checked_at: '2026-08-24'
    primary: false
  - kind: official_law
    citation: § 57 Abs. 1 StBerG
    url: https://www.gesetze-im-internet.de/stberg/__57.html
    checked_at: '2026-08-24'
    primary: false
  - kind: official_law
    citation: § 62 StBerG
    url: https://www.gesetze-im-internet.de/stberg/__62.html
    checked_at: '2026-08-24'
    primary: false
  - kind: official_law
    citation: Art. 5 Abs. 1 Buchst. c und f, Art. 25 und 32 DSGVO
    url: https://eur-lex.europa.eu/eli/reg/2016/679/oj?locale=de
    checked_at: '2026-08-24'
    primary: false
code_refs:
  - packages/db/src/staff-client-access.ts
  - apps/web/src/server/settings/access-policy.ts
  - apps/web/src/server/auth/rbac.ts
test_refs:
  - apps/web/src/server/settings/__tests__/access-policy.test.ts
  - apps/web/src/server/settings/__tests__/access-policy.property.test.ts
  - apps/web/src/server/auth/__tests__/rbac.test.ts
feature_refs:
  - FEATURES.md
  - docs/development/module/zugriffsschutz.md
related_rules:
  - ACCESS-STAFF-PERMISSION-001
  - ACCESS-TENANT-RLS-001
  - ACCESS-NOTIFICATION-RECIPIENT-001
tags:
  - mandantenzugriff
  - vertraulichkeit
  - zuständigkeit
---

# ACCESS-CLIENT-MODE-001 — Kanzleiweiten Mandantenzugriff nach OPEN, RESTRICTED und Vertraulichkeit steuern

## Kurzfassung

TaxTronik trennt organisatorische Zuständigkeit vom technischen Lesezugriff.
Im Modus `OPEN` dürfen aktive Mitarbeiter an allen nicht vertraulichen
Mandanten der Kanzlei mitarbeiten. `RESTRICTED` und ein gesetztes
Vertraulichkeitsflag beschränken Nicht-Admins auf zugeordnete Berufsträger oder
Hauptbearbeiter; ADMIN und PARTNER sind immer zugelassen.

Diese Produktpolicy entscheidet nicht, ob ein Zugriff im Einzelfall fachlich
erforderlich oder wegen einer Interessenkollision unzulässig ist.

## Wann gilt die Regel?

Die Regel gilt für staffseitige, mandantengebundene Lese- und Aktionspfade, die
das zentrale Zugriffsgate verwenden. Sie gilt nicht für Portalnutzer, reine
Tenant-Isolation, externe Systeme oder Tätigkeiten außerhalb von TaxTronik.

## Benötigte Angaben

- aktiver Mitarbeiter und Tenant
- Rollen ADMIN/PARTNER oder sonstige Mitarbeiterrolle
- Kanzleieinstellung `OPEN` oder `RESTRICTED`
- Vertraulichkeitsflag des Mandanten
- Berufsträger- oder Hauptbearbeiterzuordnung

## Entscheidungslogik

| Wenn                                                   | Dann                                                          | Begründung                                |
| ------------------------------------------------------ | ------------------------------------------------------------- | ----------------------------------------- |
| ADMIN oder PARTNER                                     | Zugriff erlauben                                              | produktseitiger Rollen-Override           |
| OPEN und Mandant nicht vertraulich                     | aktivem Mitarbeiter Zugriff erlauben                          | kanzleiweite Zusammenarbeit               |
| OPEN und Mandant vertraulich                           | nur bei Berufsträger-/Hauptbearbeiterzuordnung erlauben       | mandantenbezogenes Vertraulichkeitsventil |
| RESTRICTED                                             | nur ADMIN/PARTNER oder Berufsträger-/Hauptbearbeiter zulassen | strikter Kanzleimodus                     |
| Setting fehlt                                          | OPEN verwenden                                                | dokumentierter Produktdefault             |
| Setting enthält keinen exakt erkannten RESTRICTED-Wert | OPEN verwenden                                                | bewusster derzeitiger Fallback            |
| Mandant oder aktiver Mitarbeiter fehlt                 | Zugriff verweigern                                            | fail-closed auf das Zielobjekt            |

## Ausnahmen und Grenzfälle

Eine Fach- oder Vertretungszuordnung außerhalb der beiden Rollen
`BERUFSTRAEGER` und `HAUPTBEARBEITER` begründet in diesem Gate keinen Zugriff.
Das OPEN-Modell ist bewusst breit und kann für besonders sensible Bestände
ungeeignet sein. Verschwiegenheitspflicht und technische Berechtigung ersetzen
weder Need-to-know-Regeln noch Kollisionsprüfung, Weisungen und Aufsicht der
Kanzlei.

## Beispiele

### Normalfall

Die Kanzlei nutzt OPEN. Eine aktive Mitarbeiterin ist dem nicht vertraulichen
Mandanten nicht zugeordnet, soll aber spontan eine Aufgabe übernehmen. Das
zentrale Gate erlaubt den Zugriff.

### Grenzfall

Der Mandant wird nachträglich als vertraulich markiert. Dieselbe Mitarbeiterin
verliert den Zugriff, sofern sie nicht als Berufsträgerin oder
Hauptbearbeiterin zugeordnet wird. Eine ADMIN-Rolle bleibt berechtigt.

## Umsetzung in TaxTronik

`decideClientAccess` enthält die Wahrheitstabelle. Die Datenbank-Helfer laden
nur aktive Mitarbeiter, die Kanzleipolicy, das Vertraulichkeitsflag und bei
Bedarf Verantwortungen. `rbac.ts` stellt Einzel-, Batch- und Prisma-Filter für
Seiten, Actions, Exporte und Empfängerlisten bereit. Ein ungültiger
Konfigurationswert wird derzeit wie OPEN behandelt.

## Bekannte Abweichungen und Grenzen

Keine bekannte Abweichung innerhalb der zentralen Wahrheitstabelle. Die Tests
beweisen aber nicht, dass jeder heutige und zukünftige Austrittspfad das Gate
korrekt aufruft. OPEN ist außerdem keine gesetzliche Freigabe sämtlicher
kanzleiinterner Zugriffe; die Kanzlei muss Modus, Vertraulichkeitsflags,
Beschäftigtenverpflichtung und Kollisionskontrollen organisatorisch festlegen.

## Fachliche Prüffragen

- Ist OPEN für den konkreten Kanzleibetrieb und seine Datenarten angemessen?
- Welche Mandanten oder Sachverhalte müssen unabhängig von Zuständigkeiten vertraulich sein?
- Reichen die zwei zugriffsbegründenden Zuordnungsrollen aus?
- Soll ein ungültiges Setting weiterhin auf OPEN statt RESTRICTED fallen?

## Technische Nachweise

Wahrheits- und Property-Tests belegen Admin-Override, OPEN, RESTRICTED,
Vertraulichkeit und Zuordnung. RBAC-Tests belegen Einzel- und Batchfilter. Sie
belegen weder die organisatorische Angemessenheit noch die vollständige
Abdeckung aller Call-Sites.
