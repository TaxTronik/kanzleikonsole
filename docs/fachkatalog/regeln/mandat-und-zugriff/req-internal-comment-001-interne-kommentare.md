---
id: REQ-INTERNAL-COMMENT-001
title: Interne Anforderungskommentare vom Mandantenkanal trennen
domain: mandat-und-zugriff
rule_type: product_rule
jurisdiction: EU/DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Berufsträger Kanzleiprozesse und Datenschutz
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: implemented
  summary: >-
    Kanzleiinterne Kommentare werden in einem staff-/systembeschränkten
    Datentyp gespeichert, bleiben statusunabhängig möglich und werden weder in
    Portalabfragen angezeigt noch als Mandantenmail versendet.
sources:
  - kind: product_documentation
    citation: Feature-Katalog, interner Kanal nach Antwort und Abschluss
    path: FEATURES.md
    checked_at: '2026-08-24'
    primary: true
  - kind: official_law
    citation: § 57 Abs. 1 StBerG
    url: https://www.gesetze-im-internet.de/stberg/__57.html
    checked_at: '2026-08-24'
    primary: false
  - kind: official_law
    citation: Art. 5 Abs. 1 Buchst. c und f sowie Art. 25 DSGVO
    url: https://eur-lex.europa.eu/eli/reg/2016/679/oj?locale=de
    checked_at: '2026-08-24'
    primary: false
code_refs:
  - apps/web/src/app/staff/(protected)/clients/[id]/requests/actions.ts
  - apps/web/src/app/staff/(protected)/requests/[id]/page.tsx
  - apps/web/src/app/portal/(protected)/requests/[id]/page.tsx
  - packages/db/prisma/migrations/20260823130000_request_internal_comment_staff_only/migration.sql
test_refs:
  - apps/web/src/app/staff/(protected)/clients/[id]/requests/__tests__/actions.test.ts
  - apps/web/src/app/portal/(protected)/requests/[id]/__tests__/internal-comment-visibility.test.ts
  - apps/web/src/app/staff/(protected)/requests/[id]/__tests__/internal-comment-theme.test.ts
feature_refs:
  - FEATURES.md
related_rules:
  - REQ-LIFECYCLE-001
  - ACCESS-CLIENT-MODE-001
tags:
  - interner-kommentar
  - portaltrennung
  - zusammenarbeit
---

# REQ-INTERNAL-COMMENT-001 — Interne Anforderungskommentare vom Mandantenkanal trennen

## Kurzfassung

Interne Kanzleinotizen an einer Anforderung bleiben auch nach einer
Mandantenantwort oder dem formellen Abschluss möglich. Sie werden getrennt von
`RequestResponse` gespeichert, nur staffseitig geladen und lösen keine
Mandantenmail aus.

## Wann gilt die Regel?

Die Regel gilt für den internen Kommentarbereich einer vorhandenen
Anforderung. Ein Mitarbeiter benötigt weiterhin Zugriff auf den zugehörigen
Mandanten. Der Kommentar ist keine mandantensichtbare Antwort und ändert den
Anforderungsstatus nicht.

## Benötigte Angaben

- vorhandene Anforderung
- berechtigter aktiver Mitarbeiter
- aktueller Mandantenzugriff
- Kommentartext mit höchstens 5.000 Zeichen
- staffseitig ermittelter Autorenname

## Entscheidungslogik

| Wenn                                                     | Dann                                         | Begründung                          |
| -------------------------------------------------------- | -------------------------------------------- | ----------------------------------- |
| Request existiert und Mitarbeiter hat Zugriff            | internen Kommentar speichern und auditieren  | kanzleiinterne Zusammenarbeit       |
| Request ist RESPONDED oder CLOSED                        | internen Kommentar weiterhin erlauben        | Nachbearbeitung bleibt intern offen |
| mandantensichtbare Staff-Antwort bei geschlossenem Kanal | verweigern und auf interne Notiz verweisen   | Kanaltrennung                       |
| Portalakteur greift auf Kommentartabelle zu              | per RLS verweigern                           | Staff-/System-only-Datenklasse      |
| Portal lädt Requestdetail                                | interne Relation nicht abfragen oder rendern | keine Offenlegung                   |
| interner Kommentar wird erstellt                         | keine Mandantenmail auslösen                 | interner Zweck                      |

## Ausnahmen und Grenzfälle

Interne Kommentare können sensible Freitexte enthalten und folgen dem
Mandantenzugriff sowie den Retentionregeln der Anforderung. Ein Autorenname
wird als Klartextkopie gespeichert. `SYSTEM` darf die Tabelle für kontrollierte
Betriebsabläufe verwenden. Die Funktion ersetzt kein gesondertes
Need-to-know- oder Kollisionsmodell innerhalb eines zugelassenen Teams.

## Beispiele

### Normalfall

Nach der Formularabgabe steht die Anforderung auf RESPONDED. Ein Mitarbeiter
notiert intern eine fachliche Rückfrage. Der Mandant sieht weder die Notiz noch
eine Benachrichtigung darüber.

### Grenzfall

Die Anforderung ist CLOSED, aber die Kanzlei muss die Akte nachbesprechen. Ein
interner Kommentar ist möglich; eine normale Staff-Antwort an den Mandanten
bleibt gesperrt, bis der Vorgang wieder geöffnet wird.

## Umsetzung in TaxTronik

Die Action prüft Session, Mandantenzugriff und Autor innerhalb der
Tenant-Transaktion und schreibt `request_internal_comment` plus Audit. Die
Datenbankpolicy erlaubt nur STAFF/SYSTEM mit passendem Tenant. Ausschließlich
die Staff-Seite lädt die Relation; die Portal-Seite arbeitet nur mit den
mandantensichtbaren Responses.

## Bekannte Abweichungen und Grenzen

Keine bekannte Abweichung im beschriebenen Kanal. Der Sichtbarkeitstest prüft
die Abfrage-/UI-Struktur statisch; die DB-Policy wird durch die Migration
belegt, aber nicht in diesem spezifischen Test mit einer Portal-Session
ausgeführt. Retention und Volltext-Inhaltskontrolle sind nicht Teil dieser
Regel.

## Fachliche Prüffragen

- Welche Inhalte dürfen in internen Kommentaren stehen?
- Wie lange sollen Kommentare und Autorenkopien aufbewahrt werden?
- Benötigen besonders vertrauliche Sachverhalte eine feinere Teambegrenzung?
- Soll eine Korrektur oder Löschung interner Kommentare möglich sein und wie wird sie nachgewiesen?

## Technische Nachweise

Die Actiontests belegen Kommentare in RESPONDED/CLOSED, Audit und das
Ausbleiben von Mandantenmail. Der Sichtbarkeitstest belegt, dass nur die
Staff-Seite die interne Relation lädt. Der Darstellungsnachweis prüft die
semantischen, auch im Dark Mode kontrastreichen Oberflächenklassen des
internen Bereichs; er verändert oder belegt keine zusätzliche Fachlogik.
