---
id: AUDIT-VERIFY-ALERT-001
title: Audit-Ketten regelmäßig prüfen und Abweichungen alarmieren
domain: audit-und-assurance
rule_type: product_rule
jurisdiction: DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Berufsträger Compliance und Verfahrensdokumentation
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: partial
  summary: Der tenantweise Prüflauf erkennt Kettenfehler, Spitzenverkürzungen sowie Anker- und Policy-Fehler. Die Anzeige hält neue negative Ergebnisse trotz altem Checkpoint sichtbar; Recovery-Abgrenzung und monotone Spitzenpersistenz haben noch bekannte Grenzen.
sources:
  - kind: product_documentation
    citation: Technische Modulbeschreibung Audit-Protokollierung, Worker und Admin-Oberfläche
    path: docs/development/module/audit-protokollierung.md
    checked_at: '2026-08-24'
    primary: true
  - kind: product_documentation
    citation: TaxTronik Assurance Model, Audit-Chain und Known-Limits-Prinzip
    path: docs/assurance/assurance-model.md
    checked_at: '2026-08-24'
    primary: false
code_refs:
  - apps/worker/src/jobs/audit-verify-check.ts
  - apps/web/src/app/staff/(protected)/admin/audit/actions.ts
  - apps/web/src/server/audit/status.ts
test_refs:
  - apps/worker/src/jobs/__tests__/audit-verify-check.test.ts
  - apps/web/src/app/staff/(protected)/admin/audit/__tests__/audit-verify-refresh-ui.test.ts
  - apps/web/src/server/audit/__tests__/status.test.ts
feature_refs:
  - docs/development/module/audit-protokollierung.md
  - docs/assurance/assurance-model.md
related_rules:
  - AUDIT-HASH-CHAIN-001
  - AUDIT-RFC3161-ANCHOR-001
  - AUDIT-ARCHIVE-001
tags:
  - audit
  - verifikation
  - alarm
  - monitoring
---

# AUDIT-VERIFY-ALERT-001 — Audit-Ketten regelmäßig prüfen und Abweichungen alarmieren

## Kurzfassung

Ein täglicher und manuell auslösbarer Worker prüft die Audit-Kette jedes
Kanzlei-Tenants. Er erkennt Hash- oder Vorgängerfehler, eine gegenüber dem letzten
erfolgreichen Lauf verkürzte lokale oder externe Spitze sowie Fehler bei
Versiegelung, Ankerkette und externer TSA-Policy. Das Ergebnis wird persistiert
und bei Abweichungen an interne Admin-/Partner-Rollen gemeldet.

## Wann gilt die Regel?

Die Regel gilt für Kanzlei-Tenants, die der Worker im geplanten oder gezielten Lauf
verarbeitet. Sie beschreibt technische Erkennung und Benachrichtigung. Prüfung,
Ursachenanalyse, Eskalation, Korrektur und dokumentierter Abschluss eines
Befunds bleiben betriebliche Aufgaben.

## Benötigte Angaben

- vollständige lokale Audit-Kette des Kanzlei-Tenants
- gespeicherte Tagesversiegelungen und Rolling Anchors
- aktuelle TSA- und Trust-Policy
- letzter persistierter Prüfstatus mit bisher größter lokaler und externer ID
- Empfängerrollen für interne Benachrichtigungen
- bei manuellem Lauf auslösender Mitarbeiter und Kanzlei-Tenant

## Entscheidungslogik

| Befund                                                        | Ergebnis                                                                                  |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Kette und Anker entsprechen der Prüfung                       | erfolgreichen Status mit aktuellen monotonen Spitzen speichern                            |
| Hash-, Link-, Seal-, Anchor- oder Policy-Fehler               | fehlerhaften Status speichern und offene Warnung erzeugen oder aktualisieren              |
| aktuelle lokale Spitze liegt unter zuvor beobachteter Spitze  | Tail-Truncation melden                                                                    |
| aktuelle externe Spitze liegt unter zuvor beobachteter Spitze | externe Tail-Truncation melden                                                            |
| Prüflauf selbst schlägt fehl                                  | Fehlerstatus speichern, bisherige Maximalspitzen nicht zurücksetzen                       |
| manueller Lauf ist erfolgreich                                | auslösendem Mitarbeiter ein positives Ergebnis melden                                     |
| Recovery-Checkpoint wird gesetzt                              | neue Vergleichsbasis dokumentieren, historische Manipulation nicht als repariert erklären |

## Ausnahmen und Grenzfälle

Ein Recovery-Checkpoint kann nach einem dokumentierten Restore eine neue
Überwachungsbasis setzen. Er ändert weder frühere Audit-Einträge noch frühere
Prüfergebnisse und unterdrückt keine anschließend neu auftretende Verkürzung.
Eine bereits offene Warnung wird aktualisiert, damit parallele Läufe nicht
beliebig viele gleichartige Meldungen erzeugen.

## Beispiele

### Normalfall

Der tägliche Lauf rechnet die vollständige Kette nach, verifiziert die
gespeicherten Anker und beobachtet eine mindestens gleich große Spitze wie beim
Vortag. Der technische Status wird als erfolgreich gespeichert.

### Grenzfall

Nach einem fehlerhaften Restore enthält die Datenbank weniger Audit-Zeilen als
beim letzten erfolgreichen Lauf. Auch wenn die verbliebene Teilkette in sich
korrekt ist, meldet der Worker die verkürzte Spitze.

## Umsetzung in TaxTronik

`audit-verify-check.ts` paginiert Kanzlei-Tenants, führt den vollständigen
Service-Verify in einer begrenzten Tenant-Transaktion aus, vergleicht lokale und
externe Maximal-IDs monoton und schreibt Status sowie Notifications.
`actions.ts` startet manuelle Läufe und dokumentiert Recovery-Checkpoints als
eigene Audit-Aktionen.

Die zentrale Audit-Anzeige wertet für die bernsteinfarbene historische Einordnung
den persistierten `recovered`-Wert zusammen mit dem Checkpoint aus. Ein alter
Checkpoint allein färbt neue Verkürzungsbefunde oder Lauf-Exceptions nicht um;
Exceptions werden mit Fehlerdetails rot dargestellt. Dies ändert keine
Workerentscheidung und behauptet keine separate Prüfung einer Recovery-Teilkette.

## Bekannte Abweichungen und Grenzen

Die Implementierung erfüllt die oben beschriebene Recovery- und
Monotonie-Sollregel noch nicht vollständig: Bei negativem `verifyChain` genügt
dem Worker derzeit ein vorhandener Checkpoint zur Alarmunterdrückung, ohne neue
von historischen Hash-/Seal-/Policy-Befunden zu trennen. Die separate
Recovery-Teilkettenprüfung ist abgeschaltet; ältere Typkommentare und bereits
geschriebene Checkpoint-Audittexte behaupten sie dennoch. Die normale
Ergebnispersistenz übernimmt außerdem die neu gemessene Spitze auch nach einer
erkannten Verkürzung; nur der Exception-Pfad erhält den Vorwert. Der
Exception-Pfad persistiert den Fehler, erzeugt aber selbst keine Notification.
Diese Konflikte erfordern eine gesonderte Korrektur des Recovery-Verfahrens;
die begrenzte Anzeigekorrektur löst sie nicht.

Die technische Prüfung belegt weder die rechtzeitige menschliche Kenntnisnahme noch eine fachgerechte
Bearbeitung und Schließung des Befunds. Scheduler-, Queue-, Datenbank- oder
Notification-Ausfälle können die Ausführung beziehungsweise Zustellung
verzögern und müssen separat überwacht werden.

## Fachliche Prüffragen

- Welche Rollen müssen einen Fehler erhalten und vertreten können?
- Welche Reaktions- und Eskalationsfristen gelten je Befundart?
- Unter welchen dokumentierten Voraussetzungen darf ein Recovery-Checkpoint
  gesetzt werden?
- Welcher Nachweis ist für Ursachenanalyse und Abschluss eines Alarms
  aufzubewahren?

## Technische Nachweise

Die vorhandenen Worker-Tests prüfen die reinen Funktionen zur lokalen und
externen Spitzenverkürzung, nicht die vollständige Orchestrierung,
Spitzenpersistenz oder Notification-Abwicklung. Die Statusmatrix prüft die
Anzeige neuer Fehler trotz altem Checkpoint. Der UI-Test belegt, dass ein angestoßener Prüflauf seinen Status
ohne vollständigen Chain-Walk im Renderpfad aktualisieren kann.
