---
id: TAX-DEADLINE-ANNUAL-001
title: Kontrolltermin für kalenderjährige Jahressteuererklärungen bestimmen
domain: fristen-und-bescheide
rule_type: statute
jurisdiction: DE
validity:
  valid_from: '2019-01-01'
  valid_until: null
professional_owner_role: Berufsträger Steuerrecht
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: partial
  summary: >-
    Der Steuertermingenerator berechnet für vier Jahreserklärungsarten einen
    Kontrolltermin aus Besteuerungsjahr, Beratungskennzeichen und
    Tenant-Kalender. Sonderfälle mit anderen Fristen erfordern eigene Prüfung.
sources:
  - kind: official_law
    citation: § 149 Abs. 2 bis 5 AO, Abgabe der Steuererklärungen
    url: https://www.gesetze-im-internet.de/ao_1977/__149.html
    checked_at: '2026-11-20'
    primary: true
  - kind: official_law
    citation: Art. 97 § 36 Abs. 1 und Abs. 3 Nr. 1 bis 4 EGAO, Übergangsfristen
    url: https://www.gesetze-im-internet.de/aoeg_1977/art_97__36.html
    checked_at: '2026-11-20'
    primary: true
  - kind: official_law
    citation: § 18 Abs. 3 UStG, Umsatzsteuererklärung und kürzerer Besteuerungszeitraum
    url: https://www.gesetze-im-internet.de/ustg_1980/__18.html
    checked_at: '2026-11-20'
    primary: true
  - kind: official_guidance
    citation: AEAO zu § 149 AO, Ausgabe 2026, Abgabefristen und Fallunterscheidungen
    url: https://ao.bundesfinanzministerium.de/ao/2026/Abgabenordnung/Vierter-Teil/Zweiter-Abschnitt/Zweiter-Unterabschnitt/Paragraf-149/inhalt.html
    checked_at: '2026-11-20'
    primary: false
code_refs:
  - packages/tax/src/engine.ts
  - packages/tax/src/materialize.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/tax-schedule/tax-schedule-form.tsx
test_refs:
  - packages/tax/src/__tests__/engine.test.ts
feature_refs:
  - docs/anwenderdoku/kalender-fristen-bescheide.md
related_rules:
  - TAX-DEADLINE-WORKDAY-001
  - TAX-DEADLINE-AUTOREQUEST-001
  - TAX-CONTROL-STATUS-001
tags:
  - jahreserklaerung
  - beratungsfrist
---

# TAX-DEADLINE-ANNUAL-001 — Kontrolltermin für kalenderjährige Jahressteuererklärungen bestimmen

## Kurzfassung

Für eine kalenderjährige Pflichtsteuererklärung ergibt sich der
Regeltermin aus dem Besteuerungsjahr und der qualifizierten Beauftragung zur
Erstellung. Für 2019 bis 2024 gelten je nach Fall Übergangsfristen.
Die Kanzlei prüft besondere Abgabepflichten, abweichende Fristen und den örtlichen Kalender.

## Wann gilt die Regel?

Dieser Entwurf betrachtet die Besteuerungszeiträume ab 2019 für reguläre
Einkommensteuer-Pflicht-, Körperschaftsteuer- und Umsatzsteuer-Jahreserklärungen
sowie Erklärungen zur Festsetzung des Gewerbesteuermessbetrags.
Vorauszahlungen, Lohnsteuer-Anmeldungen und Umsatzsteuer-Voranmeldungen haben eigene Fristen.

## Benötigte Angaben

- Art der geschuldeten Erklärung und Kalenderjahr des Besteuerungszeitraums
- Beauftragung zur Erstellung im Sinne des § 149 Abs. 3 AO
- Vorabanforderung, individuelle Fristregelung und mögliche Sondertatbestände
- für das Fristende maßgeblicher Feiertagsort und Kalenderstand

## Entscheidungslogik

Für den Regelfall nach § 149 Abs. 2 Satz 1 oder Abs. 3 AO gelten vor einer
Werktagsverschiebung folgende Termine:

| Besteuerungsjahr | Ohne qualifizierte Beauftragung | Mit qualifizierter Beauftragung            |
| ---------------- | ------------------------------- | ------------------------------------------ |
| 2019             | 31.07.2020                      | 31.08.2021                                 |
| 2020             | 31.10.2021                      | 31.08.2022                                 |
| 2021             | 31.10.2022                      | 31.08.2023                                 |
| 2022             | 30.09.2023                      | 31.07.2024                                 |
| 2023             | 31.08.2024                      | 31.05.2025                                 |
| 2024             | 31.07.2025                      | 30.04.2026                                 |
| Ab 2025          | 31. Juli des Folgejahres        | letzter Februartag des zweiten Folgejahres |

Die Übergangsregel für beratene Fälle 2019 steht in Art. 97 § 36 Abs. 1 EGAO.
Für die Folgejahre regelt Abs. 3 Nr. 1 die beratenen und Nr. 3 die
unberatenen Regelfälle. Anschließend gilt die Prüfung nach `TAX-DEADLINE-WORKDAY-001`.

## Ausnahmen und Grenzfälle

Eine Vorabanforderung nach § 149 Abs. 4 AO und eine individuell gewährte
Verlängerung können den Termin ändern. Für freiwillige Antragsveranlagungen
nach § 46 Abs. 2 Nr. 8 EStG sowie land- und forstwirtschaftliche Gewinne
mit abweichendem Wirtschaftsjahr gelten gesonderte Voraussetzungen und Termine.
Bei Umsatzsteuer sind insbesondere § 149 Abs. 5 AO bei beendeter Tätigkeit
und § 18 Abs. 3 Satz 2 UStG bei einem kürzeren Besteuerungszeitraum zu prüfen.

## Beispiele

Eine kalenderjährige Körperschaftsteuererklärung 2019 mit qualifizierter
Beauftragung war im Regelfall bis Dienstag, 31. August 2021, abzugeben.
Ohne diese Beauftragung galt im Regelfall Freitag, 31. Juli 2020.
Für 2025 fällt der beratene Regeltermin auf Sonntag, 28. Februar 2027.
Ohne örtlichen Ausschlusstag am Folgetag ergibt sich Montag, 1. März 2027.

## Umsetzung in TaxTronik

Die Kanzlei aktiviert die Erklärungsart und die Einstellung **Beraten** je
Mandant. Der Generator bestimmt den Termin aus dem Besteuerungsjahr und dem
Tenant-Kalender. Die Konfigurationsseite benennt Fälle, für die die Kanzlei
einen individuellen Kontrolltermin ermitteln muss.

## Bekannte Abweichungen und Grenzen

Der bisherige Code wandte für beratene Fälle 2019 die reguläre Februarfrist
an. Die Übergangstabelle berücksichtigt jetzt den 31. August 2021.
Der Generator kennt weder das tatsächliche Mandatsverhältnis noch
Betriebseinstellung, landwirtschaftliches Wirtschaftsjahr, individuelle
Fristbescheide oder Antragsveranlagungen. Die Einstellung **Beraten** ist
eine Kanzleiangabe. Für Zeiträume vor 2019 ist der historische Rechtsstand
in diesem Entwurf ungeprüft.

## Fachliche Prüffragen

- Welche Unterlagen belegen die Beauftragung und eventuelle Vorabanforderungen?
- Wie werden abweichende Wirtschaftsjahre, Betriebseinstellungen und
  individuelle Fristbescheide als eigene Fakten erfasst?
- Welche bereits gespeicherten Kontrolltermine erfordern historische Nachprüfung?

## Technische Nachweise

`engine.test.ts` prüft die Beratungsentscheidung für alle vier
Erklärungsarten im Jahr 2019, den Übergang zur Regelfrist, regionale
Feiertage, den 29. Februar im Schaltjahr und die Zuordnung zum
Besteuerungsjahr. Die Prüfdaten für 2019 verweisen auf Art. 97 § 36 EGAO.
