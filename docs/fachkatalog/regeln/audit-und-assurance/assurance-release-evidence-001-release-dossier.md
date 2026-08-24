---
id: ASSURANCE-RELEASE-EVIDENCE-001
title: Releasebezogene technische Nachweise in einem Dossier binden
domain: audit-und-assurance
rule_type: office_policy
jurisdiction: DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Prüfungskoordination und technische Release-Verantwortung
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: partial
  summary: Release-Gates und Dossier-Vorlage können Commit, Images, CI-, Security-, SBOM- und Formatnachweise verbinden; ein tatsächlich befülltes dauerhaftes Dossier fehlt noch.
sources:
  - kind: professional_literature
    citation: IDW PS 880 n.F. (01.2022), Die Prüfung von Softwareprodukten, offizielle Fundstelle des IDW
    url: https://www.idw.de/idw/idw-verlautbarungen/idw-eps-880-n-f-03-2021.html
    checked_at: '2026-08-24'
    primary: true
  - kind: product_documentation
    citation: Release-Evidence-Dossier, ausdrücklich auszufüllende Vorlage ohne Prüfaussage
    path: docs/assurance/ps880-release-evidence.md
    checked_at: '2026-08-24'
    primary: true
  - kind: internal_policy
    citation: Interne Gap-Analyse und Maßnahmenplan zur Vorbereitung einer möglichen Softwareproduktprüfung
    path: docs/compliance/idw-ps880-pruefungsbereitschaft.md
    checked_at: '2026-08-24'
    primary: false
code_refs:
  - .forgejo/workflows/release.yml
  - scripts/release/check-release-gates.mjs
  - scripts/release/verify-release-config.mjs
test_refs:
  - scripts/release/tests/check-release-gates.test.mjs
  - scripts/release/tests/verify-release-config.test.mjs
feature_refs:
  - docs/assurance/ps880-release-evidence.md
  - docs/compliance/idw-ps880-pruefungsbereitschaft.md
  - docs/operations/release.md
related_rules:
  - ASSURANCE-PROFESSIONAL-REVIEW-001
  - AUDIT-HASH-CHAIN-001
  - AUDIT-RFC3161-ANCHOR-001
  - AUDIT-ARCHIVE-001
tags:
  - assurance
  - release
  - evidence
  - ps880-vorbereitung
---

# ASSURANCE-RELEASE-EVIDENCE-001 — Releasebezogene technische Nachweise in einem Dossier binden

## Kurzfassung

Für einen konkret benannten Release sollen Tag und Commit, unveränderliche
Image-Digests, signiertes Update-Manifest, ausgeführte CI- und Security-Jobs,
SBOMs, KoSIT-Berichte, Abweichungen und getrennte Freigabeentscheidungen in
einem nachvollziehbaren Dossier zusammengeführt werden. Workflow und Vorlage
schaffen dafür technische und dokumentarische Voraussetzungen, sind aber noch
kein ausgefüllter Nachweis und keine externe Prüfaussage.

## Wann gilt die Regel?

Die Regel gilt für den formalen `release`-Auslieferungskanal und einen
unverwechselbar bezeichneten Release-Lauf. Ein lokaler Build aus einem
beliebigen Source-Checkout fällt nur dann in denselben Nachweisumfang, wenn
Checkout, Buildumgebung, Artefakte, Tests und Abweichungen eigenständig und
gleichwertig eingefroren werden.

## Benötigte Angaben

- annotierter Versionstag, vollständiger Commit-SHA und gebundene Workflows
- Web- und Worker-Image mit Registry-Digest und OCI-Revision
- signiertes Update-Manifest und Schlüsselreferenz
- Run-/Job-IDs, Abschlussstatus, Logs und Artefakthashes aller relevanten Gates
- konkrete KoSIT-Konfiguration, Fälle und Einzelberichte
- CycloneDX-SBOMs und Security-Ergebnisse einschließlich nicht blockierender Befunde
- benannte Abweichungen, Entscheidungen und getrennte technische, betriebliche
  und fachliche Freigaben
- geschützte Ablage, Aufbewahrung und Wiederherstellungsnachweis des Dossiers

## Entscheidungslogik

| Situation                                                       | Dokumentarisches Ergebnis                                                     |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Tag, Commit, OCI-Revision, Digests und Manifest stimmen überein | gemeinsame Release-Identität dokumentieren                                    |
| Pflichtjob fehlt, ist übersprungen oder fehlgeschlagen          | als fehlenden oder negativen Nachweis erfassen, nicht als bestanden markieren |
| Image-Tag existiert bereits                                     | Publikation fail-closed stoppen statt den Versionsstand zu überschreiben      |
| Trivy meldet nicht blockierende oder nicht behebbare Befunde    | Befund und Gate-Semantik im Dossier sichtbar halten                           |
| KoSIT-Fall ist akzeptiert                                       | nur den konkreten Formatfall und Validatorstand belegen                       |
| Dossier-Vorlage ist leer oder nur teilweise befüllt             | keinen Release-Nachweis oder Readiness-Status behaupten                       |
| unabhängige Prüfung ist nicht erfolgt                           | keine Softwarebescheinigung oder Zertifizierung behaupten                     |

## Ausnahmen und Grenzfälle

Ein Artefakt-Upload mit `always()` beweist nicht, dass der davor liegende Test
bestanden wurde. Ein SemVer-Tag ohne Digest ist keine unveränderliche
Artefaktidentität. Ein wiederholter oder teilweise publizierter Lauf muss als
eigener Verlauf erhalten bleiben und darf nicht nachträglich zu einem
einheitlich grünen Lauf zusammengesetzt werden.

## Beispiele

### Normalfall

Ein Release-Tag löst Preflight, vollständige CI, Security-Gate, Image-Build,
Scan, SBOM-Erzeugung, Stack-Smoke, Registry-Push und Manifest-Publikation aus.
Das befüllte Dossier referenziert die realen Job-URLs, Ergebnisse, Artefakte und
Hashes genau dieses Laufs.

### Grenzfall

Der KoSIT-Job ist grün, aber ein nicht vom Fixture erfasster Steuerfall bleibt
offen. Das Dossier bezeichnet den getesteten Formatfall als erfolgreich und
führt den nicht geprüften fachlichen Fall als Grenze; es erklärt nicht die
gesamte Fakturierung für konform.

## Umsetzung in TaxTronik

Der Release-Workflow erzwingt Same-run-Gates, immutable Versions-Tags,
digestgebundene Images, SBOM-Erzeugung, Security-Scans, Stack-Smoke und ein
signiertes Manifest. Die Release-Skripte testen die Gate-Struktur und
fail-closed Konfiguration. Die Dossier-Datei stellt die Felder für die
tatsächlich ausgeführten Nachweise und Entscheidungen bereit.

## Bekannte Abweichungen und Grenzen

Der Repository-Stand enthält eine Vorlage, aber noch kein vollständig
befülltes, installationsbezogenes und dauerhaft unveränderlich archiviertes
Release-Dossier. CI-Artefakte werden derzeit nur mit einer angeforderten
Aufbewahrung von 90 Tagen hochgeladen; tatsächliche Plattformbegrenzung,
Langzeitübernahme und Restore-Nachweis bleiben offen. Diese Regel belegt weder
eine durchgeführte unabhängige Prüfung noch Prüfungsbereitschaft,
IDW-PS-880-Erfüllung, Zertifizierung oder Softwarebescheinigung.

## Fachliche Prüffragen

- Welcher Funktions- und Installationsumfang soll Gegenstand einer späteren
  unabhängigen Prüfung sein?
- Welche Nachweise und Aufbewahrungsdauer verlangt der beauftragte Prüfer?
- Welche fachlichen Regeln müssen für den eingefrorenen Release durch
  Berufsträger freigegeben sein?
- Wer darf technische, Security-, Betriebs- und Fachabweichungen entscheiden?
- Wie wird die unveränderliche, für Prüfer zugängliche Langzeitablage betrieben
  und regelmäßig wiederhergestellt?

## Technische Nachweise

Die Release-Gate-Tests manipulieren Pflichtabhängigkeiten, Tag- und
Digest-Bindung, Registry-Immutability, Scanner-, SBOM-, Smoke- und
Manifestpfade und erwarten fail-closed Fehler. Die Konfigurationstests prüfen
HTTPS, credentialfreie Ziel-URLs und den erforderlichen Ed25519-Schlüssel. Sie
belegen die Workflowstruktur, nicht die tatsächliche Durchführung eines
bestimmten Release-Laufs.
