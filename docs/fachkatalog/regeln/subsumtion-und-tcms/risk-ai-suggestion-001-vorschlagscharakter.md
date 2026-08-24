---
id: RISK-AI-SUGGESTION-001
title: Automatische Risiko- und Normmarkierungen nur als Vorschläge behandeln
domain: subsumtion-und-tcms
rule_type: office_policy
jurisdiction: DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Berufsträger Subsumtion und Steuerrecht
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: partial
  summary: >-
    Deterministische und optionale LLM-Markierungen werden mit Herkunft und
    Engine-Metadaten gespeichert und können getrennt kuratiert werden. Nur der
    initiale Analysepfad referenziert einen vollständigen Rohoutput; der
    Worker archiviert den LLM-Enrichment-Rohoutput nicht. Eine vollständige
    fachliche Prüfung wird ebenfalls nicht erzwungen.
sources:
  - kind: internal_policy
    citation: Dokumentierte Produktgrenzen, externe KI ist Hilfsmittel und keine Entscheidungsinstanz
    path: docs/assurance/known-limits.md
    checked_at: '2026-08-24'
    primary: true
  - kind: product_documentation
    citation: Anwenderdokumentation Subsumtion, TCMS und Quantenlos, zweistufige Analyse
    path: docs/anwenderdoku/subsumtion-tcms-quantenlos.md
    checked_at: '2026-08-24'
    primary: false
code_refs:
  - apps/web/src/server/risk/run-analysis.ts
  - apps/web/src/server/risk/persistence.ts
  - apps/worker/src/jobs/risk-analyse-llm.ts
test_refs:
  - apps/web/src/server/risk/__tests__/llm.test.ts
  - apps/worker/src/jobs/__tests__/risk-analyse-llm.test.ts
  - apps/web/src/server/risk/__tests__/norms-core.test.ts
feature_refs:
  - docs/anwenderdoku/subsumtion-tcms-quantenlos.md
  - docs/assurance/known-limits.md
related_rules:
  - RISK-CATALOG-FOUR-EYES-001
  - RISK-EXTERNAL-ANONYMIZATION-001
  - RISK-ARCHIVE-SNAPSHOT-001
tags:
  - subsumtion
  - ki
  - llm
  - vorschlag
  - normen
---

# RISK-AI-SUGGESTION-001 — Automatische Risiko- und Normmarkierungen nur als Vorschläge behandeln

## Kurzfassung

Deterministische Treffer, Embedding-Treffer und LLM-Markierungen sind Hinweise
für die fachliche Bearbeitung. Sie sind weder eine Subsumtion noch eine
Freigabe und dürfen nicht allein wegen ihrer technischen Herkunft als richtig
gelten. TaxTronik speichert die Herkunft; beim initialen Analysepfad wird auch
ein Engine-Rohoutput referenziert. Die spätere Worker-Anreicherung archiviert
ihren LLM-Rohoutput dagegen nicht. Materielle Richtigkeit oder Vollständigkeit
des extern gepflegten Risiko- und Normkatalogs werden nicht validiert.

## Wann gilt die Regel?

Die Regel gilt für jeden Lauf des Risk-Layers und für jede daraus gespeicherte
Markierung oder Normreferenz. Sie gilt auch dann, wenn ein deterministisches
Muster statt eines Sprachmodells getroffen hat. Manuell vom Berater ergänzte
oder verworfene Normen und Markierungen bleiben eigene fachliche Handlungen;
ihre Speicherung macht sie ebenfalls nicht automatisch richtig.

## Benötigte Angaben

- vollständiger und aktueller Sachverhalt
- Version des Risiko-/Normkatalogs und der Engine
- Herkunft jeder Markierung
- Normanker und gegebenenfalls Normketten
- dokumentierte fachliche Prüfung, Begründung und Verantwortlicher
- Kenntnis fehlgeschlagener oder ausgebliebener LLM-Anreicherung

## Entscheidungslogik

| Wenn                                                        | Dann                                                                                 | Begründung                                                               |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| ein Sachverhalt analysiert wird                             | zunächst deterministischen Engine-Lauf ausführen und Ergebnis mit Herkunft speichern | schnelle maschinelle Vorstrukturierung                                   |
| optionale LLM-Schicht verfügbar ist                         | nur zusätzliche, noch nicht vorhandene Markierungen anhängen                         | vorhandene Markierungen sollen nicht unbemerkt dupliziert werden         |
| LLM-Modell, Binary oder Modul fehlt                         | Anreicherung abbrechen oder überspringen und Fehler sichtbar lassen                  | fehlende Analyse darf nicht als leerer fachlicher Befund erscheinen      |
| Engine-Hash vom lokal berechneten Sachverhalt-Hash abweicht | Abweichung protokollieren; lokalen Hash als maßgeblichen Auditanker verwenden        | Engine-Ausgabe wird nicht blind vertraut                                 |
| Engine eine Markierung oder Norm vorschlägt                 | Herkunft sichtbar halten und durch einen Berufsträger prüfen                         | maschineller Treffer ist keine fachliche Entscheidung                    |
| Berater eine Norm ergänzt, verwirft oder entfernt           | getrennte Kuratierung mit unverändert erhaltener Provenienz anwenden                 | menschliche Bearbeitung muss vom Engine-Vorschlag unterscheidbar bleiben |

## Ausnahmen und Grenzfälle

Ein fehlender Treffer bedeutet nicht, dass kein steuerliches oder rechtliches
Risiko besteht. Ein Treffer mit passendem Wortlaut belegt weder die
Anwendbarkeit einer Norm noch deren aktuelle Fassung. Deduplizierung in der
LLM-Schicht verwendet Start, Ende, Herkunft und Begriff; inhaltlich ähnliche
oder widersprüchliche Vorschläge können daher nebeneinander bestehen.

Beim initialen `saveAnalysis`-Pfad wird der vollständige rohe Engine-Output im
Object Store referenziert und die Markierungen werden in der Datenbank
gespeichert. Der reguläre Worker-Enrichment-Pfad speichert dagegen nur neue
Markierungen, `llmEnrichedAt` und begrenzte Audit-Metadaten; Rohoutput und
Katalogversion dieses LLM-Laufs werden nicht archiviert. Anwendungstests
verwenden außerdem keine fachlich kuratierte Benchmark und decken keine
systematische False-positive-/False-negative-Quote ab.

## Beispiele

### Normalfall

Die Engine markiert eine mögliche Schätzungsbefugnis und nennt einen
Normanker. Der Berufsträger prüft Sachverhalt, Tatbestandsvoraussetzungen,
Fassung und Gegenargumente und dokumentiert erst danach die eigene Bewertung.

### Grenzfall

Die LLM-Schicht ist nicht verfügbar. Der deterministische Lauf enthält keine
Markierung. TaxTronik darf dies weder als „kein Risiko“ noch als fachlich
abgeschlossene Prüfung darstellen; der Sachverhalt bleibt manuell zu prüfen.

## Umsetzung in TaxTronik

`run-analysis.ts` ruft den Risk-Layer mit oder ohne LLM auf.
`persistence.ts` berechnet den Sachverhalt-Hash selbst, speichert Analyse,
Markierungen, Katalog- und Engine-Version und verankert den Lauf im Audit. Der
Worker `risk-analyse-llm.ts` ergänzt nach Modul- und Verfügbarkeitsprüfung neue
LLM-/Embedding-Markierungen und protokolliert nur einen erfolgreichen
Enrichment-Lauf, ohne dessen vollständigen Rohoutput zu speichern.

## Bekannte Abweichungen und Grenzen

Die Umsetzung ist teilweise. Provenienz, getrennte LLM-Phase, Hashanker und
manuelle Normkuratierung sind vorhanden. Es fehlt ein fachlich freigegebenes
Evaluationsset für Engine und Katalog, eine im Anwendungscode erzwungene
vollständige Berufsträgerprüfung aller Vorschläge und ein Nachweis, dass
exportierte oder archivierte Bewertungen ausschließlich nach einer solchen
Prüfung verwendet werden. Zusätzlich fehlt für die Worker-Anreicherung ein
archivierter Rohoutput samt dort verwendeter Katalogversion. Die Aussage
„Vorschlag“ begrenzt die Verwendung, behebt aber keine fehlerhaften Inhalte.

## Fachliche Prüffragen

- Welche Mindestprüfung und welcher dokumentierte Status sind vor Export oder
  Mandantenkommunikation erforderlich?
- Wie werden Katalog- und Modellversionen fachlich evaluiert und freigegeben?
- Welche Testfälle messen Auslassungen, Fehlalarme und veraltete Normanker?
- Wie wird ein fehlgeschlagener LLM-Lauf für spätere Prüfer eindeutig sichtbar?

## Technische Nachweise

Die referenzierten Tests belegen LLM-Statusabbildung, den Modul-Gate des
Workers und reine Operationen zur Normkuratierung. Sie belegen ausdrücklich
weder die fachliche Qualität der Engine noch die Vollständigkeit der Treffer,
den vollständigen Persistenzpfad, die Rohoutput-Archivierung des Enrichments
oder eine tatsächliche Berufsträgerfreigabe.
