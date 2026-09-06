---
id: ACCESS-SEARCH-SCOPE-001
title: Suche auf aktuell autorisierte Metadaten begrenzen
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
  status: partial
  summary: >-
    Inbox-Listen und -Suche verwenden denselben Tenant-, Mandanten-, Kontakt-,
    Feature- und Staff-Permission-Scope wie der direkte Objektzugriff und suchen
    nur freigegebene Metadaten. Im Portal sind dies Betreff und der bereits
    sichtbare Mandantenname; interne DATEV-/Addison-Nummern bleiben Staff-only.
    Ein vollständiger automatisierter Nachweis für
    alle Suchoberflächen und den anschließenden Deep-Link-Zugriff steht aus.
sources:
  - kind: product_documentation
    citation: Zugriffsschutz, autorisierungsidentische Suche
    path: docs/development/module/zugriffsschutz.md
    checked_at: '2026-09-01'
    primary: true
  - kind: product_documentation
    citation: Sicherer Mandantenposteingang, Metadatensuche
    path: docs/development/module/portal-inbox.md
    checked_at: '2026-09-01'
    primary: false
code_refs:
  - apps/web/src/server/inbox/access.ts
  - apps/web/src/server/inbox/queries.ts
  - apps/web/src/server/inbox/search.ts
  - apps/web/src/app/portal/(protected)/requests/page.tsx
  - apps/web/src/app/api/staff/search/route.ts
  - packages/db/prisma/schema.prisma
  - packages/db/prisma/migrations/20260901001000_portal_inbox/migration.sql
test_refs:
  - packages/db/src/__tests__/portal-inbox-rls.test.ts
  - packages/db/src/__tests__/rls-cross-tenant.test.ts
  - apps/web/src/app/api/staff/search/__tests__/route.test.ts
  - apps/web/src/app/portal/(protected)/__tests__/list-ux.test.ts
  - apps/web/src/server/inbox/__tests__/queries.test.ts
  - apps/web/src/server/portal/__tests__/list-query.test.ts
feature_refs:
  - docs/development/module/zugriffsschutz.md
  - docs/development/module/portal-inbox.md
related_rules:
  - ACCESS-TENANT-RLS-001
  - ACCESS-STAFF-PERMISSION-001
  - ACCESS-CLIENT-MODE-001
  - CLIENT-MANDATE-LIFECYCLE-001
  - PORTAL-INBOX-SUBMISSION-001
tags:
  - suche
  - metadaten
  - least-privilege
  - portal
---

# ACCESS-SEARCH-SCOPE-001 — Suche auf aktuell autorisierte Metadaten begrenzen

## Kurzfassung

Ein Suchtreffer darf nie mehr verraten als der aktuelle Akteur beim direkten
Öffnen des Objekts sehen dürfte. Suche, Filter, Trefferzähler, Sortierung und
Deep-Link verwenden deshalb denselben Tenant-, Mandanten-, Rollen-,
Einzelrechte-, Kontakt-, Feature- und Lebenszyklus-Scope wie das Zielobjekt.

## Wann gilt die Regel?

Die Regel gilt für Portal- und Kanzleisuche sowie listenartige Filter, sobald
sie tenant-, mandanten- oder personenbezogene Objekte auffindbar machen. Der
aktuelle Inbox-Scope umfasst Betreff, Themenkategorie, Status und Zuständigkeit.
Im Portal kommt nur der sichtbare Mandantenname hinzu; interne DATEV-/Addison-
Kennungen sind dort auch als Trefferorakel ausgeschlossen. Nachrichtentext,
Dateiname und Anlageninhalt sind keine Suchfelder.

## Benötigte Angaben

- aktueller Tenant und authentifizierter Akteur
- für Portalakteure die aktive Kontakt- und Mandantenzuordnung
- für Staff der aktuelle Mandantenzugriff und alle verlangten Einzelrechte
- Feature- und Modulstatus
- ausdrücklich für die jeweilige Suche freigegebene Metadatenfelder
- dieselbe Objekt-ID für Treffer und anschließende Detailautorisierung

## Entscheidungslogik

| Wenn                                            | Dann                                                                                                 | Begründung                                                                |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| kein gültiger Akteurkontext                     | keine Treffer liefern                                                                                | fail-closed                                                               |
| Objekt wäre beim direkten Öffnen nicht sichtbar | weder Treffer noch Zähler oder Snippet liefern                                                       | Suche darf kein Existenzorakel sein                                       |
| Portal-Kontakt sucht Inbox                      | ausschließlich abgesendete Threads des eigenen Mandanten durchsuchen                                 | keine kontaktfremden Drafts oder Mandate                                  |
| Staff sucht Inbox                               | `PORTAL_INBOX_MANAGE` und aktuellen Mandantenzugriff verlangen                                       | kumulative Gates                                                          |
| Portal-Inbox-Suchbegriff vorhanden              | nur Betreff und sichtbaren Mandantennamen vergleichen                                                | weder Kommunikationsinhaltsindex noch Orakel für interne Kanzleikennungen |
| Staff-Inbox-Suchbegriff vorhanden               | Betreff, Mandantenname und im berechtigten Staff-Scope verwendete DATEV-/Addison-Kennung vergleichen | interne Kennungen bleiben kanzleiintern                                   |
| Treffer wird geöffnet                           | Autorisierung erneut gegen den aktuellen Datenstand prüfen                                           | Rechte können zwischen Suche und Klick entzogen werden                    |
| Feature oder Modul wird deaktiviert             | Treffer sofort ausblenden                                                                            | Navigation ist kein Zugriffsgate                                          |

## Ausnahmen und Grenzfälle

Die Suche ist keine Vollständigkeitsgarantie. Begrenzung, Paginierung,
Normalisierung und Indexlatenz können zulässige Treffer auslassen, dürfen aber
keine unzulässigen Treffer hinzufügen. Treffertexte und Zähler können bereits
Vertraulichkeit verletzen; sie unterliegen demselben Scope wie das Zielobjekt.

Die Inbox führt in Version 0.3 keinen Volltextindex für Nachrichtentexte,
Anlagenbytes, OCR-Texte oder Scannerdiagnosen ein. Suchbegriffe werden nicht in
Auditereignisse, Benachrichtigungstitel oder gewöhnliche Logs kopiert.

## Beispiele

### Normalfall

Ein Mitarbeiter mit `PORTAL_INBOX_MANAGE` sucht nach einem Betreff. Er erhält
nur Threads von Mandanten, die er nach der aktuellen OPEN-/RESTRICTED-/
Vertraulich-Policy öffnen darf. Nach Entzug des Mandantenzugriffs liefert die
Suche keinen Treffer mehr und der alte Deep-Link scheitert ebenfalls.

### Grenzfall

Ein aktiver Portal-Kontakt kennt den Betreff eines fremden Mandanten. Die Suche
liefert weder den Thread noch einen positiven Zähler. Ein offener Uploadbatch
eines anderen Kontakts desselben Mandanten bleibt ebenfalls unsichtbar.

## Umsetzung in TaxTronik

Inbox-Abfragen setzen Tenant und Mandant explizit, prüfen das opt-in Feature und
verwenden RLS als zusätzlichen Backstop. Staff-Listen kombinieren
`accessibleClientsWhereFor` mit aktivem Mandat; Detailabfragen prüfen den
Mandantenzugriff erneut. Die Portal-Policy bindet abgesendete Threads an einen
aktiven Kontakt desselben Mandanten und offene Batches ausschließlich an ihren
Ersteller.

Der einzige Inbox-Trigramindex liegt auf `portal_inbox_thread.subject`. Auf
`portal_inbox_message.body` existiert bewusst weder ein Trigram-/GIN- noch ein
anderer globaler Inhaltsindex. Status, Topic, Zuständigkeit und Zeit besitzen
normale Scope-Indizes; diese ändern keine Sichtbarkeitsentscheidung.

Die Suchfelddefinition ist nach Oberfläche getrennt. Portalabfragen enthalten
nur Betreff und Mandantenname. DATEV- und Addison-Nummern werden ausschließlich
der Staff-Abfrage hinzugefügt und können im Portal weder Treffer noch Zähler
beeinflussen.

## Bekannte Abweichungen und Grenzen

Die DB- und Query-Grenzen des Inbox-Moduls sowie der getrennte
Suchfeld-Vertragstest sind vorhanden. Ein vollständiger automatisierter
Vertragstest über Portal- und Staff-HTTP-Oberflächen,
Trefferzähler, Rechteentzug, Modul-Aus und Deep-Link fehlt noch. Die allgemeine
Kanzleisuche besitzt eigene Kategorien; ihre Aufnahme in diese Regel verlangt
je Kategorie eine gesonderte Scope-Inventur. Nachrichtenvolltextsuche ist kein
Bestandteil von Version 0.3.

## Fachliche Prüffragen

- Welche Metadaten dürfen je Suchoberfläche überhaupt als Treffer erscheinen?
- Sind Mandantenname und externe Ordnungsnummern für jeden berechtigten Staff-Scope erforderlich?
- Wie werden Such- und Deep-Link-Rechteentzug gemeinsam getestet?
- Welche Protokollierung ist für Missbrauchserkennung nötig, ohne Suchbegriffe unnötig zu speichern?
- Welche zukünftigen Inhaltsindizes würden eine neue Datenschutz- und Berechtigungsprüfung auslösen?

## Technische Nachweise

RLS-Tests belegen Cross-Tenant-, Cross-Client-, Kontakt- und Staff-Permission-
Grenzen sowie sofortigen Rechteentzug. Der Query-Test belegt, dass Portal und
Staff unterschiedliche erlaubte Metadatenfelder verwenden und interne
Kanzleikennungen nicht im Portal-Where erscheinen. Die Portal-Listentests
belegen die stabile 25er-URL-Paginierung, begrenzte Suchparameter und die
vollständigen Sichtbarkeitsfilter der drei migrierten Portalquellen. Diese
Nachweise sind weder eine fachliche Suchvollständigkeit noch eine allgemeine
Datenschutzfreigabe.
