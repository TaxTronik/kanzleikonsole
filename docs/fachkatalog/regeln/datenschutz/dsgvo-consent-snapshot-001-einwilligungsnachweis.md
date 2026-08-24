---
id: DSGVO-CONSENT-SNAPSHOT-001
title: Angezeigte Einwilligungs- und Hinweisfassung unverändert nachweisen
domain: datenschutz
rule_type: product_rule
jurisdiction: EU/DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Berufsträger Datenschutz
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: implemented
  summary: >-
    Neue Erklärungen starten ohne freiwillige Vorauswahl und speichern die
    angezeigte Hinweisfassung, kanonische Optionen sowie verknüpfte
    Dienstleister append-only. Widerrufe entfernen nur freiwillige Auswahl;
    die Eignung der Rechtsgrundlage bleibt außerhalb der Produktregel.
sources:
  - kind: product_documentation
    citation: Benutzerhandbuch Administration, Datenschutz-Einwilligungen und Dienstleister
    path: docs/anwenderdoku/administration.md
    checked_at: '2026-08-24'
    primary: true
  - kind: official_law
    citation: Art. 5 Abs. 2, Art. 7 und Art. 28 DSGVO
    url: https://eur-lex.europa.eu/eli/reg/2016/679/oj?locale=de
    checked_at: '2026-08-24'
    primary: false
code_refs:
  - apps/web/src/server/privacy/consent.ts
  - apps/web/src/server/privacy/consent-catalog.ts
  - apps/web/src/server/privacy/service.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/privacy/actions.ts
test_refs:
  - apps/web/src/server/privacy/__tests__/consent.test.ts
  - apps/web/src/server/privacy/__tests__/consent-catalog.test.ts
  - apps/web/src/server/privacy/__tests__/consent-display.test.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/privacy/__tests__/actions.test.ts
feature_refs:
  - docs/anwenderdoku/administration.md
related_rules:
  - DSGVO-OPERATIONAL-RETENTION-001
tags:
  - einwilligung
  - widerruf
  - snapshot
---

# DSGVO-CONSENT-SNAPSHOT-001 — Angezeigte Einwilligungs- und Hinweisfassung unverändert nachweisen

## Kurzfassung

TaxTronik trennt freiwillige Einwilligungsoptionen von erforderlichen
Kenntnisnahmen oder Bestätigungen. Neue Erklärungen enthalten keine
vorausgewählte freiwillige Option. Gespeichert werden die tatsächlich
angezeigte Hinweisfassung, kanonische Optionsdaten und gegebenenfalls ein
Snapshot des zugeordneten Dienstleisters; spätere Katalogänderungen schreiben
historische Erklärungen nicht um.

## Wann gilt die Regel?

Die Regel gilt für Einwilligungs- und Hinweiserklärungen, die über die
interne Erfassung oder das öffentliche Onboarding in TaxTronik abgegeben
werden. Sie entscheidet nicht, ob Einwilligung im konkreten Prozess die
richtige Rechtsgrundlage ist, ob sie freiwillig erteilt werden kann oder ob ein
Auftragsverarbeitungsvertrag erforderlich und wirksam ist.

## Benötigte Angaben

- aktive, vollständig validierte Katalogrevision
- angezeigter Datenschutzhinweis samt Fassung und Inhalt
- angebotene freiwillige Optionen mit Zweck und Bezeichnung
- getrennte erforderliche Bestätigungen
- gegebenenfalls verknüpfter Dienstleister und angezeigte Vertragsmetadaten
- tatsächlich ausgewählte Optionen und erklärende Person

## Entscheidungslogik

| Wenn                                        | Dann                                                            | Begründung                                                   |
| ------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------ |
| neue Erklärung beginnt                      | alle freiwilligen Optionen unselektiert setzen                  | keine Vorauswahl durch das Produkt                           |
| Browser sendet Optionsdaten                 | anhand des aktiven Katalogs kanonisieren                        | Clientwerte dürfen Bezeichnung oder Zweck nicht bestimmen    |
| Katalog oder Dienstleister ist inkonsistent | neue Erklärung fail-closed blockieren                           | kein uneindeutiger Nachweis                                  |
| Erklärung wird gespeichert                  | Hinweis, Optionen und Dienstleister-Snapshot append-only binden | historischer Anzeige- und Auswahlstand                       |
| freiwillige Einwilligung wird widerrufen    | nur widerrufbare Auswahl entfernen und neuen Nachweis erzeugen  | Pflichtbestätigung ist keine widerrufene freiwillige Auswahl |
| Katalog ändert sich später                  | alte Erklärung unverändert lassen                               | historische Nachvollziehbarkeit                              |

## Ausnahmen und Grenzfälle

Benutzerdefinierte Pflichtbestätigungen sind nur in der dafür vorgesehenen
Kategorie zulässig; eingebaute Kommunikations- und Marketingoptionen dürfen
nicht nachträglich als verpflichtend umgedeutet werden. Ein eingefrorener
Dienstleistername oder AVV-Zeitraum belegt nur die angezeigten Metadaten, nicht
Bestand, Wirksamkeit oder Erforderlichkeit des Vertrags. Eine erteilte Auswahl
beweist auch nicht die tatsächliche technische Deaktivierung aller
Verarbeitungen nach einem Widerruf.

## Beispiele

### Normalfall

Ein Kontakt sieht zwei freiwillige Kommunikationsoptionen und wählt nur eine.
TaxTronik speichert diese Auswahl zusammen mit Hinweistext, Katalogrevision und
Dienstleister-Snapshot. Eine spätere Umbenennung verändert den Nachweis nicht.

### Grenzfall

Der gespeicherte Katalog verweist auf einen nicht mehr vorhandenen
Dienstleister. Das Produkt sperrt die neue Erfassung, bis ein Administrator
den Katalog kontrolliert repariert hat. Historische Snapshots bleiben lesbar.

## Umsetzung in TaxTronik

`consent-catalog.ts` validiert Revision, Optionen, Zwecke und
Dienstleisterbezüge. `consent.ts` erzeugt unselektierte Ausgangswerte,
kanonisiert Eingaben, persistiert append-only und bildet Widerrufe als neuen
Stand ab. `service.ts` lädt Hinweis- und Anbieterdaten. Eine Display-Revision
verhindert, dass eine zwischen Anzeige und Speicherung geänderte Konfiguration
still akzeptiert wird.

## Bekannte Abweichungen und Grenzen

Keine bekannte technische Abweichung innerhalb des beschriebenen Snapshot-,
Vorauswahl- und Widerrufsscopes. Außerhalb liegen die fachliche Wahl der
Rechtsgrundlage, Freiwilligkeit im konkreten Verhältnis, Kopplungsfragen,
Nachweis der tatsächlichen Abschaltung, Vertragsprüfung nach Art. 28 DSGVO und
die Richtigkeit kanzleiseitiger Texte.

## Fachliche Prüffragen

- Welche Prozesse dürfen tatsächlich auf Einwilligung gestützt werden?
- Sind Zweck, Freiwilligkeit und Widerrufsinformation je Option ausreichend?
- Welche erforderlichen Bestätigungen sind keine Einwilligungen und wie sind sie zu benennen?
- Wie wird die operative Umsetzung eines Widerrufs außerhalb des Snapshots nachgewiesen?

## Technische Nachweise

Die Tests belegen fehlende Vorauswahl, kanonische Serverwerte,
Katalogvalidierung, Dienstleister-Snapshots, Display-CAS, append-only
Persistenz und den Erhalt erforderlicher Bestätigungen beim Widerruf. Sie
belegen keine datenschutzrechtliche Eignung einer Option.
