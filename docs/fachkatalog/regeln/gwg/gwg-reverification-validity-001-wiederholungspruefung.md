---
id: GWG-REVERIFICATION-VALIDITY-001
title: Prüfungsablauf und relevante Änderungen lösen einen neuen Prüfzyklus aus
domain: gwg
rule_type: product_rule
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
  status: implemented
  summary: >-
    TaxTronik befristet HIGH-Prüfungen auf 365 Tage und andere Stufen auf 1095
    Tage, warnt 90 und 30 Tage vor Ablauf und deaktiviert bei Ablauf ohne
    neueren gültigen Check. Änderungen definierter GwG-Stammdaten erzeugen einen
    neuen oder zurückgesetzten Entwurf und entwerten frühere Bestätigungen.
sources:
  - kind: product_documentation
    citation: GwG-Pflichten und technische Umsetzung in TaxTronik
    path: docs/compliance/gwg.md
    checked_at: '2026-08-24'
    primary: true
  - kind: official_law
    citation: § 10 Abs. 1 Nr. 5 und Abs. 3a GwG
    url: https://www.gesetze-im-internet.de/gwg_2017/__10.html
    checked_at: '2026-08-24'
    primary: false
  - kind: official_law
    citation: § 11 Abs. 3 GwG
    url: https://www.gesetze-im-internet.de/gwg_2017/__11.html
    checked_at: '2026-08-24'
    primary: false
code_refs:
  - apps/web/src/server/gwg/reverification.ts
  - apps/web/src/server/gwg/risk-score.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/edit/actions.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/change-requests/actions.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/gwg/actions.ts
  - apps/worker/src/jobs/gwg-expiry-check.ts
test_refs:
  - apps/web/src/server/gwg/__tests__/reverification.test.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/gwg/__tests__/actions.test.ts
  - apps/worker/src/jobs/__tests__/gwg-expiry-check.test.ts
feature_refs:
  - FEATURES.md
  - docs/compliance/gwg.md
related_rules:
  - GWG-ACTIVATION-GATE-001
  - GWG-IDENTIFICATION-EVIDENCE-001
  - GWG-RISK-REVIEW-001
tags:
  - wiederholungspruefung
  - ablauf
  - stammdaten
  - aktualisierung
---

# GWG-REVERIFICATION-VALIDITY-001 — Prüfungsablauf und relevante Änderungen lösen einen neuen Prüfzyklus aus

## Kurzfassung

TaxTronik versieht jede freigegebene GwG-Prüfung mit einer Produktgültigkeit:
365 Tage bei `HIGH`, sonst 1095 Tage. Der tägliche Worker warnt 90 und 30 Tage
vor Ablauf. Ist der Zeitpunkt erreicht und existiert kein neuerer gültiger
Prüfsnapshot, wird der alte Check `EXPIRED` und der Mandant deaktiviert.

Ändern sich definierte GwG-relevante Stammdaten, wird ebenfalls fail-closed ein
neuer Prüfzyklus erforderlich. Diese festen Zeiträume und Feldlisten sind eine
Produktpolicy und keine vollständige gesetzliche Definition eines angemessenen,
risikoorientierten Aktualisierungsabstands.

## Wann gilt die Regel?

Die Regel gilt nach jeder erfolgreichen Produktfreigabe und bei Änderungen an
Name, Mandantentyp, Umsatzsteuer-ID, Straße, Postleitzahl, Ort oder Ländercode
über die Staff-Stammdatenmaske. Im Portal beantragte und von Staff übernommene
Änderungen an Name, Anschrift, Land oder Umsatzsteuer-ID lösen dieselbe
Re-Verifikation aus.

Sie gilt außerdem für ausdrücklich gestartete neue Prüfzyklen und für neue
Self-Onboarding-Submits. Änderungen, die außerhalb dieser Pfade oder Felder
stattfinden, werden nicht automatisch erkannt.

## Benötigte Angaben

- Risikostufe der freigegebenen Prüfung
- Verifikationszeitpunkt und daraus berechnetes `validUntil`
- aktueller Zeitpunkt
- alle Prüfungen desselben Mandanten und deren Reihenfolge
- vor und nach der Änderung gespeicherte GwG-relevante Stammdaten
- Anlass des neuen Zyklus und Vorgänger-ID
- Gültigkeitsdaten vorhandener Identitätsdokumente
- zuständige Hauptbearbeiter, Berufsträger und Admin-/Partner-Fallbacks

## Entscheidungslogik

| Wenn                                        | Dann                                                                                   | Begründung                                      |
| ------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Risikostufe ist `HIGH`                      | Produktgültigkeit 365 Tage                                                             | Interne Produktpolicy                           |
| Risikostufe ist `LOW` oder `MEDIUM`         | Produktgültigkeit 1095 Tage                                                            | Interne Produktpolicy                           |
| Höchstens 90 Tage verbleiben                | Stufe-1-Warnung an Hauptbearbeiter, sonst Admin/Partner                                | Frühwarnung                                     |
| Höchstens 30 Tage verbleiben                | Stufe-2-Warnung an Hauptbearbeiter und Berufsträger, sonst Fallback                    | Eskalation                                      |
| `validUntil` ist erreicht                   | Check auf `EXPIRED`; ohne neueren gültigen Check Mandant deaktivieren                  | Freigabe nicht über Ablauf hinaus verwenden     |
| Neuerer gültiger `VERIFIED`-Check existiert | Nur alten Check terminalisieren; Mandant aktiv lassen                                  | Aktuelle Freigabe trägt weiter                  |
| Definiertes GwG-Stammdatum ändert sich      | Gültige Checks entwerten, Mandant deaktivieren und bearbeitbaren Entwurf bereitstellen | Grundlage hat sich geändert                     |
| Alter Snapshot wird kopiert                 | Nur Arbeitsdaten übernehmen; Risiko und Identitätsbestätigungen nicht übernehmen       | Neue Prüfung muss eigenständig bestätigt werden |
| Ausweis läuft innerhalb von 60 Tagen ab     | Staff warnen; bei aktivem Mandanten idempotente Anforderung vorbereiten                | Dokumentaktualisierung                          |

## Ausnahmen und Grenzfälle

- Das Ausweis-Ablaufdatum gilt einschließlich des Berliner Kalendertags; erst
  danach wird es als abgelaufen behandelt.
- Ein alter Check darf beim Ablauf nicht deaktivieren, wenn ein neuerer
  gültiger Check vorhanden ist.
- Ein neuer Zyklus kopiert Struktur- und Personendaten als Arbeitshilfe, aber
  keine Risikobewertung oder bestätigte Identitätszuordnung.
- Ein verworfener oder paralleler Prüfzyklus wird durch mandantenbezogene
  Advisory Locks und Status-CAS abgesichert.
- Änderungen wirtschaftlich Berechtigter oder Vertreter innerhalb des
  GwG-Moduls entwerten die jeweils betroffenen Nachweise; externe Änderungen
  an Eigentumsverhältnissen erkennt das Produkt nicht von selbst.

## Beispiele

### Normalfall

Eine `MEDIUM`-Prüfung wird am 1. September 2026 freigegeben. TaxTronik speichert
eine Gültigkeit von exakt 1095 Tagen. Der Worker warnt innerhalb der letzten 90
und 30 Tage. Vor Ablauf wird ein neuer Check verifiziert; der alte läuft später
aus, ohne den Mandanten zu deaktivieren.

### Grenzfall

Der Sitzstaat eines aktiven Mandanten wird geändert. TaxTronik entwertet den
alten `VERIFIED`-Snapshot, deaktiviert den Mandanten und legt einen neuen
Entwurf mit kopierter Arbeitsgrundlage an. Frühere Ausweisbestätigungen und der
Risikoscore werden nicht als aktuelle Entscheidung übernommen.

## Umsetzung in TaxTronik

`riskValidForDays` ist die gemeinsame Quelle für 365 beziehungsweise 1095
Tage. Die Verifizierungs-Action speichert `validUntil`; der Worker gruppiert
Warnungen in 90-, 30- und Ablaufstufe, auditiert Statuswechsel und berücksichtigt
neuere gültige Checks. Er überwacht zusätzlich Ausweisabläufe und erzeugt
idempotente Dokumentanforderungen nur für aktive Mandanten.

`requireGwgReverificationTx` serialisiert den Mandanten-Lifecycle, setzt
gültige Checks auf `EXPIRED`, deaktiviert den Mandanten und erstellt oder
reaktiviert einen `DRAFT`. Vorgängerbezug und Änderungsanlass bleiben erhalten;
übernommene persönliche Arbeitsdaten verlieren ihre Bestätigung.

## Bekannte Abweichungen und Grenzen

Innerhalb der beschriebenen Produktpolicy sind keine bekannten technischen
Abweichungen festgestellt. Die Policy deckt die gesetzliche laufende
Überwachung jedoch nicht vollständig ab:

- 365 und 1095 Tage sind feste Dauern, keine im Gesetz vorgegebenen
  Kalenderfristen und keine dynamische Einzelfallentscheidung.
- Die überwachte Feldliste ist abschließend; Änderungen außerhalb der
  vorgesehenen Staff-/Portalpfade werden nicht erkannt.
- Transaktionen, Geschäftstätigkeit, Mittelherkunft, PEP-Status und externe
  Registeränderungen werden nicht kontinuierlich automatisiert überwacht.
- `validUntil` wird als genauer Zeitpunkt aus 24-Stunden-Tagen berechnet, nicht
  als Ende eines fachlich bestimmten Kalendertags.
- Die Kanzlei muss den angemessenen Prüfungsabstand und anlassbezogene Kontrollen
  organisatorisch festlegen.

## Fachliche Prüffragen

- Sind die festen Intervalle je Risikostufe angemessen oder braucht es weitere
  Stufen und Einzelfalltermine?
- Welche Stammdaten- und externen Ereignisse müssen zwingend einen neuen Zyklus
  auslösen?
- Soll die Gültigkeit als Kalenderdatum statt als genauer Zeitstempel geführt
  werden?
- Welche laufende Transaktions- und Registerüberwachung erfolgt außerhalb des
  Produkts?

## Technische Nachweise

Reverifikations-Tests belegen Lifecycle-Lock, Entwertung, Deaktivierung,
Vorgängerlinie und das Kopieren ohne Bestätigungen. Worker-Tests prüfen
90-/30-Tage-Stufen, Ablauf, neueren Check, Ausweisdatum und idempotente
Anforderungen. Diese Tests bestätigen die Produktpolicy, nicht die fachliche
Angemessenheit des Zeitabstands.
