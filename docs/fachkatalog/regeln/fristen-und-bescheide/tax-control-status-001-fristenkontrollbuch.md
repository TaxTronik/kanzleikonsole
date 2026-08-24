---
id: TAX-CONTROL-STATUS-001
title: Offene und erledigte Fristen beweisorientiert aus dem Quellvorgang ableiten
domain: fristen-und-bescheide
rule_type: office_policy
jurisdiction: DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Kanzleileitung Fristenkontrolle (Berufsträger)
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: partial
  summary: >-
    Die zentrale Ableitung verlangt Zeit und handelnde Person, lässt zweifelhafte
    Quellstatus, interne Risikotermine ohne Rechtsfrist sowie verspätete
    Einlegungen offen und besitzt einen
    tenantweiten append-only Tagesabschluss mit konsistentem DB-Snapshot.
    Strukturierte Belegreferenzen, vollständige Dispositionsgründe,
    Teilverfahrenszweige und ein organisatorisch erzwungenes Vier-Augen-Prinzip
    fehlen.
sources:
  - kind: product_documentation
    citation: Benutzerhandbuch Fristenkontrollbuch
    path: docs/anwenderdoku/kalender-fristen-bescheide.md
    checked_at: '2026-08-23'
    primary: true
  - kind: product_documentation
    citation: Funktionskatalog Fristenkontrollbuch
    path: FEATURES.md
    checked_at: '2026-08-23'
    primary: false
  - kind: official_law
    citation: § 57 Abs. 1 StBerG
    url: https://www.gesetze-im-internet.de/stberg/__57.html
    checked_at: '2026-08-23'
    primary: false
  - kind: case_law
    citation: BFH, Urteil vom 18.06.2015 – IV R 18/13
    url: https://www.bundesfinanzhof.de/de/entscheidung/entscheidungen-online/detail/STRE201550268/
    checked_at: '2026-08-23'
    primary: false
  - kind: official_law
    citation: § 365 Abs. 3 AO
    url: https://www.gesetze-im-internet.de/ao_1977/__365.html
    checked_at: '2026-08-23'
    primary: false
  - kind: official_law
    citation: § 367 Abs. 2 und 2a AO
    url: https://www.gesetze-im-internet.de/ao_1977/__367.html
    checked_at: '2026-08-23'
    primary: false
  - kind: official_law
    citation: § 47 Abs. 1 FGO
    url: https://www.gesetze-im-internet.de/fgo/__47.html
    checked_at: '2026-08-23'
    primary: false
  - kind: official_guidance
    citation: AEAO zu § 367, Teil-Einspruchsentscheidung, Ausgabe 2025
    url: https://ao.bundesfinanzministerium.de/ao/2025/Abgabenordnung/Siebenter-Teil/Zweiter-Abschnitt/Paragraf-367/inhalt.html
    checked_at: '2026-08-23'
    primary: false
code_refs:
  - packages/db/prisma/schema.prisma
  - apps/web/src/server/fristen/eintrag.ts
  - apps/web/src/server/fristen/kontrollbuch.ts
  - apps/web/src/server/fristen/tagesabschluss.ts
  - apps/web/src/app/staff/(protected)/fristen/actions.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/notices/page.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/notices/status-select.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/notices/notice-transition.ts
  - apps/worker/src/jobs/reminders-daily.ts
  - packages/db/prisma/migrations/20260823200000_tax_notice_status_terms/migration.sql
  - packages/db/prisma/migrations/20260823201000_tax_professional_control_model/migration.sql
test_refs:
  - packages/db/src/__tests__/tax-notice-evidence.test.ts
  - packages/db/src/__tests__/tax-notice-partial-relief-migration.test.ts
  - apps/web/src/server/fristen/__tests__/eintrag.test.ts
  - apps/web/src/server/fristen/__tests__/kontrollbuch.test.ts
  - apps/web/src/server/fristen/__tests__/tagesabschluss.test.ts
  - apps/web/src/app/staff/(protected)/fristen/__tests__/actions.test.ts
  - apps/web/src/app/staff/(protected)/tax-deadlines/__tests__/actions.test.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/notices/__tests__/notice-transition.test.ts
  - apps/worker/src/jobs/__tests__/reminders-daily.test.ts
  - packages/db/src/__tests__/deadline-daily-review.test.ts
feature_refs:
  - FEATURES.md
  - docs/anwenderdoku/kalender-fristen-bescheide.md
related_rules:
  - TAX-NOTICE-APPEAL-001
  - TAX-NOTICE-DATARETRIEVAL-001
  - TAX-DEADLINE-AUTOREQUEST-001
tags:
  - fristenkontrollbuch
  - erledigung
  - status
---

# TAX-CONTROL-STATUS-001 — Offene und erledigte Fristen beweisorientiert aus dem Quellvorgang ableiten

## Kurzfassung

Das Fristenkontrollbuch führt keinen frei editierbaren parallelen
„Erledigt“-Schalter, sondern leitet seine Sicht aus dem jeweiligen Fachvorgang
ab. Ein Statusname allein ist dafür nicht immer ausreichend: Eine relevante
Frist soll erst geschlossen werden, wenn Erledigungsgrund und erforderlicher
Nachweis im Quellvorgang dokumentiert sind.

Zu trennen sind der Kontrollzustand der konkreten Frist, der fachliche
Verfahrensstand und der Nachweis der fristwahrenden oder bewusst unterlassenen
Handlung. Offene überfällige Fristen bleiben ohne untere Datumsgrenze sichtbar.

## Wann gilt die Regel?

Die Regel gilt für Steuertermine, Bescheidprüffälle/Einspruchsfristen,
Klagefristen, Mandantenanforderungen und Wiedervorlagen in der zentralen Kontrollsicht. Sie
beschreibt eine noch ungeprüfte Kanzlei- und Produktregel für das
Fristenkontrollverfahren, nicht die materiell-rechtliche Wirksamkeit eines
Rechtsbehelfs.

Für gesetzliche Rechtsbehelfsfristen gelten erhöhte organisatorische
Anforderungen. Der BFH verlangt auch bei elektronischer Fristenkontrolle eine
abschließende tägliche Erledigungskontrolle.

## Benötigte Angaben

- Quellart, fachlicher Quellstatus und konkrete Fristart
- Rechtsgrundlage und Fälligkeitsdatum
- verantwortliche Person und Vertretung
- Mandantenzuordnung und Zugriffsberechtigung
- standardisierter Erledigungsgrund
- Erledigungszeitpunkt und handelnde Person
- Nachweis der fristwahrenden Handlung, soweit erforderlich
- bei bewusster Nichtvornahme: dokumentierte fachliche Entscheidung
- bei Folgefristen: auslösendes Dokument und geprüfter Bekanntgabetag

## Entscheidungslogik

### Zielzustände der Kontrollsicht

| Kontrollzustand         | Bedeutung                                                                |
| ----------------------- | ------------------------------------------------------------------------ |
| `OPEN`                  | Frist ist noch zu überwachen                                             |
| `CLOSED_FULFILLED`      | erforderliche Handlung wurde vorgenommen und nachgewiesen                |
| `CLOSED_DISPOSITION`    | bewusste Entscheidung, die Handlung nicht vorzunehmen                    |
| `CLOSED_NOT_APPLICABLE` | Frist ist nach dokumentierter Prüfung nicht einschlägig                  |
| `SUPERSEDED`            | Frist wurde nachvollziehbar durch eine verknüpfte Nachfolgefrist ersetzt |

Diese Zielzustände sollen aus dem Fachvorgang abgeleitet werden und sind nicht
als frei editierbarer Parallelstatus gemeint. Sie sind derzeit nicht als
vollständiges Datenmodell implementiert.

### Steuertermine

| Quelllage                                    | Kontrollfolge               |
| -------------------------------------------- | --------------------------- |
| Status ist nicht `DONE`                      | grundsätzlich offen         |
| `DONE` und erforderlicher Nachweis liegt vor | erfüllt                     |
| `SKIPPED` ohne Grund und Freigabe            | Status allein genügt nicht  |
| nach Prüfung nicht einschlägig               | nicht anwendbar             |
| wirksam durch neuen Termin ersetzt           | ersetzt, mit Nachfolgefrist |

`SKIPPED` fasst derzeit unterschiedliche Gründe zusammen. Nicht anwendbar,
abgebrochen und durch einen anderen Termin ersetzt sollten fachlich getrennt
werden.

### Einspruchsfrist und Verfahren

| Quelllage                                                  | Kontrollfolge                                                                    |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `NEU` oder `GEPRUEFT` ohne Entscheidung                    | Einspruchsfrist offen                                                            |
| Einspruch ohne Versand- oder Eingangsbeleg                 | offen oder Warnzustand                                                           |
| Einreichung mit Zeit, Weg und Nachweis dokumentiert        | Einspruchsfrist erfüllt; Verfahren bleibt offen                                  |
| bewusste Entscheidung gegen Einspruch                      | nur mit dokumentierter fachlicher Disposition schließen                          |
| vollständige Abhilfe                                       | Verfahren kann fachlich geschlossen werden                                       |
| Teilabhilfebescheid                                        | Einspruchsverfahren bleibt grundsätzlich anhängig; keine automatische Klagefrist |
| Einspruchs- oder Teil-Einspruchsentscheidung               | gesonderte Klagefrist aus deren Bekanntgabe erzeugen                             |
| keine berechenbare Rechtsfrist, aber interner Risikotermin | als offenen internen Prüftermin führen; ausdrücklich keine Rechtsbehelfsfrist    |

Ein Änderungs- oder Teilabhilfebescheid wird nach § 365 Abs. 3 AO grundsätzlich
Gegenstand des laufenden Einspruchsverfahrens. Er ist nicht mit einer
Teil-Einspruchsentscheidung nach § 367 Abs. 2a AO gleichzusetzen.

### Klagefrist

| Quelllage                                                                   | Kontrollfolge                                           |
| --------------------------------------------------------------------------- | ------------------------------------------------------- |
| geprüfter Bekanntgabetag einer Einspruchs- oder Teil-Einspruchsentscheidung | Klagefrist separat öffnen                               |
| `TEILABHILFE` ohne Entscheidung über den Einspruch                          | keine automatische Klagefrist                           |
| Klage nur vorbereitet                                                       | Klagefrist bleibt offen                                 |
| Klage mit Zeit, Weg und Nachweis erhoben                                    | erfüllt                                                 |
| bewusste Entscheidung gegen Klage                                           | nur mit dokumentierter fachlicher Disposition schließen |

### Mandantenanforderungen und Wiedervorlagen

| Quelle        | Offen                              | Geschlossen                             |
| ------------- | ---------------------------------- | --------------------------------------- |
| Anforderung   | `OPEN`, `IN_PROGRESS`, `RESPONDED` | `CLOSED` oder `CANCELLED` mit Grund     |
| Wiedervorlage | kein dokumentierter Abschluss      | Datum, Person und Ergebnis dokumentiert |

`RESPONDED` schließt eine Anforderung nicht, solange die Kanzleiprüfung
aussteht.

## Ausnahmen und Grenzfälle

- Frist und fachliches Verfahren dürfen nicht in einem einzigen Booleschen
  Wert zusammenfallen.
- Ein Versandstatus ohne Übermittlungsnachweis ist keine sichere
  Fristerledigung.
- Eine Teil-Einspruchsentscheidung kann nur für den entschiedenen Teil eine
  Klagefrist auslösen.
- Vertretungs- und Zuständigkeitswechsel, neue Bekanntgabetage und
  Wiedereinsetzung benötigen eigene fachliche Ereignisse.
- Zugriffsfilter dürfen eine Frist nicht für die zuständige Kontrollperson
  unsichtbar machen.

### Terminologie

Bei Verwaltungsakten ist regelmäßig von **Bestandskraft** beziehungsweise
Unanfechtbarkeit zu sprechen. **Rechtskraft** ist primär die Terminologie für
gerichtliche Entscheidungen. TaxTronik verwendet für Verwaltungsakte
`BESTANDSKRAEFTIG`. Der Status wird nicht allein aus Zeitablauf gesetzt, sondern
verlangt einen Ereignistag, eine nachvollziehbare Begründung von mindestens
zehn Zeichen und speichert die handelnde Person. Die Server-Action lässt den
Übergang nur für Admin oder Partner zu.

Die weiteren Gates hängen vom Ausgangsstatus ab: Aus `GEPRUEFT` muss die
Einspruchsfrist den Status `CALCULATED` haben, ohne offenen manuellen
Prüfbedarf vorliegen und am dokumentierten Ereignistag abgelaufen sein; ein
bereits dokumentierter Einspruch sperrt den Abschluss. Der Fristtag selbst ist
gesperrt; der Übergang ist technisch frühestens am Folgetag möglich. Aus
`ZURUECKGEWIESEN` gilt dasselbe für die dokumentierte Klagefrist. Für die
zugelassenen Übergänge aus `ABGEHOLFEN` und `KLAGE` bestehen diese besonderen
Einspruchs-/Klagefrist-Gates derzeit nicht.

### Tägliche Abschlusskontrolle als Kanzleiregel

Admin oder Partner können einmal pro Tenant und Kalendertag einen tenantweiten
Snapshot aller heute fälligen und bereits überfälligen offenen Fristen
dokumentieren. Sind offene Fristen vorhanden, ist eine Eskalationsnotiz Pflicht.
Der Snapshot enthält aus Datenschutzgründen nur Quelle, eine der technischen
Kontrollarten `CALCULATED_CONTROL_PROPOSAL`,
`REVIEW_PENDING_CONTROL_PROPOSAL`, `INTERNAL_RISK` oder
`OPERATIONAL_DUE_DATE`, Fälligkeit und pseudonyme UUID-Referenzen auf Vorgang,
Mandant und Verantwortlichen; Namen und
fachliche Klartexttitel sind sowohl im Anwendungscode als auch durch eine
Datenbank-Positivliste ausgeschlossen. Er ist im App-Datenbankzugriff
append-only und erzeugt zusätzlich das auditierte Ereignis
`fristen.daily_review.complete`.

Alle Quellabfragen und der Insert laufen unter `REPEATABLE READ`. `snapshot_at`
wird von der Datenbank auf den Transaktionsbeginn gesetzt und bezeichnet den
konsistenten Lesestand; `reviewed_at` ist der spätere Insert-/Abschlusszeitpunkt.
Der fachliche Berlin-Kalendertag wird einmal aus der Datenbankuhr bestimmt und
durch alle Reads gereicht. Wechselt der Tag vor dem Insert, verwirft der
Datenbank-Trigger den Abschluss statt einen gemischten Stichtag zu speichern.

Diese Funktion dokumentiert die Kontrollsicht zu diesem Datenstand. Sie
erzwingt weder einen bestimmten Arbeitsschluss-Zeitpunkt noch eine zweite
prüfende Person, versendet keine Eskalation und prüft keinen Beleg der
fristwahrenden Handlung. Unveränderbare Protokollierung und Vier-Augen-Prinzip
sind strengere, fachlich noch ungeprüfte Kanzlei- und Produktvorgaben; sie
folgen nicht unmittelbar als konkrete Technikanforderung aus der
BFH-Entscheidung.

## Beispiele

### Frist erfüllt, Verfahren offen

Der Einspruch wurde fristgerecht übermittelt und ein Eingangsbeleg hinterlegt.
Die Einspruchsfrist ist erfüllt. Das Einspruchsverfahren bleibt gleichwohl
anhängig.

### Teilabhilfe

Das Finanzamt erlässt einen Änderungsbescheid, der nur teilweise abhilft. Der
Bescheid wird Gegenstand des laufenden Einspruchsverfahrens. Allein aus
`TEILABHILFE` entsteht keine Klagefrist. Bekanntgabetag und dokumentierende
Person werden als eigener, paariger Ereignisnachweis gespeichert; der Tag darf
nicht vor der Einspruchseinlegung liegen. Spätere Abhilfe,
Einspruchsentscheidung, Klageeinreichung und Bestandskraft dürfen nicht vor
diesem Tag liegen; der Nachweis bleibt bei Folgestatus erhalten.

### Bewusster Verzicht

Ein Berufsträger entscheidet begründet, keinen Einspruch einzulegen.
`GEPRUEFT` allein genügt nicht; die Kontrollfrist wird erst durch eine
dokumentierte Disposition geschlossen.

## Umsetzung in TaxTronik

`eintrag.ts` und `kontrollbuch.ts` leiten den Kontrollzustand aus dem
Quellvorgang ab; es gibt keinen frei editierbaren Erledigt-Schalter im
Kontrollbuch. Offene Einträge werden ohne untere Datumsgrenze geladen und nach
Dringlichkeit sortiert. Die aktuellen Wahrheitstabellen lauten insbesondere:

- Steuertermine schließen nur mit `DONE`, Abschlusszeit und handelnder Person;
  `SKIPPED` bleibt offen.
- Die Einspruchsfrist schließt nur mit dokumentierter Einlegung oder mit
  `BESTANDSKRAEFTIG` samt Ereignistag, Person und Begründung; aus `GEPRUEFT`
  greifen zusätzlich Berechnungs-, Prüf-, Ablauf- und Kein-Einspruch-Gate.
  Liegt die dokumentierte Einlegung nach dem Fristende, bleibt die Frist mit
  einem Wiedereinsetzungs-/Dispositionshinweis `OPEN`; der tatsächliche Vorgang
  wird nicht fälschlich als fristgerecht verworfen oder geschlossen.
- Ist die Rechtsfrist wegen ungeklärter Bekanntgabe-/Nachweislage leer, wird ein
  vorhandener `internalRiskDeadline` als eigener, fail-closed offener
  **interner Prüftermin** geführt. Anzeige, CSV und Tagesabschluss bezeichnen
  ihn ausdrücklich nicht als Rechtsbehelfsfrist. Eine später berechnete echte
  Einspruchsfrist verdrängt diesen Prüffall. Ein eigener strukturierter
  Abschlussgrund „nicht anwendbar“ ist hierfür noch nicht implementiert; bis
  dahin bleibt der Prüffall fail-closed offen.
- Eine Klagefrist entsteht nur bei `TEILEINSPRUCHSENTSCHEIDUNG` oder
  `ZURUECKGEWIESEN`; `TEILABHILFE` allein erzeugt keine. Sie schließt nur mit
  dokumentierter Klageeinreichung oder Bestandskraft-Disposition. Aus
  `ZURUECKGEWIESEN` ist dafür der vollständige Ablauf der dokumentierten
  Klagefrist Pflicht; der Fristtag selbst genügt nicht. Eine nach Fristende
  dokumentierte Klage bleibt analog als offener Prüffall sichtbar. Wechselt ein
  Vorgang nach einer Teil-Einspruchsentscheidung auf `ABGEHOLFEN`, bleibt eine
  bereits persistierte Klagefrist fail-closed in der Kontrollsicht, bis
  Einreichung oder eine vollständige Abschlussdisposition nachgewiesen ist.
- `TEILABHILFE` verlangt den Bekanntgabetag des Teilabhilfebescheids und die
  dokumentierende Person als paarigen Nachweis. Die Datenbank prüft, dass das
  Ereignis nicht vor der Einspruchseinlegung und kein Folgeereignis davor
  liegt; ein Folgestatus behält den Nachweis. Altbestände ohne diese eindeutig bezeichneten Tatsachen werden
  nicht geschätzt. Sie behalten den historischen Status; beim nächsten
  Fortschritt muss ein Mitarbeiter den Bekanntgabetag ausdrücklich aus der
  Akte bestätigen und wird als dokumentierende Person gespeichert.
- Anforderungen schließen nur mit `CLOSED`, Abschlusszeit und Person;
  `RESPONDED` und `CANCELLED` bleiben offen.
- Wiedervorlagen schließen nur mit gespeichertem Abschlusszeitpunkt und
  handelnder Person.

Die Kontrollsicht gibt `OPEN`, `CLOSED_FULFILLED` oder
`CLOSED_DISPOSITION` aus. `tagesabschluss.ts` erzeugt den beschriebenen
tenantweiten Tages-Snapshot; stabiler `REPEATABLE READ`-Lesestand,
DB-Stichtag, pseudonymisierte Eintragsstruktur einschließlich der stabilen
Kontrollart, Zugriff, Eindeutigkeit je Tag und Auditierung werden server- beziehungsweise
datenbankseitig durchgesetzt.

Der tägliche Reminder-Worker revalidiert bei Wiedervorlagen unmittelbar im
Notification-Insert-Tx den weiterhin offenen Quellvorgang, die unveränderte
Fälligkeit und die aktuelle Zuweisung. Für Pendelordner werden Status
`WITH_CLIENT`, Rückgabedatum, Mandat und Ersteller erneut gelesen.
Mandantenbezogene Empfänger müssen aktiv und nach der aktuellen
`OPEN`-/`RESTRICTED`-/Vertraulich-Policy berechtigt sein; bei internen
Wiedervorlagen wird zumindest die aktive Tenant-Zugehörigkeit geprüft.

## Bekannte Abweichungen und Grenzen

- Die Zielzustände `CLOSED_NOT_APPLICABLE` und `SUPERSEDED` sowie strukturierte
  Gründe für Nichtvornahme, Nichtanwendbarkeit, Ersatz und Stornierung sind
  nicht implementiert. Deshalb bleiben `SKIPPED` und `CANCELLED` bewusst offen,
  selbst wenn außerhalb des Kontrollmodells ein Freitextgrund existiert.
- Zeit und Person sind ein stärkerer Quellnachweis als ein Status allein, aber
  noch keine Referenz auf Versandprotokoll, Eingangsbeleg oder anderes
  unveränderbares Beweisdokument.
- Die Rollenbeschränkung auf Admin oder Partner ist keine technische Prüfung
  einer Berufsträgerqualifikation. Insbesondere Admin kann organisatorisch
  anders besetzt sein; ein Vier-Augen-Schritt und ein unveränderbar
  verknüpfter Entscheidungsnachweis fehlen.
- Das Bescheidmodell ist linear. Bei einer Teil-Einspruchsentscheidung kann die
  Klagefrist für den entschiedenen Teil parallel zum fortdauernden Einspruch
  über den Rest laufen; Gegenstände, Umfänge und parallele Kontrollzweige sind
  nicht strukturiert abgebildet.
- Der Tagesabschluss ist ein einmaliger Snapshot. Er aktualisiert keine
  Quellvorgänge, beweist nicht die fristwahrende Handlung, führt keinen
  automatischen Abschluss zum Arbeitstagende aus und erzwingt weder
  Vertretungsprüfung noch Vier-Augen-Kontrolle oder Zustellbestätigung einer
  Eskalation.
- Verspätete Einlegungen bleiben zwar abgeleitet offen und tragen einen
  Wiedereinsetzungs-/Dispositionshinweis; ein eigener strukturierter
  Wiedereinsetzungsworkflow mit Entscheidung, Nachweis und Abschlussstatus ist
  noch nicht implementiert.
- Der append-only Snapshot vermeidet Namen und Fachtitel. Pseudonyme UUIDs und
  die freie Eskalationsnotiz bleiben dennoch datenschutzrelevante Daten; eine
  kanzleispezifisch freizugebende Aufbewahrungsfrist und die Vorgabe, keine
  unnötigen Personendaten in die Notiz zu schreiben, bleiben erforderlich.
- Der CSV-Export bleibt ein auditierter Kontrollauszug und ist weder täglicher
  Abschluss noch Erledigungsnachweis.

Der Implementierungsstatus ist deshalb **teilweise**.

## Fachliche Prüffragen

- Welche Fristarten verlangen zwingend einen Versand- oder Eingangsbeleg?
- Welche Dispositionen sollen ein Vier-Augen-Prinzip erhalten?
- Wie werden Teilgegenstände und parallele Einspruchs-/Klagezweige technisch
  getrennt?
- Welche strukturierten Gründe schließen `SKIPPED`, `CANCELLED`, nicht
  anwendbare oder ersetzte Fristen?
- Wie wird die tägliche Abschlusskontrolle vollständig und vertretungssicher
  organisiert?
- Kann jede geschlossene Frist aus Quellstatus, Grund und Nachweis
  reproduziert werden?

## Technische Nachweise

Die referenzierten Tests prüfen die Quell-Wahrheitstabellen mit Zeit und Person,
Zeitfenster ohne untere Grenze, Zugriffsfilterung, getrennte Einspruchs- und
Klagefristen, `TEILABHILFE` mit eigenem paarigem Ereignisnachweis und ohne
Klagefrist, den Erhalt dieses Nachweises im Folgestatus, die fortbestehende
Kontrolle einer Klagefrist nach
`TEILEINSPRUCHSENTSCHEIDUNG -> ABGEHOLFEN`, interne Risikotermine ohne
Rechtsfristbehauptung sowie Sortierung. Der Worker-Test prüft den
Insert-Tx-Recheck offener Wiedervorlagen und Pendelordner, aktuelle
Zuweisungen, aktive interne Empfänger und den Mandantenzugriff. Die
Tagesabschluss-Tests prüfen tenantweite Vollständigkeit, Eskalationsnotiz,
Rollen-Gate, Eindeutigkeit, Auditierung, DB-gebundene Snapshot-/Abschlusszeit
und das Verbot von Klartextfeldern. Nicht belegt sind verknüpfte
Erledigungsdokumente, eine qualifikationsgebundene Berufsträgerfreigabe,
parallele Teilverfahren, automatischer Arbeitsschluss und Vier-Augen-Freigabe.
