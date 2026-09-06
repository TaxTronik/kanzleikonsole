---
id: RISK-EXTERNAL-ANONYMIZATION-001
title: Externe Recherche nur nach enger Datenminimierung und manueller Vorschau senden
domain: subsumtion-und-tcms
rule_type: professional_interpretation
jurisdiction: EU/DE
validity:
  valid_from: '2018-05-25'
  valid_until: null
professional_owner_role: Berufsträger Verschwiegenheit und Datenschutz
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: partial
  summary: >-
    Bekannte Mandanten- und Kontaktdaten werden vor n8n-Aufträgen
    deterministisch ersetzt, weitere Muster nur heuristisch. Text, Auftrag,
    Rechtsfrage, Normanker und Governance-Typ teilen einen Platzhalternamensraum.
    Die Vorschau ist weiterhin serverseitig nicht gebunden. Vollständige
    Anonymität und zulässige Verarbeitung sind nicht gewährleistet.
sources:
  - kind: official_law
    citation: § 203 StGB, Verletzung von Privatgeheimnissen und mitwirkende Personen
    url: https://www.gesetze-im-internet.de/stgb/__203.html
    checked_at: '2026-08-24'
    primary: true
  - kind: official_law
    citation: Art. 5, 25 und 32 DSGVO, Datenminimierung, Technikgestaltung und Sicherheit
    url: https://eur-lex.europa.eu/eli/reg/2016/679/oj?locale=de
    checked_at: '2026-08-24'
    primary: true
  - kind: product_documentation
    citation: Anwenderdokumentation Subsumtion, TCMS und Quantenlos, Recherchevorschau
    path: docs/anwenderdoku/subsumtion-tcms-quantenlos.md
    checked_at: '2026-08-24'
    primary: false
  - kind: internal_policy
    citation: Dokumentierte Produktgrenzen, externe KI als Hilfsmittel
    path: docs/assurance/known-limits.md
    checked_at: '2026-08-24'
    primary: false
code_refs:
  - apps/web/src/server/risk/anonymize.ts
  - apps/web/src/server/risk/research.ts
test_refs:
  - apps/web/src/server/risk/__tests__/anonymize.test.ts
  - apps/web/src/server/risk/__tests__/research-payload.test.ts
  - apps/web/src/server/risk/__tests__/research-vertraulich.test.ts
feature_refs:
  - docs/anwenderdoku/subsumtion-tcms-quantenlos.md
  - docs/assurance/known-limits.md
related_rules:
  - RISK-AI-SUGGESTION-001
  - RISK-ARCHIVE-SNAPSHOT-001
tags:
  - anonymisierung
  - n8n
  - recherche
  - verschwiegenheit
  - datenschutz
---

# RISK-EXTERNAL-ANONYMIZATION-001 — Externe Recherche nur nach enger Datenminimierung und manueller Vorschau senden

## Kurzfassung

TaxTronik ersetzt vor einem n8n-Rechercheauftrag bekannte Mandanten- und
Kontaktdaten durch Platzhalter und markiert zusätzliche heuristische Treffer.
Das Platzhalter-Mapping bleibt in der tenantgeschützten Anwendung und wird
nicht in den Outbound-Payload aufgenommen. Auch frei befüllte Normanker und
Governance-Typen durchlaufen dieselbe Ersetzung. Die Heuristik ist unvollständig;
deshalb sind Vorschau, bewusste Auswahl des Ausschnitts und eine rechtliche
beziehungsweise organisatorische Freigabe weiterhin erforderlich. Der Server
erzwingt oder bindet diese Vorschauprüfung aktuell nicht.

## Wann gilt die Regel?

Die Regel gilt für Vorschau und Versand von Rechercheaufträgen aus einer
Subsumtion an n8n. Sie beschreibt nur die produktseitige Datenreduktion. Ob
eine Offenbarung befugt, ein Dienstleister ordnungsgemäß eingebunden, eine
datenschutzrechtliche Grundlage vorhanden oder eine Drittlandübermittlung
zulässig ist, entscheidet diese Funktion nicht.

Für vertrauliche Analysen gilt zusätzlich: Eine Person ohne volle
Akteneinsicht darf beim Modus `excerpt` nur die exakt markierte Textstelle ohne
den sonst üblichen Kontext versenden und den vollständigen Sachverhalt nicht
auswählen.

## Benötigte Angaben

- berechtigter Mandanten- und Analysekontext
- ausgewählte Markierung oder bewusst gewählter Gesamtsachverhalt
- bekannte Mandanten- und Kontaktdaten aus den Stammdaten
- editierbarer anonymisierter Text und separater Rechercheauftrag
- manuelle Prüfung aller heuristischen Treffer und verbleibenden Geheimnisse
- dokumentierte Freigabe des externen Empfängers und Übermittlungswegs

## Entscheidungslogik

| Wenn                                                                               | Dann                                                                        | Begründung                                                       |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| bekannte Stammdaten im Text vorkommen                                              | durch stabile Platzhalter ersetzen und Mapping lokal speichern              | deterministische Datenminimierung und spätere Rückzuordnung      |
| E-Mail, Firma, IBAN, Steuernummer, Betrag oder Datum auf ein Heuristikmuster passt | heuristischen Platzhalter setzen und in der Vorschau hervorheben            | unsichere Treffer benötigen menschliche Kontrolle                |
| Vorschau erzeugt wird                                                              | noch nichts persistieren oder senden                                        | Berater soll den tatsächlichen Outbound-Text prüfen können       |
| finaler Text, Rechtsfrage, Auftrag, Normanker oder Governance-Typ versendet wird   | alle Freitextfelder im gemeinsamen Kontext anonymisieren                    | bekannte Klartextwerte auch in Zusatzfeldern reduzieren          |
| verschiedene Felder verschiedene Originalwerte enthalten                           | unterschiedliche Platzhalter reservieren und Wiederholungen wiederverwenden | Rückzuordnung darf keinen anderen Feldwert übernehmen            |
| Analyse vertraulich und Nutzer nur einer Markierung zugewiesen ist                 | Auszug ohne Kontextpolster bilden und `full` verbieten                      | fremder Falltext darf nicht über den Rechercheweg hinausgelangen |
| n8n-Antwort korreliert zurückkommt                                                 | lokales Mapping zur De-Anonymisierung verwenden                             | Originalwerte müssen den Outbound-Kanal nicht verlassen          |
| Heuristik keine Treffer zeigt                                                      | nicht als vollständige Anonymität werten                                    | Kontext und unbekannte Entitäten können weiterhin identifizieren |

## Ausnahmen und Grenzfälle

Deterministisch ersetzt werden nur bekannte strukturierte Werte. Die
Heuristik erkennt ausgewählte Muster, aber insbesondere nicht zuverlässig
beliebige Personennamen, Anschriften, seltene Sachverhalte,
Geschäftsgeheimnisse, indirekte Identifikatoren oder kontextbezogene
Kombinationen. Auch ein vollständig pseudonymisierter Text bleibt
personenbezogen, wenn das lokale Mapping eine Zuordnung ermöglicht.

Der Nutzer kann einen eigenen Ausschnitt oder Auftrag eingeben. Der erneute
Sicherheitslauf findet darin nur bekannte Werte und Heuristikmuster. Er ersetzt
keine manuelle Schwärzung und keine Prüfung von Auftragsverarbeitung,
Vertraulichkeitsverpflichtungen, Rechtsgrundlage, Zweckbindung,
Speicherfristen, Empfängerland oder Löschkonzept.

Normanker sind nicht auf ein geprüftes Normformat begrenzt. Manuell ergänzte
Werte können Namen oder andere Geheimnisse enthalten; die technische Ersetzung
greift dort ebenso wie im Governance-Typ, erfasst aber keine unbekannten oder
nur kontextuell erkennbaren Geheimnisse. Außerdem akzeptiert die Server-Action den
finalen Text und Auftrag ohne Vorschau-Token, Hashbindung oder persistierten
Bestätigungsnachweis. Der normale UI-Ablauf beweist daher keine technisch
erzwungene manuelle Vorschau.

Alle Felder eines Auftrags teilen denselben Platzhalternamensraum. Der Versand
baut zunächst den Vorschaukontext in gleicher Reihenfolge auf; erst danach
ergänzen bearbeiteter Text und Auftrag neue Werte. Bestehende Platzhalter
werden dabei nicht mit anderen Originalen überschrieben. Kontakte werden
stabil nach ID gelesen. Ändern sich Stammdaten, Quelltext oder Eingaben zwischen
Vorschau und Versand, fehlt weiterhin eine technische Bindung an den zuvor
gesehenen Stand. Eine neue Vorschau bleibt dann erforderlich.

## Beispiele

### Normalfall

Mandantenname, USt-ID und Kontakt-E-Mail stammen aus den Stammdaten und werden
deterministisch ersetzt. Ein Betrag und ein Datum werden heuristisch markiert.
Der Berufsträger prüft die Vorschau, entfernt weitere identifizierende Details
und sendet erst nach organisatorischer Freigabe.

### Grenzfall

Der Sachverhalt nennt eine seltene Transaktion und den Namen einer nicht in
den Kontakten gespeicherten natürlichen Person. Die Regex erkennt beides
nicht. Eine trefferfreie Vorschau ist daher kein Versandfreigabenachweis; der
Text muss manuell gekürzt oder geschwärzt werden.

## Umsetzung in TaxTronik

`anonymize.ts` ersetzt bekannte Entitäten tokenbegrenzt und führt danach eine
Liste heuristischer Regex-Muster aus. `research.ts` baut je Auswahl den
Auftrag, begrenzt vertrauliche Auszüge anhand serverseitig geladener Rechte,
liefert eine Vorschau und re-anonymisiert alle ausgehenden Freitextfelder vor
dem Outbox-Event. Ein gemeinsamer Kontext vergibt kollisionsfreie Platzhalter
für Text, Rechtsfrage, Auftrag, Normanker und Governance-Typ. Neue Originale
im bearbeiteten Text erweitern den Kontext; vorhandene Vorschau-Platzhalter
bleiben erhalten. Die Rückzuordnung ersetzt nur Platzhalter im Antworttext,
nicht erneut Platzhalterzeichen innerhalb eines eingesetzten Originals. Das
Mapping wird am tenantgebundenen Request gespeichert, nicht in den
n8n-Payload geschrieben; eine vorherige Vorschau ist serverseitig nicht an den
Versand gebunden.

## Bekannte Abweichungen und Grenzen

Die Umsetzung ist teilweise. Deterministische Stammdatenersetzung,
Heuristikhinweise, erneuter Versandlauf und enger Vertraulichkeitsausschnitt
sind implementiert. Eine vollständige Anonymisierung oder
Verschwiegenheits-/Datenschutzfreigabe ist technisch nicht gewährleistet.
Die manuelle Vorschau wird nicht serverseitig erzwungen oder an den Datenstand
gebunden, das Mapping bleibt lokal reversibel und unbekannter oder nur kontextuell
erkennbarer Klartext kann die Filter passieren.

## Fachliche Prüffragen

- Welche Empfänger und Vertragsgrundlagen sind für externe Recherche
  kanzleiweit freigegeben?
- Welche Informationen müssen unabhängig von Regex-Treffern immer entfernt
  oder lokal gehalten werden?
- Reicht Pseudonymisierung für den konkreten Zweck und Übermittlungsweg aus?
- Wer dokumentiert die manuelle Vorschauprüfung und die Befugnis zur
  Offenbarung?

## Technische Nachweise

Die Tests belegen synthetisch die Ersetzung bekannter Stammdaten, ausgewählte
Heuristiken, Mapping-Round-trip, separaten anonymisierten Auftrag und den
kontextlosen Auszug für eingeschränkte vertrauliche Analysen. Die am 7. September
2026 ergänzten Regressionen reproduzierten vor der Korrektur Klartext im
tatsächlichen Norm-/Governance-Outbound, falsche feldübergreifende Zuordnung
von E-Mail und Betrag sowie rekursive Ersetzung innerhalb eines Originals.
Danach bestehen diese Fälle einschließlich Vorschau, Bearbeitung und
Rückzuordnung. Sie belegen keine erzwungene Vorschau, keine vollständige
Anonymität, keine rechtliche Übermittlungsbefugnis und keinen realen
n8n-/Dienstleisterschutz.
