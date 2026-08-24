---
id: GOBD-VERFAHRENSDOKU-001
title: Technischen IST-Baustein der Verfahrensdokumentation erzeugen
domain: dokumente-und-aufbewahrung
rule_type: administrative_guidance
jurisdiction: DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Berufsträger GoBD und Verfahrensdokumentation
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: partial
  summary: >-
    TaxTronik rendert aus Laufzeitkonfiguration, Betriebsnachweisen und
    versionierten Herstellertexten einen datierten technischen IST-Baustein.
    Vollständige Prozessbeschreibung, Programmidentität, Dokumentenlenkung,
    tatsächliche Kontrollausführung und Freigabe bleiben Betreiberaufgaben.
sources:
  - kind: official_guidance
    citation: GoBD in amtlicher AO-Handbuchfassung 2025, Rn. 145 bis 155
    url: https://stberh.bundesfinanzministerium.de/ao/2025/Anhaenge/BMF-Schreiben-und-gleichlautende-Laendererlasse/Anhang-33/inhalt.html
    checked_at: '2026-08-24'
    primary: true
  - kind: product_documentation
    citation: Technische GoBD-Verfahrensdokumentation TaxTronik
    path: docs/compliance/gobd.md
    checked_at: '2026-08-24'
    primary: false
  - kind: internal_policy
    citation: Kanzleivorlage für organisatorische Verfahrensdokumentation
    path: docs/compliance/gobd-template.md
    checked_at: '2026-08-24'
    primary: false
code_refs:
  - apps/web/src/server/compliance/verfahrensdoku.ts
  - apps/web/src/app/api/staff/admin/verfahrensdoku/route.ts
test_refs:
  - apps/web/src/server/compliance/__tests__/verfahrensdoku.test.ts
feature_refs:
  - docs/compliance/gobd.md
  - docs/compliance/gobd-template.md
  - docs/anwenderdoku/administration.md
related_rules:
  - DOC-RETENTION-CLASS-001
  - DOC-OBJECT-LOCK-001
  - DOC-VERSION-IMMUTABILITY-001
tags:
  - gobd
  - verfahrensdokumentation
  - ist-stand
---

# GOBD-VERFAHRENSDOKU-001 — Technischen IST-Baustein der Verfahrensdokumentation erzeugen

## Kurzfassung

TaxTronik kann einen datierten Markdown-Baustein aus dem aktuell erfassten
Systemzustand und versionierten Herstellertexten erzeugen. Er enthält unter
anderem Version, Module, Mengengerüst, Backup-/Drillstatus, Auditprüfung und
TSA-Konfiguration. Nach GoBD muss die Verfahrensdokumentation jedoch das
tatsächlich eingesetzte organisatorische und technische Verfahren vollständig,
schlüssig, verständlich, aktuell und historisch nachvollziehbar beschreiben;
der Generator allein erfüllt das nicht.

## Wann gilt die Regel?

Die Regel gilt, wenn eine berechtigte Kanzleiperson über die Admin-Funktion
einen technischen IST-Baustein für die installationsbezogene
Verfahrensdokumentation erzeugt. Sie gilt nicht als automatische Freigabe,
Zertifizierung oder Beweis, dass Dokument und gelebter Prozess übereinstimmen.

## Benötigte Angaben

- Kanzleiname und erzeugende Person
- Anwendungs- und Commitversion sowie Auslieferungskanal
- aktive Module und installationsbezogene externe Datenflüsse
- Rollen- und Zugriffskonzept
- aktueller Backup- und Restore-Drillstatus
- aktuelles Audit-Chain-/Anker-/TSA-Ergebnis
- Dokument- und Nutzer-Mengengerüst
- organisatorische Arbeitsanweisungen, Zuständigkeiten und Kontrollen der Kanzlei
- versionierte Änderungshistorie und Aufbewahrung der freigegebenen Fassung

## Entscheidungslogik

| Wenn                                         | Dann                                                                            | Begründung                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Generator wird aufgerufen                    | erfassten Laufzeitstand sammeln und datiertes Markdown rendern                  | reproduzierbarer technischer IST-Baustein                 |
| Backup oder Drill fehlt/fehlschlägt          | deutlichen Warnhinweis ausgeben                                                 | fehlenden Nachweis nicht als Erfolg darstellen            |
| Auditprüfung meldet Bruch                    | Warnung statt Integritätsbehauptung ausgeben                                    | Ist-Status wahrheitsgemäß abbilden                        |
| Source-Build oder unbekannter Kanal vorliegt | fehlende Identität zum CI-Release sichtbar nennen                               | keine unbelegte Artefaktgleichheit                        |
| optionale externe Ziele möglich sind         | installationsbezogene Ergänzung verlangen                                       | On-Premise-Setup beweist keine rein lokale Verarbeitung   |
| technischer Baustein ist erzeugt             | organisatorisch ergänzen, prüfen, freigeben, versionieren und geschützt ablegen | vollständige Verfahrensdokumentation ist Betreiberaufgabe |

## Ausnahmen und Grenzfälle

Nicht jede tatsächliche Einstellung und keine gelebte Arbeitsanweisung ist im
Datenmodell erfasst. Statische Herstellertexte können nach einer
Architekturänderung veralten. Der Generator prüft keine vollständige
Programmidentität zwischen laufenden Images, Commit, Konfiguration und
freigegebener Dokumentversion. Er legt seine Ausgabe nicht automatisch als
GoBD-Dokument ab und führt keine vollständige Änderungshistorie der
kanzleiseitig ergänzten Fassung.

## Beispiele

### Normalfall

Nach einem Release erzeugt die Kanzlei den IST-Baustein. Version, Module,
erfolgreicher Restore-Drill und intakte Auditprüfung werden übernommen. Die
Kanzlei ergänzt Belegfluss, Zuständigkeiten und Arbeitsanweisungen, prüft die
Gesamtfassung und legt sie versioniert geschützt ab.

### Grenzfall

Die Installation läuft aus einem lokalen Source-Build und besitzt noch keinen
Restore-Drill. Das Dokument nennt die fehlende Release-Identität und den
fehlenden Drill ausdrücklich. Es darf nicht als vollständiger
Ordnungsmäßigkeitsnachweis freigegeben werden.

## Umsetzung in TaxTronik

`collectVerfahrensdokuData` liest Tenant, Module, TSA-Konfiguration, letzten
Backupstand, Drill- und Auditprüfergebnis sowie Zähler. `buildVerfahrensdoku`
rendert daraus einen strukturierten Markdown-Text mit technischen Aussagen,
Warnungen, Grenzen und Verweisen auf Herstellerdokumentation. Die Route
authentifiziert den Staff-Aufruf und protokolliert die Erzeugung.

## Bekannte Abweichungen und Grenzen

Die Umsetzung ist teilweise. Der Generator erfasst nicht vollständig
allgemeine Beschreibung, Anwender-, System- und Betriebsdokumentation des
konkreten Verfahrens. Organisatorische Durchführung, autorisierte
Änderungsverfahren, gelebte IKS-Kontrollen, vollständige Programmidentität,
historische Dokumentenlenkung, fachliche Freigabe und revisionssichere Ablage
der fertigen Gesamtfassung bleiben manuell.

## Fachliche Prüffragen

- Deckt die Gesamtfassung alle für das konkrete DV-Verfahren nötigen Inhalte ab?
- Wie werden Programmidentität und jede Verfahrensänderung historisch nachgewiesen?
- Wer prüft und genehmigt organisatorische und technische Teile?
- Wie wird die freigegebene Fassung für die maßgebliche Dauer versioniert aufbewahrt?
- Stimmen die Herstellertexte mit der tatsächlich betriebenen Installation überein?

## Technische Nachweise

Der Builder-Test belegt die Darstellung von Version, Kanal, Modulen,
Mengengerüst, Backup-/Drill- und Auditstatus sowie ehrliche Warnungen bei
fehlenden oder negativen Ergebnissen. Nicht getestet sind vollständige
Collector-Integration, automatische Ablage, Dokumentenlenkung und die
Übereinstimmung mit dem gelebten Kanzleiprozess.
