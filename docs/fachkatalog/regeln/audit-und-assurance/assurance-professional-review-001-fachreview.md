---
id: ASSURANCE-PROFESSIONAL-REVIEW-001
title: Fachliche Freigabe von technischer Umsetzung und KI-Beiträgen trennen
domain: audit-und-assurance
rule_type: office_policy
jurisdiction: DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Berufsträger Fachkatalog und Qualitätsmanagement
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: partial
  summary: Schema, Inhalts-Hash und CI trennen technische Umsetzung von fachlicher Freigabe und erkennen geänderte freigegebene Inhalte; belastbare Review-Identität braucht zusätzliche Repository-Governance.
sources:
  - kind: internal_policy
    citation: Beitrags- und Reviewverfahren des TaxTronik-Fachkatalogs
    path: docs/fachkatalog/BEITRAGEN.md
    checked_at: '2026-08-24'
    primary: true
  - kind: internal_policy
    citation: Arbeitsregeln für fachliche Logik und Verbot der KI-Selbstfreigabe
    path: AGENTS.md
    checked_at: '2026-08-24'
    primary: false
code_refs:
  - scripts/fachkatalog/cli.mjs
  - scripts/fachkatalog/lib.mjs
test_refs:
  - scripts/tests/fachkatalog.test.mjs
feature_refs:
  - docs/fachkatalog/BEITRAGEN.md
  - docs/fachkatalog/README.md
  - AGENTS.md
related_rules:
  - ASSURANCE-RELEASE-EVIDENCE-001
tags:
  - assurance
  - fachreview
  - governance
  - ki
---

# ASSURANCE-PROFESSIONAL-REVIEW-001 — Fachliche Freigabe von technischer Umsetzung und KI-Beiträgen trennen

## Kurzfassung

Der Fachkatalog führt den technischen Umsetzungsstatus unabhängig vom
berufsträgerlichen Reviewstatus. Eine fachliche Freigabe benötigt benannte
Person, Prüfdatum und einen Hash des geprüften Fachinhalts. KI-Werkzeuge dürfen
diese Freigabedaten nicht setzen. Der Validator erkennt nachträgliche
Änderungen am gebundenen Inhalt, authentifiziert aber weder die Person noch
deren Berufsqualifikation.

## Wann gilt die Regel?

Die Regel gilt für alle Fachkatalogeinträge und jede Änderung an ihrem
fachlichen Inhalt. Sie gilt ebenso für KI-gestützte Entwürfe, Codeänderungen,
Quellenaufbereitung und technische Nachweise. Nur eine dokumentierte
Entscheidung eines zuständigen Berufsträgers darf `approved` begründen.

## Benötigte Angaben

- eindeutige Regel-ID und vollständiger Fachinhalt
- technische Umsetzung mit getrennten Code- und Testnachweisen
- nachvollziehbare Quellen mit Prüfdatum
- für eine Freigabe benannter Reviewer, Reviewdatum und aktueller Inhaltshash
- organisatorischer Nachweis der Identität, Rolle und Vier-Augen-Governance
- bei Änderungen die betroffenen Regel-IDs und erneut auszuführenden Nachweise

## Entscheidungslogik

| Situation                                       | Ergebnis                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------- |
| Regel wurde noch nicht berufsträgerlich geprüft | `unreviewed` und alle Freigabefelder `null` lassen                                    |
| technische Umsetzung ist getestet               | Implementierungsstatus setzen, Reviewstatus dadurch nicht verändern                   |
| Berufsträger beginnt dokumentierte Prüfung      | organisatorisch abgesichert `in_review` führen; noch keinen Freigabehash behaupten    |
| zuständiger Berufsträger gibt den Inhalt frei   | Reviewer, Datum und den für genau diesen Fachinhalt erzeugten Hash dokumentieren      |
| gebundener Fachinhalt ändert sich danach        | Validator weist den veralteten Freigabehash zurück; erneute Prüfung erforderlich      |
| KI erstellt oder ändert eine Regel              | niemals `approved`, Reviewer, Prüfdatum oder Freigabehash als eigenen Nachweis setzen |
| Commit-Autor behauptet eine fremde Identität    | Katalogdaten allein nicht als Authentifizierung akzeptieren                           |

## Ausnahmen und Grenzfälle

Der Inhaltshash schließt technische Status- und Nachweisfelder bewusst aus und
bindet den fachlichen Regelinhalt samt relevanter Metadaten. Änderungen nur an
Implementierung oder Testreferenzen machen deshalb nicht automatisch eine
fachliche Aussage ungültig, müssen aber nach dem Änderungsverfahren technisch
geprüft werden. `superseded` ist ebenfalls ein dokumentierter Reviewstatus und
benötigt Freigabedaten sowie eine Nachfolgeregel.

## Beispiele

### Normalfall

Eine KI ergänzt eine noch ungeprüfte Rechnungsregel und ihre Tests. Die Regel
bleibt `unreviewed`. Später prüft ein Berufsträger Quellen und
Entscheidungslogik; erst dessen geschützter Reviewprozess darf die
Freigabemetadaten eintragen.

### Grenzfall

Nach einer Freigabe wird eine fachliche Ausnahme im Markdown geändert, der
alte Hash bleibt aber stehen. Der Katalogvalidator berechnet den Inhalt neu und
verweigert den veralteten Freigabestand.

## Umsetzung in TaxTronik

`lib.mjs` validiert Reviewstatus, Pflichtfelder, Quellen, Datum und
Inhaltshash, trennt Implementierungs- von Reviewmetadaten und verwirft stale
Hashes. `cli.mjs` kann den prüfbaren Hash ausgeben und weist ausdrücklich auf
die fehlende Identitätswirkung hin. CI prüft Struktur und Drift des Katalogs.

Amtliche Quellen werden je Quellenart anhand ausdrücklich zugelassener Hosts
geprüft. Dazu gehört für `official_guidance` die Finanzverwaltungsplattform
`elster.de`, insbesondere ihre veröffentlichte Steuernummerntabelle.
Für den konsolidierten EU-Sanktionsdatenbestand ist außerdem der amtliche
EU-Datenkatalog `data.europa.eu` ausdrücklich zugelassen. Ähnlich benannte
Fremddomains werden nicht akzeptiert. Ein zugelassener Host bestätigt
nicht automatisch die fachliche Aussage einer konkreten Quelle.

Die konkret zur Laufzeit verwendete StBVV-Tabelle
`packages/tax/src/stbvv/tables.json` und die zugehörige Paketkonfiguration
`packages/tax/package.json` sind als ausführungsnahe Nachweise zugelassen.
Andere JSON-Dokumente werden dadurch nicht als Implementierung akzeptiert.

## Bekannte Abweichungen und Grenzen

Die technische Trennung und Stale-Hash-Erkennung sind implementiert, eine
personenbezogene Authentifizierung der Freigabe jedoch nicht. Ohne geschützte
Branches, CODEOWNERS-/Vier-Augen-Regeln oder signierte Attestationen kann eine
Person Metadaten im Commit lediglich behaupten. Der Hash schützt außerdem
nicht gegen eine kollusive oder fachlich fehlerhafte Freigabe und ersetzt keine
Berufsqualifikation.

## Fachliche Prüffragen

- Welche Berufsträgerrolle ist je Domain fachlich zuständig?
- Welche Repository-Governance authentifiziert Reviewer und verhindert
  Selbstfreigaben?
- Welche Änderungen am technischen Nachweis verlangen zusätzlich eine erneute
  fachliche Beurteilung?
- Wie werden Reviewprotokoll, Quellenstand und mögliche Gegenprüfung dauerhaft
  aufbewahrt?
- Wann darf eine Regel als abgelöst statt nur geändert gekennzeichnet werden?

## Technische Nachweise

Die Katalogtests prüfen unvollständige Freigaben, Hashbindung, Erkennung
nachträglicher Inhaltsänderungen, Quellen- und Datumsplausibilität, getrennte
Code-/Testnachweise sowie die Konsistenz von Schema und Validator. Diese Tests
belegen keine reale Reviewer-Identität und keine fachliche Richtigkeit.
