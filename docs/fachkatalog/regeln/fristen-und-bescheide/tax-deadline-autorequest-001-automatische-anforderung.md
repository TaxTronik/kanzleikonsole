---
id: TAX-DEADLINE-AUTOREQUEST-001
title: Automatische Mandantenanforderung vor Steuerterminen steuern
domain: fristen-und-bescheide
rule_type: product_rule
jurisdiction: DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Prozessverantwortlicher Deklaration
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: partial
  summary: Anforderung, Sperre und Doppelanlage-Schutz sind umgesetzt; der Status SENT beweist derzeit nicht den erfolgreichen E-Mail-Zugang.
sources:
  - kind: product_documentation
    citation: Funktionskatalog Steuertermine und automatische Anforderungen
    path: FEATURES.md
    checked_at: '2026-08-23'
    primary: true
  - kind: product_documentation
    citation: Benutzerhandbuch Kalender, Fristen und Bescheide
    path: docs/anwenderdoku/kalender-fristen-bescheide.md
    checked_at: '2026-08-23'
    primary: false
code_refs:
  - packages/tax/src/materialize.ts
  - apps/web/src/app/staff/(protected)/tax-deadlines/actions.ts
  - apps/worker/src/jobs/tax-deadline-materialize.ts
test_refs:
  - packages/tax/src/__tests__/materialize.test.ts
  - apps/worker/src/jobs/__tests__/tax-deadline-materialize.test.ts
  - packages/db/src/__tests__/tax-deadline-request-consistency.test.ts
feature_refs:
  - FEATURES.md
  - docs/anwenderdoku/kalender-fristen-bescheide.md
related_rules:
  - TAX-DEADLINE-WORKDAY-001
  - TAX-CONTROL-STATUS-001
tags:
  - anforderung
  - automation
  - steuertermin
---

# TAX-DEADLINE-AUTOREQUEST-001 — Automatische Mandantenanforderung vor Steuerterminen steuern

## Kurzfassung

TaxTronik darf zu einem bevorstehenden Steuertermin automatisch genau eine
Mandantenanforderung anlegen, sofern die Kanzlei die Automatik aktiviert und
nicht zuvor gestoppt hat. Nach Ablauf des Fälligkeitstags wird keine neue
Anforderung mehr erzeugt. „Gesendet“ bezeichnet derzeit die angelegte
Portal-Anforderung, nicht den nachgewiesenen Zugang einer E-Mail.

## Wann gilt die Regel?

Die Regel gilt für aktive Steuertermin-Konfigurationen, freigeschaltete
Mandanten und Fälligkeiten im Materialisierungshorizont. Sie steuert den
Produktprozess; sie sagt nicht, wann Unterlagen fachlich oder gesetzlich
tatsächlich anzufordern sind.

## Benötigte Angaben

- aktive Steuertermin-Konfiguration und Terminart
- Fälligkeitsdatum
- konfigurierte Anzahl von Tagen für Vorwarnung und Anforderung
- Freischaltstatus des Mandanten
- möglicher manueller Stopp und dessen Begründung
- bereits verknüpfte Anforderung

## Entscheidungslogik

| Wenn                                                        | Dann                                                        |
| ----------------------------------------------------------- | ----------------------------------------------------------- |
| Termin liegt außerhalb des Vorschau-Horizonts               | Noch keinen Termin materialisieren                          |
| Mandant ist nicht freigeschaltet oder Konfiguration inaktiv | Keine automatische Anforderung                              |
| Vorwarnfenster erreicht, Versandfenster noch nicht erreicht | Intern vorwarnen; spätere Anlage bleibt stoppbar            |
| Versandfenster erreicht und keine Sperre vorhanden          | Genau eine Portal-Anforderung atomar anlegen und verknüpfen |
| Mitarbeiter hat die Pipeline gestoppt                       | Keine Anforderung anlegen, bis die Sperre aufgehoben wird   |
| Fälligkeitstag ist bereits vollständig abgelaufen           | Keine neue automatische Anforderung mehr anlegen            |
| Anforderung ist bereits verknüpft                           | Keine zweite Anforderung erzeugen                           |

## Ausnahmen und Grenzfälle

Ein später Worker-Lauf kann das Vorwarnfenster überspringen und direkt im
Versandfenster anlegen. Parallele Läufe werden durch atomare Datenbankregeln
und Compare-and-set-Logik zusammengeführt. E-Mail und n8n-Benachrichtigung
erfolgen erst nach dem Datenbank-Commit; ihr Fehler darf die bereits angelegte
Portal-Anforderung nicht rückwirkend vervielfachen.

## Beispiele

### Normalfall

Die Kanzlei hat eine Vorwarnung 21 Tage und die Anforderung 14 Tage vor
Fälligkeit eingestellt. Im ersten Fenster erscheint die interne Vorwarnung.
Ohne Stopp legt ein späterer Tageslauf im zweiten Fenster genau eine
Mandantenanforderung an.

### Grenzfall

Die Portal-Anforderung wird erfolgreich angelegt, danach schlägt der
Mailversand fehl. Die Anforderung bleibt im Portal vorhanden und darf beim
nächsten Lauf nicht dupliziert werden. Aus dem Produktstatus allein darf aber
nicht gefolgert werden, dass der Mandant die E-Mail erhalten hat.

## Umsetzung in TaxTronik

`materialize.ts` materialisiert Termine bis 90 Tage voraus und führt den
zweistufigen Pipelinezustand. Mitarbeiter können vor der Anlage stoppen und
wieder freigeben. Request, Verknüpfung und Audit-Ereignis entstehen in einer
Transaktion; Worker-Adapter verschicken Benachrichtigungen nach dem Commit.

## Bekannte Abweichungen und Grenzen

Die UI bezeichnet eine vorhandene Request-Verknüpfung bereits als `SENT`, auch
wenn damit nur die Anlage der Portal-Anforderung und nicht der erfolgreiche
E-Mail-Zugang bewiesen ist. Fehlgeschlagene E-Mails werden derzeit nicht durch
diese Pipeline erneut zugestellt. Deshalb ist die technische Umsetzung bis zu
einer fachlichen Entscheidung über Zustellnachweis und Eskalation nur als
**teilweise** markiert.

## Fachliche Prüffragen

- Reicht die Portal-Bereitstellung für den Kanzleiprozess aus, oder muss ein
  E-Mail-Fehler wiederholt beziehungsweise eskaliert werden?
- Wie soll der Status heißen, damit er keine Zustellung behauptet?
- Wer muss die Vorwarnung erhalten, wenn kein Hauptbearbeiter zugeordnet ist?
- Welche Terminarten dürfen überhaupt automatisch Anforderungen auslösen?

## Technische Nachweise

Materialisierungs-, Worker- und Datenbanktests prüfen Zeitfenster, Stop/Freigabe,
Atomizität, parallele Läufe und Doppelanlage-Schutz. Die dokumentierte
Zustellgrenze folgt aus der Trennung von Datenbank-Commit und nachgelagertem
Mailadapter.
