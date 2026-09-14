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
    Neue Erklärungen starten ohne Vorauswahl und speichern die
    angezeigte Hinweisfassung, kanonische Optionen sowie verknüpfte
    Dienstleister append-only. Die Kanzlei kann jede aktive Option für den
    Onboardingabschluss verlangen. Diese Vorgabe sperrt keine Widerrufe von
    Kommunikations- oder Marketingeinwilligungen;
    die Eignung der Rechtsgrundlage bleibt außerhalb der Produktregel.
sources:
  - kind: product_documentation
    citation: Benutzerhandbuch Administration, Datenschutz-Einwilligungen und Dienstleister
    path: docs/anwenderdoku/administration.md
    checked_at: '2026-09-14'
    primary: true
  - kind: official_law
    citation: Art. 5 Abs. 2, Art. 6, Art. 7 und Art. 28 DSGVO
    url: https://eur-lex.europa.eu/eli/reg/2016/679/oj?locale=de
    checked_at: '2026-09-14'
    primary: false
code_refs:
  - apps/web/src/server/privacy/consent.ts
  - apps/web/src/server/privacy/consent-catalog.ts
  - apps/web/src/server/privacy/service.ts
  - apps/web/src/server/privacy/notice.ts
  - apps/web/src/components/consent-fields.tsx
  - apps/web/src/app/gwg-onboarding/wizard-steps.tsx
  - apps/web/src/app/staff/(protected)/admin/privacy/page.tsx
  - apps/web/src/app/staff/(protected)/admin/privacy/consent-options-editor.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/privacy/actions.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/privacy/page.tsx
test_refs:
  - apps/web/src/server/privacy/__tests__/consent.test.ts
  - apps/web/src/server/privacy/__tests__/consent-catalog.test.ts
  - apps/web/src/server/privacy/__tests__/consent-display.test.ts
  - apps/web/src/server/privacy/__tests__/consent-policy-ui.test.ts
  - apps/web/src/app/gwg-onboarding/__tests__/bound-draft-submit.test.ts
  - apps/web/src/app/staff/(protected)/admin/privacy/__tests__/actions.test.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/privacy/__tests__/actions.test.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/privacy/__tests__/page.test.tsx
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

Die Kanzlei legt für jede aktive Datenschutzoption fest, ob sie für den
Abschluss des öffentlichen Onboardings bestätigt werden muss. Neue Erklärungen
enthalten keine vorausgewählte Option. Gespeichert werden die tatsächlich
angezeigte Hinweisfassung, kanonische Optionsdaten und gegebenenfalls ein
Snapshot des zugeordneten Dienstleisters; spätere Katalogänderungen schreiben
historische Erklärungen nicht um.

Die Kenntnisnahme der Datenschutzhinweise ist im öffentlichen Onboarding
zwingend und wird getrennt von den auswählbaren Optionen angezeigt. Sie
bestätigt den Hinweis, erteilt aber keine allgemeine Kommunikationseinwilligung.
Hinweisfassung 4 erläutert die von der Kanzlei vorgegebenen Pflichtauswahlen.
„Zwingend“ bezeichnet eine Abschlussvoraussetzung, keine Rechtsgrundlage oder
Widerrufssperre. Geeignete sichere Kontaktwege bleiben mit dem Mandanten
abzustimmen.

## Wann gilt die Regel?

Die Regel gilt für Einwilligungs- und Hinweiserklärungen, die über die
interne Erfassung oder das öffentliche Onboarding in TaxTronik abgegeben
werden. Sie entscheidet nicht, ob Einwilligung im konkreten Prozess die
richtige Rechtsgrundlage ist, ob sie freiwillig erteilt werden kann oder ob ein
Auftragsverarbeitungsvertrag erforderlich und wirksam ist.

## Benötigte Angaben

- aktive, vollständig validierte Katalogrevision
- angezeigter Datenschutzhinweis samt Fassung und Inhalt
- angebotene Optionen mit Zweck, Bezeichnung und Abschlussvorgabe
- getrennte erforderliche Bestätigungen
- gegebenenfalls verknüpfter Dienstleister und angezeigte Vertragsmetadaten
- tatsächlich ausgewählte Optionen und erklärende Person

## Entscheidungslogik

| Wenn                                                       | Dann                                                                              | Begründung                                                                   |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| neue Erklärung beginnt                                     | alle Optionen unselektiert setzen                                                 | keine Vorauswahl durch das Produkt                                           |
| Kanzlei markiert eine aktive Option als zwingend           | Bestätigung beim öffentlichen Abschluss serverseitig verlangen                    | Vorgabe gilt für Standardoptionen und eigene Optionen in jedem Bereich       |
| Pflichtauswahl fehlt im öffentlichen Onboarding            | Übermittlung abweisen                                                             | keine Umgehung durch manipulierte Browserdaten                               |
| Browser sendet Optionsdaten                                | anhand des aktiven Katalogs kanonisieren                                          | Clientwerte dürfen Bezeichnung oder Zweck nicht bestimmen                    |
| Katalog oder Dienstleister ist inkonsistent                | neue Erklärung fail-closed blockieren                                             | kein uneindeutiger Nachweis                                                  |
| Erklärung wird gespeichert                                 | Hinweis, Optionen und Dienstleister-Snapshot append-only binden                   | historischer Anzeige- und Auswahlstand                                       |
| Kommunikations- oder Marketingeinwilligung wird widerrufen | auch eine beim Onboarding zwingende Auswahl entfernen und neuen Nachweis erzeugen | Abschlussvorgabe ist keine Widerrufssperre                                   |
| eigene Pflichtbestätigung im Bereich OTHER liegt vor       | beim Widerruf anhand ihres historischen Snapshots erhalten                        | Bestätigung ist keine widerrufene Kommunikations- oder Marketingeinwilligung |
| Katalog ändert sich später                                 | alte Erklärung unverändert lassen                                                 | historische Nachvollziehbarkeit                                              |

## Ausnahmen und Grenzfälle

Die bisherige Beschränkung konfigurierbarer Pflichtvorgaben auf eigene
OTHER-Bestätigungen entfällt. Die Kanzlei kann nun Standardoptionen und eigene
Optionen in allen drei Bereichen für den Onboardingabschluss verlangen. Das ist
eine Änderung der Produktregel, keine fachliche Freigabe einer konkreten
Pflichtauswahl. Frühere Erklärungen werden dadurch nicht nachträglich als
verpflichtend umgedeutet.

Ein eingefrorener Dienstleistername oder AVV-Zeitraum belegt nur die angezeigten Metadaten, nicht
Bestand, Wirksamkeit oder Erforderlichkeit des Vertrags. Eine erteilte Auswahl
beweist auch nicht die tatsächliche technische Deaktivierung aller
Verarbeitungen nach einem Widerruf.

Das Fehlen einer freiwilligen Kontaktfreigabe ist kein pauschales Verbot
notwendiger Mandatskommunikation. Umgekehrt erzeugt die Kenntnisnahme keine
pauschale Erlaubnis für alle Telefon- oder E-Mail-Kontakte. Die jeweils
einschlägige Rechtsgrundlage und gesetzliche Rechte bleiben maßgeblich.
Die getrennte Einstellung für E-Mail-Benachrichtigungen wird dadurch nicht
überschrieben. Dies löst den bisherigen Widerspruch zwischen dem als allgemeine
Kontakterlaubnis formulierten Auswahltext und den Datenschutzhinweisen auf;
historische Nachweise werden nicht umgedeutet.

## Beispiele

### Normalfall

Die Kanzlei markiert Telefon und E-Mail als zwingend und belässt Fax optional.
Ein Kontakt muss Telefon und E-Mail aktiv bestätigen, bevor er das öffentliche
Onboarding abschließen kann. TaxTronik speichert die Auswahl samt Hinweistext,
Katalogrevision und Dienstleister-Snapshot. Ein späterer Widerruf entfernt auch
diese Kommunikationsauswahl; die damalige Abschlussvorgabe sperrt ihn nicht.

### Grenzfall

Der gespeicherte Katalog verweist auf einen nicht mehr vorhandenen
Dienstleister. Das Produkt sperrt die neue Erfassung, bis ein Administrator
den Katalog kontrolliert repariert hat. Historische Snapshots bleiben lesbar.

## Umsetzung in TaxTronik

Das Symbol im Kopf der Datenschutz-Zentrale behält auch bei schmalen
Ansichten seine feste Größe. Die Textspalte darf umbrechen; diese technische
Layoutkorrektur ändert keine Option, Pflichtvorgabe oder gespeicherte Erklärung.

`consent-catalog.ts` validiert Revision, Optionen, Zwecke und
Dienstleisterbezüge. `consent.ts` erzeugt unselektierte Ausgangswerte,
kanonisiert Eingaben, persistiert append-only und bildet Widerrufe als neuen
Stand ab. `service.ts` lädt Hinweis- und Anbieterdaten. Eine Display-Revision
verhindert, dass eine zwischen Anzeige und Speicherung geänderte Konfiguration
still akzeptiert wird.

Vor der Kanonisierung prüft der Resolver sämtliche aktiven Dienstleisterbezüge,
auch bei nicht ausgewählten Optionen. Fehlt ein Anbieter, wird die neue
Erklärung im Portal und in der Kanzleierfassung abgewiesen. Der Sichtfilter
darf eine inkonsistente aktive Option insbesondere nicht ausblenden und damit
ihre Abschlussvorgabe umgehen. Inaktive Optionen bleiben aus der neuen
Erklärung ausgeschlossen. Tests prüfen diesen Fehlerfall für zwingende und
optionale eigene Optionen sowie eine zwingende Standardoption, einschließlich
einer zur sichtbaren Teilmenge passenden Displayrevision.

Die Oberfläche kennzeichnet die bereits serverseitig verlangte Kenntnisnahme
als „Zwingend“. Die Kanzlei kann diese Anforderung nicht abschalten.
`noticeAcknowledged: true` bleibt Voraussetzung der öffentlichen Übermittlung;
alle optionalen Auswahlen dürfen leer bleiben. `required` wird für jede aktive
Option ausgewertet; inaktive Optionen dürfen keine Pflichtvorgabe tragen.
`requiredSnapshot` friert die damalige Abschlussvorgabe ein. Beim Widerruf bleiben
nur als verpflichtend gespeicherte OTHER-Bestätigungen erhalten, während
Kommunikations- und Marketingauswahl unabhängig von der Abschlussvorgabe entfernt
wird. Der ergänzte Kommunikationstext
ist Bestandteil der versionierten und eingefrorenen Hinweisfassung, nicht nur
ein zusätzlicher Oberflächentext.

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
- Sind die von der Kanzlei vorgegebenen Pflichtauswahlen im konkreten Mandat zulässig?
- Wie wird die operative Umsetzung eines Widerrufs außerhalb des Snapshots nachgewiesen?

## Technische Nachweise

Die Tests belegen fehlende Vorauswahl, kanonische Serverwerte,
Katalogvalidierung, Dienstleister-Snapshots, Display-CAS, append-only
Persistenz und den Erhalt erforderlicher Bestätigungen beim Widerruf. Sie
belegen keine datenschutzrechtliche Eignung einer Option.

Regressionstests zur öffentlichen Übermittlung prüfen zusätzlich, dass eine
fehlende oder falsche Kenntnisnahme trotz ausgewählter Einwilligungen abgewiesen
wird und eine bestätigte Kenntnisnahme ohne weitere Auswahl zulässig bleibt,
sofern der Katalog keine weiteren Pflichtoptionen enthält. Katalog- und
Resolvertests prüfen Pflichtvorgaben in allen Bereichen, fehlende Legacy-Bools
trotz gefälschter Built-in-Snapshots sowie die Trennung zwischen Abschlussvorgabe
und Widerruf. Die Tests belegen keine rechtliche Zulässigkeit einer Pflichtvorgabe.

Die Kanzleiansicht bietet nach einem Teilwiderruf den Sammelwiderruf weiter an,
solange widerrufbare Auswahl besteht. Der Zähler umfasst Datenschutzoptionen
einschließlich erforderlicher Bestätigungen; er zählt nicht ausschließlich
Einwilligungen. SSR-Tests prüfen die Anzeige bei verbleibender Kommunikations-
und Marketingauswahl sowie bei ausschließlich erforderlicher OTHER-Bestätigung.
