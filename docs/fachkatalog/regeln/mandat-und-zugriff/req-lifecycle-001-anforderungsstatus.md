---
id: REQ-LIFECYCLE-001
title: Mandantenkanal einer Anforderung kontrolliert schließen und wieder öffnen
domain: mandat-und-zugriff
rule_type: product_rule
jurisdiction: DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Berufsträger Kanzleiprozesse
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: implemented
  summary: >-
    Portalantworten und Formularabgaben sind nur bei OPEN oder IN_PROGRESS
    möglich. Mitarbeiter können offene, laufende oder beantwortete Vorgänge
    schließen und RESPONDED oder CLOSED auditierbar wieder auf OPEN setzen;
    CANCELLED bleibt terminal.
sources:
  - kind: product_documentation
    citation: Feature-Katalog, Anforderungen und Wiedereröffnung
    path: FEATURES.md
    checked_at: '2026-08-24'
    primary: true
code_refs:
  - apps/web/src/app/portal/(protected)/requests/[id]/actions.ts
  - apps/web/src/app/portal/(protected)/forms/[id]/actions.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/requests/actions.ts
test_refs:
  - apps/web/src/app/staff/(protected)/clients/[id]/requests/__tests__/actions.test.ts
  - apps/web/src/app/portal/(protected)/forms/[id]/__tests__/actions.test.ts
feature_refs:
  - FEATURES.md
related_rules:
  - REQ-INTERNAL-COMMENT-001
  - FORM-PRESUBMIT-UPLOAD-001
  - ACCESS-CLIENT-MODE-001
tags:
  - anforderung
  - lifecycle
  - wiedereröffnung
---

# REQ-LIFECYCLE-001 — Mandantenkanal einer Anforderung kontrolliert schließen und wieder öffnen

## Kurzfassung

Eine mandantensichtbare Antwort oder Formularabgabe ist nur möglich, solange
die Anforderung `OPEN` oder `IN_PROGRESS` ist. Eine erfolgreiche
Mandantenantwort führt zu `RESPONDED`; Kanzleimitarbeiter können den Vorgang
schließen oder aus `RESPONDED`/`CLOSED` wieder öffnen. Interne Kommentare
folgen einer getrennten Regel.

## Wann gilt die Regel?

Die Regel gilt für einzelne Portalantworten, verknüpfte Formularabgaben sowie
staffseitiges Schließen und Wiederöffnen. Sie legt keine fachliche Frist fest
und entscheidet nicht, ob die erhaltene Antwort inhaltlich vollständig ist.

## Benötigte Angaben

- Anforderung, Tenant und Mandant
- aktueller Status
- Portal-Kontakt oder berechtigter Mitarbeiter
- gegebenenfalls verknüpfte Formular-Submission
- gegebenenfalls verknüpftes GwG-Identitätsdokument

## Entscheidungslogik

| Wenn                                                           | Dann                                                                       | Begründung                                    |
| -------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------- |
| Portalantwort bei OPEN/IN_PROGRESS                             | Antwort speichern und Status atomar auf RESPONDED setzen                   | Mandantenkanal ist offen                      |
| Formular wird bei OPEN/IN_PROGRESS abgegeben                   | Submission auf SUBMITTED und alle gebundenen Requests auf RESPONDED setzen | ein gemeinsamer Abschluss                     |
| Portalaktion bei RESPONDED/CLOSED/CANCELLED                    | Schreiben verweigern                                                       | Mandantenkanal ist geschlossen                |
| Mitarbeiter schließt OPEN/IN_PROGRESS/RESPONDED                | Status per exaktem CAS auf CLOSED setzen und auditieren                    | kontrollierter Abschluss                      |
| Mitarbeiter öffnet RESPONDED oder CLOSED                       | Status per CAS auf OPEN setzen und Abschlussfelder leeren                  | dokumentierte Wiederaufnahme                  |
| Status CANCELLED                                               | nicht wieder öffnen                                                        | terminaler Produktstatus                      |
| aktiver GwG-Nachfolger zum selben Identitätsdokument existiert | Wiederöffnung verweigern                                                   | parallelen aktiven Nachweisvorgang verhindern |

## Ausnahmen und Grenzfälle

Eine staffseitige sichtbare Antwort ist ebenfalls nur aus OPEN/IN_PROGRESS
zulässig und hält den Status `IN_PROGRESS`. Ein bereits `SUBMITTED` oder
`REVIEWED` markiertes Formular wird durch Reopen nicht zurückgesetzt. Alte
Bestände ohne eindeutigen Formular-Rücklink werden fail-closed über alle
gefundenen verknüpften Requests geprüft.

## Beispiele

### Normalfall

Der Mandant antwortet auf eine offene Anforderung. Status und Antwort werden
in derselben Transaktion gespeichert; der Vorgang steht anschließend auf
`RESPONDED`. Nach Prüfung schließt ein Mitarbeiter ihn auf `CLOSED`.

### Grenzfall

Eine geschlossene Anforderung ist mit einem noch nicht abgesendeten Formular
verbunden. Die Kanzlei öffnet die Anforderung wieder; das PENDING-/DRAFT-
Formular ist wieder bearbeitbar. Ein bereits abgesendetes Formular bleibt
unverändert.

## Umsetzung in TaxTronik

Portal- und Staff-Actions verwenden Zeilensperren beziehungsweise
Compare-and-set-Updates, sodass paralleles Antworten, Schließen und Einreichen
nicht zu einem falschen Audit führt. Statuswechsel und Evidence-Einträge
liegen in Tenant-Transaktionen. Die GwG-Verknüpfung wird zusätzlich durch
einen partiellen Unique-Backstop geschützt.

## Bekannte Abweichungen und Grenzen

Keine bekannte Abweichung im beschriebenen Statusworkflow. Die Portalantwort-
Action besitzt jedoch keinen eigenen isolierten Unit-Test; ihre Kernbedingung
ist im Code und in den Formular-/Staff-Racetests nachvollzogen. Der Workflow
bewertet weder fachliche Vollständigkeit noch Fristgerechtigkeit einer Antwort.

## Fachliche Prüffragen

- Welche Rollen dürfen Anforderungen schließen und wieder öffnen?
- Soll eine Wiederöffnung eine erneute Mandantenbenachrichtigung auslösen?
- Wann muss statt Reopen eine neue Anforderung angelegt werden?
- Welche Nachweise sind für eine fachlich vollständige Antwort erforderlich?

## Technische Nachweise

Die Staff-Tests belegen erlaubte Ausgangsstatus, exakte CAS-Übergänge, Audit,
CANCELLED und den GwG-Konflikt. Formular-Tests belegen atomaren Submit,
Request-Bindung und fail-closed Verhalten bei parallelem Abschluss.
