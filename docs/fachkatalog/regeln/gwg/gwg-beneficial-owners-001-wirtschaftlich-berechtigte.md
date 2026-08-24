---
id: GWG-BENEFICIAL-OWNERS-001
title: Wirtschaftlich Berechtigte ermitteln, erfassen und plausibilisieren
domain: gwg
rule_type: statute
jurisdiction: DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Berufsträger Geldwäscheprävention
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: partial
  summary: >-
    TaxTronik verlangt bei Rechtsträgern mindestens einen wirtschaftlich
    Berechtigten, vollständige Personendaten, eine Beschreibung der Eigentums-
    und Kontrollstruktur und regelmäßig einen Transparenzregister-Nachweis.
    Die rechtliche Ermittlung, Schwellen-, Kontroll- und Auffanglogik sowie
    Stiftungs-, Trust- und Veranlassungsfälle werden nicht automatisch
    entschieden.
sources:
  - kind: official_law
    citation: § 3 GwG
    url: https://www.gesetze-im-internet.de/gwg_2017/__3.html
    checked_at: '2026-08-24'
    primary: true
  - kind: official_law
    citation: § 10 Abs. 1 Nr. 2 GwG
    url: https://www.gesetze-im-internet.de/gwg_2017/__10.html
    checked_at: '2026-08-24'
    primary: false
  - kind: official_law
    citation: § 11 Abs. 5 bis 7 GwG
    url: https://www.gesetze-im-internet.de/gwg_2017/__11.html
    checked_at: '2026-08-24'
    primary: false
  - kind: official_law
    citation: § 12 Abs. 3 und 4 GwG
    url: https://www.gesetze-im-internet.de/gwg_2017/__12.html
    checked_at: '2026-08-24'
    primary: false
  - kind: official_law
    citation: § 8 Abs. 1 GwG
    url: https://www.gesetze-im-internet.de/gwg_2017/__8.html
    checked_at: '2026-08-24'
    primary: false
code_refs:
  - apps/web/src/server/gwg/verification.ts
  - apps/web/src/server/gwg-onboarding/owner-submission.ts
  - apps/web/src/server/gwg-onboarding/submission-validation.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/gwg/owner-actions.ts
  - packages/db/prisma/schema.prisma
test_refs:
  - apps/web/src/server/gwg/__tests__/verification.test.ts
  - apps/web/src/server/gwg-onboarding/__tests__/owner-submission.test.ts
  - apps/web/src/server/gwg-onboarding/__tests__/submission-validation.test.ts
feature_refs:
  - FEATURES.md
  - docs/compliance/gwg.md
related_rules:
  - GWG-IDENTIFICATION-EVIDENCE-001
  - GWG-REPRESENTATIVE-AUTHORITY-001
  - GWG-RISK-REVIEW-001
  - GWG-SELF-ONBOARDING-001
tags:
  - wirtschaftlich-berechtigter
  - eigentumsstruktur
  - transparenzregister
---

# GWG-BENEFICIAL-OWNERS-001 — Wirtschaftlich Berechtigte ermitteln, erfassen und plausibilisieren

## Kurzfassung

Bei Rechtsträgern muss geklärt werden, welche natürlichen Personen letztlich
Eigentum oder Kontrolle ausüben beziehungsweise auf wessen Veranlassung die
Geschäftsbeziehung begründet wird. TaxTronik erfasst diese Personen, ihre
Risikodaten sowie eine freie Beschreibung der Eigentums- und Kontrollstruktur
und verlangt vor der Freigabe mindestens einen Datensatz.

Das Produkt berechnet nicht, wer nach § 3 GwG wirtschaftlich Berechtigter ist.
Schwellenwerte, mittelbare Kontrolle, fiktiv wirtschaftlich Berechtigte und
besondere Rechtsgestaltungen müssen fachlich ermittelt und dokumentiert werden.

## Wann gilt die Regel?

Die Regel gilt, wenn der Vertragspartner keine natürliche Person ist oder
Anhaltspunkte dafür bestehen, dass eine natürliche Person für einen Dritten
handelt. Sie betrifft sowohl neue Geschäftsbeziehungen als auch spätere Zweifel
oder relevante Änderungen der Eigentums- und Kontrollstruktur.

Die strukturierte Produktprüfung ist auf juristische Personen und
Personengesellschaften zugeschnitten. Besondere Stiftungen, Trusts,
Treuhandgestaltungen und reine Veranlassungsfälle werden nur über Freitext und
allgemeine Personendatensätze abgebildet.

## Benötigte Angaben

- Vertragspartner und Rechtsform
- natürliche Personen mit Vor- und Nachname
- im Produkt zusätzlich Geburtsdatum, Geburtsort, Wohnsitz und
  Staatsangehörigkeit
- unmittelbare oder mittelbare Beteiligungs- beziehungsweise Kontrollgrundlage
- Anteil, soweit sinnvoll bezifferbar
- PEP-Angabe je erfasster Person
- nachvollziehbare Beschreibung der Eigentums- und Kontrollstruktur
- Dokumentation der Ermittlungsschritte und Schwierigkeiten
- Nachweis der Transparenzregister-Registrierung oder Registerauszug, soweit
  einschlägig
- gegebenenfalls Grundlage eines fiktiv wirtschaftlich Berechtigten

## Entscheidungslogik

| Wenn                                                                                                        | Dann                                                                       | Begründung                                            |
| ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------- |
| Rechtsträger ohne erfassten wirtschaftlich Berechtigten                                                     | Freigabe blockieren                                                        | Ermittlung ist im Snapshot nicht dokumentiert         |
| Pflichtdaten einer erfassten Person fehlen                                                                  | Freigabe blockieren                                                        | Produkt verlangt einen vollständigen Personensnapshot |
| Eigentums-/Kontrollstruktur ist nicht beschrieben                                                           | Freigabe blockieren                                                        | Ermittlungsschritt muss nachvollziehbar sein          |
| Eingetragener Rechtsträger ohne Transparenzregister-Nachweis                                                | Freigabe blockieren                                                        | Produkt verlangt den unterstützten Registerabgleich   |
| Angaben stimmen mit Transparenzregister überein und es bestehen keine weiteren Zweifel oder höheren Risiken | Berufsträger kann Angemessenheit der Prüfung beurteilen                    | § 12 Abs. 3 GwG bleibt eine fachliche Prüfung         |
| Kein realer wirtschaftlich Berechtigter kann trotz umfassender Prüfung ermittelt werden                     | Auffangfall manuell bestimmen und Ermittlungsschwierigkeiten dokumentieren | § 3 Abs. 2 GwG; keine Automatik                       |
| Eigentums- oder Kontrollangaben ändern sich                                                                 | Neuer Prüfzyklus und erneute Bestätigung                                   | Frühere Ermittlung kann überholt sein                 |

## Ausnahmen und Grenzfälle

- Mehr als 25 Prozent Kapital- oder Stimmrechtsanteil ist nur ein Teil der
  gesetzlichen Ermittlung; vergleichbare und mittelbare Kontrolle bleibt
  gesondert zu prüfen.
- Fiktiv wirtschaftlich Berechtigte dürfen erst nach umfassenden Prüfungen und
  unter den gesetzlichen Voraussetzungen angesetzt werden. Das Produkt hat
  dafür kein eigenes Kennzeichen.
- Stiftungen und Trusts können mehrere gesetzlich definierte Personengruppen
  umfassen, die das flache Owner-Modell nicht vollständig unterscheidet.
- Ein Transparenzregisterauszug ersetzt nicht in jedem Fall die eigene
  Erhebung beim Vertragspartner und die risikoorientierte Plausibilisierung.
- Eine Person kann gleichzeitig wirtschaftlich Berechtigter und Vertreter sein;
  die Doppelrolle muss ausdrücklich verknüpft werden.

## Beispiele

### Normalfall

Eine natürliche Person hält unmittelbar 100 Prozent der GmbH-Anteile. Sie wird
mit vollständigen Personendaten erfasst, die Struktur wird beschrieben und der
Transparenzregisterauszug wird als sauberer GwG-Beleg hinterlegt. Der
Berufsträger plausibilisiert die Übereinstimmung manuell.

### Grenzfall

Mehrere Gesellschaften halten mittelbar Anteile; keine natürliche Person liegt
offensichtlich über einer numerischen Schwelle. TaxTronik darf nicht automatisch
einen Geschäftsführer als fiktiv wirtschaftlich Berechtigten bestimmen. Die
Kontrollstruktur und die umfassenden Ermittlungsschritte sind manuell zu prüfen
und zu dokumentieren.

## Umsetzung in TaxTronik

Wirtschaftlich Berechtigte sind eigene, an den jeweiligen Prüfsnapshot
gebundene Datensätze. Self-Onboarding und Staff-Oberfläche erfassen
Personenangaben, Beteiligungsangabe, PEP-Status und Nachweise. Das zentrale Gate
verlangt bei Rechtsträgern mindestens eine Person, vollständige Kerndaten und
eine Beschreibung der Eigentumsstruktur.

Bei einem registrierten Rechtsträger muss vor der finalen Freigabe ein
verfügbarer `TRANSPARENZREGISTER_AUSZUG` vorliegen. Der Mandant muss ihn im
Self-Service nicht zwingend beschaffen; die Kanzlei kann ihn anschließend
hinterlegen. Alle inhaltlichen Schlussfolgerungen bleiben manuell.

## Bekannte Abweichungen und Grenzen

- Schwellenwerte, mittelbare Beteiligungen und vergleichbare Kontrolle werden
  nicht berechnet oder plausibilisiert.
- Der fiktiv wirtschaftlich Berechtigte ist nicht als eigener Typ mit
  dokumentierten erfolglosen Ermittlungsschritten modelliert.
- Stiftungs-, Trust-, Treuhand- und Veranlassungsfälle besitzen keine
  vollständige strukturierte Entscheidungslogik.
- Es gibt keinen automatischen Abruf und keinen amtlichen Abgleich des
  Transparenzregisters.
- Das Produkt erzwingt bei `noRegisterEntry` keinen
  Transparenzregister-Nachweis; ob diese Erklärung im konkreten Fall auch die
  Transparenzregisterpflicht ausschließt, wird nicht geprüft.
- Etwaige Unstimmigkeitsmeldungen an das Transparenzregister sind kein
  Produktworkflow.

Der Implementierungsstatus ist deshalb **teilweise**.

## Fachliche Prüffragen

- Welche Rechtsträger und Rechtsgestaltungen müssen strukturiert unterschieden
  werden?
- Wie wird die mittelbare Kontrolle nachvollziehbar dokumentiert?
- Braucht der fiktiv wirtschaftlich Berechtigte ein eigenes Kennzeichen und
  Pflichtprotokoll der umfassenden Prüfung?
- Welche Registerabweichungen lösen welche organisatorischen Schritte aus?
- Sind die zusätzlich erzwungenen Personendaten in jedem Risikofall angemessen?

## Technische Nachweise

Schema, Owner-Submission und Verifikationsgate belegen die gespeicherten
Personendaten, PEP-Angabe, Pflichtstruktur und den Registerbeleg. Tests prüfen
fehlende Personendaten, ungültige Beteiligungsangaben, Zeitplausibilität,
fehlende Struktur- und Registerbelege sowie Doppelrollen. Sie belegen nicht die
rechtliche Ermittlung der wirtschaftlich Berechtigten.
