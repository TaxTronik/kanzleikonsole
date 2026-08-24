---
id: RISK-CATALOG-FOUR-EYES-001
title: Geteilte Beraterbegriffe nur vorwärts und durch eine zweite Person freigeben
domain: subsumtion-und-tcms
rule_type: office_policy
jurisdiction: DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Berufsträger Katalog-Governance
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: implemented
  summary: >-
    Im eng beschriebenen Integrationsscope werden geteilte, lokal
    nachvollziehbar angelegte Beraterbegriffe nur vorwärts geschaltet und der
    bekannte Autor wird als Prüfer blockiert. Erst ein erfolgreicher
    Engine-Übergang erzeugt einen lokalen Auditnachweis.
sources:
  - kind: product_documentation
    citation: Anwenderdokumentation Subsumtion, TCMS und Quantenlos, Governance und Zusammenarbeit
    path: docs/anwenderdoku/subsumtion-tcms-quantenlos.md
    checked_at: '2026-08-24'
    primary: true
  - kind: internal_policy
    citation: TCMS-Einordnung und Fähigkeiten-Mapping, erzwungene Vier-Augen-Prinzipien
    path: docs/compliance/idw-ps980-tcms.md
    checked_at: '2026-08-24'
    primary: false
code_refs:
  - apps/web/src/server/risk/catalog-review.ts
  - apps/web/src/server/risk/catalog-norms.ts
test_refs:
  - apps/web/src/server/risk/__tests__/catalog-review.test.ts
  - apps/web/src/server/risk/__tests__/catalog-norms.test.ts
feature_refs:
  - docs/anwenderdoku/subsumtion-tcms-quantenlos.md
  - docs/compliance/idw-ps980-tcms.md
related_rules:
  - RISK-AI-SUGGESTION-001
tags:
  - katalog
  - vier-augen
  - freigabe
  - audit
  - tcms
---

# RISK-CATALOG-FOUR-EYES-001 — Geteilte Beraterbegriffe nur vorwärts und durch eine zweite Person freigeben

## Kurzfassung

Ein geteilter Beraterbegriff durchläuft den Engine-Status nur vorwärts. Ist
sein Autor in der lokalen Audit-Chain bekannt, darf diese Person den eigenen
Begriff nicht selbst weiterschalten. TaxTronik auditiert den Übergang erst
nach bestätigtem Engine-Erfolg. Dieser Lebenszyklus ist vollständig vom
Berufsträger-Review der Dateien unter `docs/fachkatalog` getrennt.

## Wann gilt die Regel?

Die Regel gilt für geteilte Berater-Katalogeinträge, deren Anlage durch ein
lokales Ereignis `risk.catalog.defined` mit passender Begriffs-ID und Scope
`geteilt` nachvollziehbar ist. Persönliche Einträge, eingebaute
Engine-Katalogbegriffe und fallbezogene Normkuratierungen sind nicht dieselbe
Freigabeart. Für Begriffe ohne lokal bekannten Autor kann die Anwendung das
Vier-Augen-Verbot nicht aus dieser Auditquelle ableiten.

## Benötigte Angaben

- stabile Engine-Begriffs-ID
- aktueller und gewünschter Katalogstatus
- Scope `geteilt`
- lokaler Auditnachweis der Definition und Autor-ID
- angemeldete prüfende Person
- erfolgreiche Antwort des zustandsführenden Risk-Layers

## Entscheidungslogik

| Wenn                                                          | Dann                                                                           | Begründung                                                          |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| Markierung passt zu einem lokal definierten geteilten Begriff | Review-Funktion für diese Markierung anbieten                                  | eingebaute oder persönliche Einträge sind nicht gleich zu behandeln |
| anfragende Person ist dokumentierter Autor                    | Übergang vor jedem Engine-Aufruf ablehnen                                      | Vier-Augen-Prinzip                                                  |
| zweite Person beantragt einen Vorwärtsübergang                | pseudonymes Prüfer-Tag an die Engine senden                                    | keine direkte Staff-ID soll die Engine-Auditspur verlassen          |
| Engine lehnt Rückwärtsübergang, Form oder Geheimnisschutz ab  | Domänenfehler anzeigen und keinen lokalen Erfolg auditierten                   | abgelehnte Handlung ist keine Freigabe                              |
| Engine bestätigt den Übergang                                 | alten und neuen Status mit echter lokaler Actor-ID in der Hash-Chain verankern | lokaler Nachweis der erfolgreichen Handlung                         |
| Katalognorm-Kuratierung scheitert                             | ebenfalls keinen Audit-Erfolg schreiben                                        | Audit darf keinen nicht eingetretenen Zustand behaupten             |

## Ausnahmen und Grenzfälle

Die Vorwärtsregel wird vom Risk-Layer als zustandsführender Komponente
erzwungen; die Anwendung übersetzt dessen Ablehnungen. Ohne lokale
`risk.catalog.defined`-Provenienz ist kein Autor bekannt und deshalb keine
Anwendungssperre gegen Selbstfreigabe möglich. Das ist eine bewusst enge
Integrationsgrenze und keine allgemeine Aussage über jeden Engine-Katalogwert.

Das Prüfer-Tag ist ein tenantgebundener SHA-256-Ausschnitt mit
Buchstabenabbildung. Es ist ein Pseudonym, kein Identitätsnachweis. Die lokale
Audit-Chain hält die echte Actor-ID; weder Tag noch Hash authentifizieren eine
fachliche Qualifikation.

## Beispiele

### Normalfall

Person A legt einen geteilten Beraterbegriff an. Person B schaltet ihn nach
Prüfung von `entwurf` auf `geprüft` und später zulässig auf `freigegeben`.
Erst die bestätigten Übergänge werden lokal auditiert.

### Grenzfall

Für einen direkt in der Engine kuratierten Begriff existiert kein lokaler
Definitionsnachweis. Der Lebenszyklus kann technisch nutzbar sein, aber
TaxTronik kann den ursprünglichen Autor nicht bestimmen und daher das
Vier-Augen-Prinzip nicht aus dieser Quelle beweisen.

## Umsetzung in TaxTronik

`catalog-review.ts` ermittelt reviewbare geteilte Einträge, sucht den frühesten
lokalen Definitionsnachweis, blockiert den bekannten Autor und ruft dann den
Engine-Review auf. Nur nach Erfolg wird `risk.catalog.reviewed` verankert.
`catalog-norms.ts` folgt für Katalognorm-Kuratierungen derselben Reihenfolge:
Zustand lesen, Engine außerhalb der Transaktion aufrufen und nur Erfolg
auditieren.

## Bekannte Abweichungen und Grenzen

Die Regel ist im beschriebenen Integrationsscope implementiert. Nicht
abgedeckt sind ein Autorennachweis für direkt in der Engine angelegte Begriffe,
eine kryptografische Personen- oder Qualifikationsprüfung, die fachliche Güte
des freigegebenen Inhalts und eine Gleichsetzung mit dem
`professional_review` des Fachkatalogs. Der lokale Auditnachweis dokumentiert
die Handlung, nicht die materielle Richtigkeit des Begriffs.

## Fachliche Prüffragen

- Muss jeder geteilte Begriff zwingend einen lokalen Autorennachweis besitzen?
- Welche Rollen dürfen die Statusstufen `geprüft` und `freigegeben` setzen?
- Welche inhaltlichen Prüfschritte und Begründungen sind vor jedem Übergang
  erforderlich?
- Wie werden Änderungen an bereits freigegebenen Begriffen versioniert, ohne
  einen verbotenen Rückwärtsstatus zu simulieren?

## Technische Nachweise

Die Tests belegen Auswahl reviewbarer geteilter Einträge, Autorensperre,
pseudonymes Engine-Tag, Vorwärts-/Fehlerantworten und Audit nur nach Erfolg.
Sie belegen keine fachliche Prüfung, keine reale Engine-Integration und keinen
Autor für Begriffe außerhalb der lokalen Definitionsspur.
