---
id: REMINDER-TICKET-001
title: Wiedervorlagen mit stabilen Ticketverweisen und getrenntem Archiv führen
domain: mandat-und-zugriff
rule_type: product_rule
jurisdiction: DE
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
    Wiedervorlagen erhalten tenantgebundene Nummern, gerichtete persistierte
    Erwähnungen und ein getrenntes Archiv erledigter Aufgaben. Zugriffsrechte
    werden an jedem Zusammenhang erneut geprüft. Datenbank-, Dienst- und
    Browserregressionen belegen den Ablauf; eine fachliche Freigabe liegt nicht vor.
sources:
  - kind: product_documentation
    citation: Anwenderdokumentation Wiedervorlagen als Tickets
    path: docs/anwenderdoku/wiedervorlagen.md
    checked_at: '2026-09-07'
    primary: true
code_refs:
  - packages/db/prisma/schema.prisma
  - packages/db/prisma/migrations/20260907013230_reminder_tickets/migration.sql
  - packages/db/src/restore-security.ts
  - apps/web/src/lib/reminder-ticket-references.ts
  - apps/web/src/server/reminders/service.ts
  - apps/web/src/server/reminders/detail.ts
  - apps/web/src/server/reminders/queries.ts
  - apps/web/src/server/reminders/access.ts
  - apps/web/src/server/reminders/references.ts
  - apps/web/src/server/reminders/history.ts
  - apps/web/src/server/reminders/presentation.ts
  - apps/worker/src/jobs/reminders-daily.ts
  - apps/worker/src/jobs/reminder-done-notify.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/reminders/actions.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/_data.ts
  - apps/web/src/server/risk/delegate.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/subsumtion/actions.ts
  - apps/web/src/server/documents/reminder-upload-guard.ts
  - apps/web/src/app/api/staff/documents/commit/route.ts
  - apps/web/src/app/api/staff/clients/[id]/reminders/route.ts
  - apps/web/src/app/staff/(protected)/reminders/page.tsx
  - apps/web/src/app/staff/(protected)/reminders/reminders-overview.tsx
  - apps/web/src/app/staff/(protected)/reminders/ticket-text.tsx
  - apps/web/src/app/staff/(protected)/reminders/use-mounted.ts
  - apps/web/src/app/staff/(protected)/reminders/[id]/page.tsx
  - apps/web/src/app/staff/(protected)/reminders/[id]/reminder-detail-view.tsx
  - apps/web/src/app/staff/(protected)/reminders/[id]/ticket-context.tsx
  - apps/web/src/app/staff/(protected)/reminders/[id]/ticket-conversation.tsx
  - apps/web/src/app/staff/(protected)/reminders/[id]/ticket-forms.tsx
  - apps/web/src/app/staff/(protected)/reminders/[id]/ticket-history-pagination.tsx
test_refs:
  - apps/web/src/lib/__tests__/reminder-ticket-references.test.ts
  - apps/web/src/server/documents/__tests__/reminder-upload-guard.test.ts
  - apps/web/src/server/risk/__tests__/delegate.test.ts
  - packages/db/src/__tests__/reminder-tickets.test.ts
  - apps/web/src/server/reminders/__tests__/tickets-db.test.ts
  - apps/web/src/server/reminders/__tests__/access.test.ts
  - apps/web/src/server/reminders/__tests__/service.test.ts
  - apps/web/src/server/reminders/__tests__/history.test.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/reminders/__tests__/done-undo.test.ts
  - apps/worker/src/jobs/__tests__/reminder-done-notify.test.ts
  - apps/web/src/app/api/staff/documents/commit/__tests__/route-toctou.test.ts
  - apps/web/src/app/api/staff/clients/[id]/reminders/__tests__/route.test.ts
  - apps/web/src/app/staff/(protected)/reminders/__tests__/overview-page.test.tsx
  - apps/e2e/tests/22-reminder-tickets.spec.ts
  - apps/e2e/tests/23-reminder-ticket-flow.spec.ts
feature_refs:
  - docs/anwenderdoku/wiedervorlagen.md
related_rules:
  - ACCESS-CLIENT-MODE-001
  - ACCESS-TENANT-RLS-001
  - TAX-CONTROL-STATUS-001
  - RISK-ARCHIVE-SNAPSHOT-001
  - DSGVO-MANDATE-ANONYMIZATION-001
tags:
  - wiedervorlage
  - ticket
  - zusammenarbeit
  - rückverweis
  - archiv
---

# REMINDER-TICKET-001 — Wiedervorlagen mit stabilen Ticketverweisen und getrenntem Archiv führen

## Kurzfassung

Eine Wiedervorlage ist eine eigenständige Aufgabe mit optionalem Mandantenbezug,
Fälligkeit und Zuständigkeit. Ihre kanzleiweit eindeutige Nummer sowie
gespeicherte Verweise bleiben nach Erledigung und Archivierung erhalten.
Archivierung ist eine organisatorische Ablageentscheidung, keine fachliche
Freigabe und kein eigenständiger Fristabschluss.

## Wann gilt die Regel?

Die Regel gilt für Wiedervorlagen im Staffbereich, einschließlich aus
Recherchedelegation oder Telefonnotizen erzeugter Aufgaben. Sie beschreibt
eine Produktentscheidung, keine gesetzliche Ticket-, Nummerierungs- oder
Aufbewahrungspflicht. Fachliche Analysearchive und Dokumentversionen bleiben
gesonderte Funktionen.

## Benötigte Angaben

- authentisierte Person und Kanzlei sowie aktuelle Zugriffsrechte
- Titel, Fälligkeit und mindestens eine aktive zuständige Person
- optional Mandant, Beschreibung, Kommentare und bestehende Herkunft
- bei einer Erwähnung die eigenständige Schreibweise `#123`
- bei Archivierung ein vorheriger Arbeitsabschluss und die handelnde Person

## Entscheidungslogik

| Wenn                                                                                                         | Dann                                                                       | Begründung                                                          |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Eine neue Wiedervorlage entsteht                                                                             | Nächste positive Nummer innerhalb derselben Kanzlei atomar vergeben        | Parallele Erzeuger erhalten verschiedene Identitäten                |
| Eine vorhandene Wiedervorlage migriert wird                                                                  | Nummer deterministisch nach Anlagezeit und ID zuordnen; UUID erhalten      | Bestehende Links bleiben nutzbar                                    |
| Eine Beschreibung oder ein Kommentar ein zugängliches Ticket ausdrücklich erwähnt                            | Persistente gerichtete Verknüpfung und Rückverweis anlegen                 | Zusammenhänge werden nachvollziehbar                                |
| Ein Ziel fehlt, fremd oder derzeit nicht zugänglich ist                                                      | Keinen Zusammenhang und keine Inhaltsvorschau erzeugen                     | Eine Nummer erweitert keine Berechtigung                            |
| Rechte später geändert werden                                                                                | Verweise bei jeder Anzeige erneut filtern                                  | Frühere Beteiligung ist keine dauernde Leseberechtigung             |
| Eine bekannte Recherchemarkierung delegiert wird                                                             | Herkunft am neuen Ticket unabhängig von der aktuellen Delegation speichern | Alte Vorgänge verlieren bei erneuter Delegation ihren Kontext nicht |
| Eine Aufgabe offen ist                                                                                       | Archivieren ablehnen                                                       | Offene Arbeit darf nicht durch bloße Ablage verschwinden            |
| Eine Aufgabe mit Abschlusszeit und abschließender Person durch Ersteller, Admin oder Partner archiviert wird | Archivzeit und handelnde Person setzen, Inhalt und Verweise behalten       | Nachvollziehbare Ablage                                             |
| Ein Ticket archiviert ist                                                                                    | Lesen erlauben, neue Kommentare, Zuweisungen und Anhänge ablehnen          | Ablage ist kein aktiver Arbeitsvorgang                              |
| Ein archiviertes Ticket zurückgeholt wird                                                                    | Archivfelder leeren, Erledigungsnachweis behalten                          | Wiederöffnung bleibt eine eigene Handlung                           |

## Ausnahmen und Grenzfälle

Interne Aufgaben sind für Beteiligte sowie Admin und Partner sichtbar;
mandantenbezogene Aufgaben folgen der aktuellen Mandantenpolicy. Ein Verweis
ersetzt keine dieser Prüfungen. Derselbe Nummerntext kann in zwei Kanzleien
unterschiedliche Tickets bezeichnen. Es gibt keine tenantübergreifenden
Verweise.

Eine reine Rückfrage wird als Kommentar erfasst. Eine eigenständige neue
Aufgabe kann separat verknüpft werden; vorhandene Vorgängerbeziehungen bleiben
lesbar. Fälligkeiten werden dabei nicht automatisch vererbt oder als
rechtliche Frist bewertet.

## Beispiele

### Normalfall

Die Mitarbeiterin schreibt in Ticket #18: „Ergebnis siehe #12.“ Sie darf beide
Tickets lesen. #18 verweist nun auf #12; bei #12 erscheint der Rückverweis.
Nach Abschluss wird #12 archiviert. Beide Richtungen bleiben unter denselben
aktuellen Zugriffsprüfungen erreichbar.

### Grenzfall

Ticket #12 gehört zu einem inzwischen vertraulichen Mandanten. Die
Mitarbeiterin darf nur noch #18 lesen. Der gespeicherte Zusammenhang verleiht
ihr weder den Titel noch die Inhalte von #12. Der selbst geschriebene Text in
#18 wird durch eine spätere Rechteänderung nicht rückwirkend umgeschrieben.

## Umsetzung in TaxTronik

Nummern werden in der Datenbank für alle Producer vergeben. Tenantgebundene
Fremdschlüssel sichern Referenzen ab. Der Server löst explizite Nummern in
neuen Beschreibungen und Kommentaren auf und prüft die Sichtbarkeit vor dem
Speichern sowie vor jeder Anzeige. UUID- und Nummernlinks öffnen denselben
Vorgang. Die Übersicht trennt offene, erledigte und archivierte Ergebnisse
und filtert vor der Seitennavigation.

Kommentare und Anhänge haben getrennte Seiten mit 200 beziehungsweise 50
Einträgen. Die Standardseite enthält die neuesten Beiträge, innerhalb einer
Seite chronologisch angezeigt. Ältere Seiten bleiben auch im Archiv lesbar;
nach neuem Kommentar oder Upload führt die Bedienung zur neuesten Seite.

Der Nummernzähler ist ausschließlich über die geprüfte Triggerfunktion
beschreibbar. Die Anwendungsrolle kann Referenzkanten lesen und ergänzen,
aber nicht überschreiben oder entfernen. Die obligatorische Sicherheitsprüfung
nach einem Restore prüft diese Tabellenrechte und die gesperrten direkten
Aufrufe der Triggerfunktionen mit.

Archivierung und Mutationen sperren die betreffende Datenbankzeile. Der
Dokumentupload prüft Zugriffsrechte und Archivstatus vor dem Speichern der
Datei sowie erneut bei der Finalisierung. Ein inzwischen archiviertes oder
nicht mehr zugängliches Ticket erhält keinen neuen Anhang.

Die Sperre verwendet `FOR NO KEY UPDATE`: Statusänderungen bleiben
serialisiert, während Fremdschlüsselprüfungen gegenseitiger Ticketverweise
ihre kompatiblen Lesesperren erhalten. Die Datenbank verhindert ohnehin eine
Änderung von Ticket-ID, Tenant und Nummer. Zwei gleichzeitige Kommentare mit
gegenseitigen Verweisen dürfen sich dadurch nicht gegenseitig blockieren.

## Bekannte Abweichungen und Grenzen

Automatische Erwähnungen gelten für neu gespeicherte Ticketbeschreibungen und Kommentare,
nicht pauschal für alle Freitextfelder anderer Module. Ähnlicher Inhalt oder
derselbe Mandant werden nicht als Zusammenhang geraten. Altnotizen werden
nicht nachträglich als Erwähnungen interpretiert. Der Herkunfts-Backfill nutzt
nur eindeutige bestehende Recherchezuordnungen; verlorene historische
Zuordnungen werden nicht rekonstruiert.

Das Archiv ist keine unveränderbare Vollkopie aller verknüpften Dokumente.
Nummer und Verweise bleiben im normalen Aufgabenablauf bestehen, unterliegen
aber weiterhin den getrennten Verfahren für berechtigte Löschung und
Anonymisierung. Ein erledigtes oder archiviertes Ticket ersetzt keine
fachliche Ergebnisprüfung oder organisatorische Fristenkontrolle.

## Fachliche Prüffragen

- Sind Zuständigkeit, Arbeitsabschluss und Archivberechtigung für die Kanzlei angemessen?
- Welche eigenständigen Aufgaben sollen neben einer Unterhaltung geführt werden?
- Welche Aufbewahrungs- und Löschregeln gelten für die konkreten Ticketinhalte?
- Welche zusätzlichen Quellen sollen künftig ausdrücklich verknüpft werden?

## Technische Nachweise

Parserregressionen prüfen Nummerngrenzen, Deduplizierung und unveränderte
Texterhaltung. Uploadregressionen prüfen interne Beteiligung, Mandantenrechte
und erneute Archivkontrolle. Die Delegationsregression prüft die Herkunft bei
erneuter Zuweisung. Echte PostgreSQL-Tests belegen Nummernvergabe, Backfill,
Rechte, gegenseitige Verweise ohne Deadlock, Archivkonkurrenz und Restore-ACLs.
Sechs Fälle führen die tatsächlichen Produktionsloader und Referenzdienste
mit der App-Rolle aus, einschließlich 201 Kommentaren auf zwei Seiten.
Browserregressionen prüfen die Komponenten sowie den vollständigen Ablauf
über Oberfläche, Server-Actions und Datenbank. Der Abnahmebericht steht unter
`docs/reviews/2026-09-07-wiedervorlagen-tickets.md`; daraus entsteht keine
fachliche Freigabe.
