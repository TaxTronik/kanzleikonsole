---
id: TCMS-SAMPLE-PROOF-001
title: Stichprobennachweis nur auf den deklarierten Rahmen und die konkrete Ziehung beziehen
domain: subsumtion-und-tcms
rule_type: product_rule
jurisdiction: DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Berufsträger TCMS und Qualitätssicherung
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: partial
  summary: >-
    TaxTronik bildet einen sortierten ID-Rahmen, lässt daraus eine Stichprobe
    ziehen und speichert Rahmen, Commitment, Backend-Metadaten, Nachweis und
    Treffer im Audit. Das belegt nicht die Vollständigkeit oder fachliche
    Angemessenheit des Rahmens und nicht die Qualität der anschließenden
    Nachschau.
sources:
  - kind: product_documentation
    citation: Anwenderdokumentation Subsumtion, TCMS und Quantenlos, Stichprobe und Nachweisgrenzen
    path: docs/anwenderdoku/subsumtion-tcms-quantenlos.md
    checked_at: '2026-08-24'
    primary: true
  - kind: internal_policy
    citation: Dokumentierte Produktgrenzen zu Quantum Randomness und Replay
    path: docs/assurance/known-limits.md
    checked_at: '2026-08-24'
    primary: false
  - kind: internal_policy
    citation: TCMS-Einordnung und Abgrenzung zu einer unabhängigen Prüfung
    path: docs/compliance/idw-ps980-tcms.md
    checked_at: '2026-08-24'
    primary: false
code_refs:
  - apps/web/src/server/risk/los.ts
  - apps/web/src/app/staff/(protected)/admin/quantenlos/actions.ts
test_refs:
  - apps/web/src/server/risk/__tests__/los.test.ts
feature_refs:
  - docs/anwenderdoku/subsumtion-tcms-quantenlos.md
  - docs/assurance/known-limits.md
  - docs/compliance/idw-ps980-tcms.md
related_rules:
  - RISK-ARCHIVE-SNAPSHOT-001
tags:
  - tcms
  - stichprobe
  - quantenlos
  - commitment
  - audit
---

# TCMS-SAMPLE-PROOF-001 — Stichprobennachweis nur auf den deklarierten Rahmen und die konkrete Ziehung beziehen

## Kurzfassung

TaxTronik erstellt für einen gewählten Zeitraum einen sortierten Rahmen aus
Subsumtions- oder Audit-IDs und übergibt nur diese opaken IDs an den
Risk-Layer. Nachweis, Rahmen, Backend-Metadaten und Treffer werden gemeinsam
im Audit gespeichert und können später gegen genau diesen gespeicherten
Rahmen geprüft werden. Damit ist die Ziehung nachvollziehbar, nicht aber die
Vollständigkeit oder fachliche Eignung der Grundgesamtheit und Nachschau.

## Wann gilt die Regel?

Die Regel gilt für administrative Quantenlos-Ziehungen mit Rahmenart
`subsumtion` oder `audit` und den Backends QPU, Simulator oder CSPRNG. Der
Zeitraum, die Rahmenart, die Stichprobengröße und das Backend werden vor dem
Engine-Aufruf ausgewählt. QPU-Aufträge können zunächst als wartender Job mit
dem unveränderten Rahmen gespeichert und später abgeholt werden.

Die Funktion ist ein technischer Auswahl- und Nachweisbaustein. Sie ist keine
IDW-Prüfung, kein Beleg für ein angemessenes oder wirksames TCMS und keine
fachliche Aussage über die gezogenen Fälle.

## Benötigte Angaben

- Tenant, berechtigter Admin oder Partner und aktiviertes Risk-Modul
- Rahmenart `subsumtion` oder `audit`
- Zeitraum von/bis
- fachlich begründete Stichprobengröße `k`
- bewusst gewähltes Backend und dessen Vertrauensannahmen
- vollständige Erfassungsgrundlage vor der Rahmenbildung
- verantwortliche Person und dokumentiertes Nachschauverfahren

## Entscheidungslogik

| Wenn                                     | Dann                                                                                                  | Begründung                                            |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Rahmenart `subsumtion`                   | alle im Zeitraum gefundenen Analyse-IDs aufsteigend sortieren                                         | deterministische deklarierte Grundliste               |
| Rahmenart `audit`                        | alle im Zeitraum gefundenen Audit-IDs aufsteigend sortieren und bei mehr als 50.000 abbrechen         | keine inhaltliche Vorauswahl, begrenzte Payloadgröße  |
| Rahmen leer oder `k` außerhalb `1..n`    | vor dem Engine-Aufruf abbrechen                                                                       | keine ungültige Stichprobe erzeugen                   |
| Engine liefert fertigen Nachweis         | Stichprobe auf Teilmenge des Rahmens und `n` auf Rahmengröße prüfen                                   | elementare Konsistenzkontrolle                        |
| QPU-Auftrag wartet                       | Job-ID, Commitment, `k`, Rahmen und Zeitraum tenantgebunden speichern und Beantragung auditieren      | spätere Abholung muss denselben Rahmen verwenden      |
| Ziehung finalisiert wird                 | Nachweis, vollständigen ID-Rahmen, Zeitraum, Rahmenart und Aufgaben in einem Audit-Ereignis speichern | spätere Re-Verifikation braucht Nachweis und Rahmen   |
| Subsumtions-Treffer Mandantenbezug haben | je Treffer eine Review-Wiedervorlage für den Ziehenden anlegen                                        | operative Nachschau anstoßen                          |
| gespeicherter Nachweis geprüft wird      | Nachweis und damaligen Rahmen an `/v1/los/pruefen` senden                                             | Prüfung der konkreten alten Ziehung, keine Neuziehung |

## Ausnahmen und Grenzfälle

Die Rahmenbildung kann nur Daten auswählen, die zum Abfragezeitpunkt in der
Datenbank vorhanden und vom gewählten Zeitfilter erfasst sind. Sie belegt
nicht, dass alle relevanten Vorgänge überhaupt angelegt, richtig datiert oder
unverändert vorhanden waren. Die UTC-Tagesgrenzen des Codes sind eine
technische Konvention und können bei lokal verstandenen Kalendertagen einer
gesonderten Prüfung bedürfen.

QPU, Simulator und CSPRNG haben unterschiedliche Vertrauensannahmen. Ein QPU-
Backend ist weder automatisch rechtlich noch fachlich überlegen. Die lokale
Finalisierung prüft ausdrücklich Teilmengenbezug und Rahmengröße; die
weitergehende Commitment-/Ableitungsprüfung wird an den Risk-Layer delegiert.

Für Subsumtions-Treffer wird die Review-Aufgabe dem Ziehenden zugewiesen. Das
beweist keine unabhängige zweite Person und keine korrekte Erledigung. Treffer
ohne Mandantenbezug oder inzwischen gelöschte Analysen erzeugen keine Aufgabe.
Audit-Treffer werden ohne automatische Wiedervorlage direkt angezeigt.

## Beispiele

### Normalfall

Für Mai werden drei vorhandene Subsumtions-IDs sortiert, `k = 2` und CSPRNG
gewählt. Der Nachweis enthält zwei IDs aus diesem Rahmen. TaxTronik speichert
Nachweis und alle drei Rahmen-IDs und erzeugt für verknüpfte Mandanten zwei
beziehungsweise entsprechend vorhandene Review-Aufgaben.

### Grenzfall

Eine im Mai tatsächlich bearbeitete Subsumtion wurde erst im Juni im System
angelegt. Sie fehlt im Mai-Rahmen, obwohl Commitment und spätere Prüfung des
vorhandenen Rahmens technisch gültig sind. Die Gültigkeit des
Auswahlbelegs heilt diese unvollständige Grundgesamtheit nicht.

## Umsetzung in TaxTronik

`los.ts` bildet den Rahmen, ruft den Risk-Layer außerhalb der
Datenbanktransaktion auf, verwaltet wartende QPU-Jobs und finalisiert Aufgaben
plus Audit atomar. `pruefeLosNachweis` lädt Nachweis und Rahmen aus dem Audit
und lässt genau diese Kombination prüfen. Die Admin-Actions validieren
Zeitraum, `k`, Backend und Rollen und reichen einen IBM-Token nur serverseitig
für QPU-bezogene Aufrufe weiter.

## Bekannte Abweichungen und Grenzen

Die Umsetzung ist teilweise. Rahmenbindung, Nachweisspeicherung,
Backend-Provenienz, elementare Konsistenzprüfungen, QPU-Pending-Pfad und Replay
sind implementiert und getestet. Nicht bewiesen werden Vollständigkeit der
Population, fachliche Angemessenheit von Zeitraum und `k`, statistische
Aussagekraft, Backend-Eignung, unabhängige Nachschau, richtige
Reviewentscheidung oder Wirksamkeit eines TCMS. Der Nachweis ist daher nur ein
Baustein der organisatorischen Kontrolle.

## Fachliche Prüffragen

- Wie wird die Vollständigkeit und sachgerechte Abgrenzung jeder
  Grundgesamtheit vor der Ziehung dokumentiert?
- Nach welcher Methode werden Zeitraum und Stichprobengröße festgelegt?
- Welche Person muss die gezogenen Fälle unabhängig prüfen und wie wird deren
  Ergebnis gegengezeichnet?
- Welche Backend-Vertrauensannahmen sind für welchen Kontrollzweck zulässig?
- Wie werden fehlende, gelöschte oder nicht mandantenbezogene Treffer
  nachverfolgt?

## Technische Nachweise

Der Test belegt synthetisch ID-only-Payloads, leere und ungültige Rahmen,
Teilmengenprüfung, Auditinhalt, Aufgaben, QPU-Pending/Abholung, beide
Rahmenarten und Replay gegen den gespeicherten Rahmen. Er belegt keine
Vollständigkeit realer Daten, keine statistische Angemessenheit, keine
fachliche Nachschau und keine unabhängige TCMS- oder IDW-Prüfung.
