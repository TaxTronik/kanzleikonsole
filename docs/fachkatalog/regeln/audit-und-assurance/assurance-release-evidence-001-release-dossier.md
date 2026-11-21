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
  - apps/e2e/tests/helpers/postgres.ts
  - apps/e2e/tests/helpers/redis.ts
  - packages/db/scripts/verify-drift.ts
  - packages/db/scripts/drift-shadow.ts
  - .forgejo/workflows/ci.yml
  - apps/e2e/playwright.ui.config.ts
  - scripts/check-paranoid-e2e.mjs
  - apps/web/src/server/update/manifest.ts
  - .forgejo/workflows/release.yml
  - .forgejo/workflows/security.yml
  - scripts/ci/scan-service-images.mjs
  - scripts/ci/postgres-gosu-assessment.mjs
  - scripts/ci/clamav-advisories.mjs
  - scripts/ci/setup-trivy.sh
  - scripts/release/check-release-gates.mjs
  - scripts/release/smoke-release-images.sh
  - scripts/release/verify-release-config.mjs
test_refs:
  - scripts/tests/check-paranoid-e2e.test.mjs
  - apps/e2e/tests/ui/berlin-form-defaults.spec.ts
  - apps/e2e/tests/ui/invoice-form-layout.spec.ts
  - apps/e2e/unit/postgres.test.ts
  - apps/e2e/unit/redis.test.ts
  - apps/e2e/tests/inbox-composer-state.spec.ts
  - packages/db/src/__tests__/drift-shadow.test.ts
  - packages/db/src/__tests__/drift-shadow-identity.test.ts
  - apps/web/src/server/update/__tests__/manifest.test.ts
  - scripts/release/tests/check-release-gates.test.mjs
  - scripts/tests/service-image-security.test.mjs
  - scripts/tests/postgres-gosu-assessment.test.mjs
  - scripts/release/tests/smoke-preflight.test.mjs
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
- Bei einer Einzelbewertung im Service-Image-Scan zusätzlich Rohbefund, Image-Digest,
  Plattform, Prüfnachweis und Anzahl der nach der Bewertung sperrenden Befunde
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
| Der gosu-Befund erfüllt alle Kriterien der Einzelbewertung      | Rohbefund, Nachweis und Zahl der sperrenden Treffer dokumentieren             |
| KoSIT-Fall ist akzeptiert                                       | nur den konkreten Formatfall und Validatorstand belegen                       |
| Dossier-Vorlage ist leer oder nur teilweise befüllt             | keinen Release-Nachweis oder Readiness-Status behaupten                       |
| unabhängige Prüfung ist nicht erfolgt                           | keine Softwarebescheinigung oder Zertifizierung behaupten                     |

## Ausnahmen und Grenzfälle

Ein Artefakt-Upload mit `always()` beweist nicht, dass der davor liegende Test
bestanden wurde. Ein SemVer-Tag ohne Digest ist keine unveränderliche
Artefaktidentität. Ein wiederholter oder teilweise publizierter Lauf muss als
eigener Verlauf erhalten bleiben und darf nicht nachträglich zu einem
einheitlich grünen Lauf zusammengesetzt werden.

Die Einzelbewertung betrifft CVE-2025-68121 im offiziellen PostgreSQL-Image
`postgres:18-alpine3.23@sha256:f3ee138d5fce80ffaeb315b8bea7610f0c4f2304fb2aceb4ec8e457b92fc41a0`
für `linux/amd64`. Trivy meldet `stdlib` in Version `v1.24.6` für
`/usr/local/bin/gosu`. Der SHA-256 der geprüften Binärdatei lautet
`b1892636c281590f34bc63c1118f058cd9de66c4ea463772e3909672d8b302ac`.
Die Symbolprüfung am ausgelieferten Programm bestätigte, dass die vom
Go-Advisory betroffene Funktionalität aus `crypto/tls` fehlt. Nur für diese
Kombination gilt `not_affected`. Bei einem neuen Image-Digest muss die
technische Release-Verantwortung den Befund neu bewerten. [Go-Advisory](https://pkg.go.dev/vuln/GO-2026-4337) · [Dokumentierter Binärnachweis](../../../reviews/2026-11-21-nachpruefung-imagepflege-und-codeabbau.md#nachtrag-zur-gosu-sicherheitsrichtlinie-am-21-november)

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

Beim Abruf des Update-Manifests gelten die bestehenden Byte-Limits bereits
während des Lesens: 1 MiB für das Manifest und 4096 Bytes für die separate
Signaturdatei. Dekodierung und Whitespace-Bereinigung erfolgen erst danach.
Status-, Größen- und Streamablehnungen brechen den Antwortstrom ab, statt
überzählige Daten vollständig einzulesen. Signatur-, Schema- und
Versionsprüfung bleiben unverändert.

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

Der Security-Job ordnet die produktiven Dienste den tatsächlich gescannten
Image-Digests für `linux/amd64` zu. Er archiviert den Datenbankstand,
HIGH- und CRITICAL-Paketbefunde und den Vergleich der ausgeführten
ClamAV-Engine mit den Herstellerreleases und dem Ende der kritischen
Patchpflege ihrer Wartungslinie. Die NVD-Abfrage zur ausgeführten Version
dokumentiert eigenständige Engine-Treffer und zusätzliche Produktbedingungen.
CVEs aus anderen Herstellerlinien ohne eindeutigen Treffer oder Nachweis
in der eigenen Linie erscheinen zur Nachprüfung. Eindeutige NVD-Treffer,
ausstehende Engine-Patches, abgelaufene Patchpflege und technisch
unvollständige Prüfungen sperren die Promotion. Bei Paketbefunden sperrt
jeder behebbare CRITICAL-Treffer außer der oben gebundenen Einzelbewertung.
Der Service-Image-Scan behält den Trivy-Bericht und die Rohzahlen. Seine
Zusammenfassung enthält die Bewertung, den Binärnachweis und die Zahl der
effektiv sperrenden Befunde. Ein abweichender Binärhash sperrt den Befund
(Exit 1). Kann der Job den Nachweis nicht lesen, sperrt er die Freigabe als
technisch unvollständig (Exit 2). Der gesonderte Scan der Web- und
Worker-Releaseimages sperrt jeden behebbaren CRITICAL-Befund. Die zugehörigen Tests
prüfen auch voneinander abweichende Compose-Varianten, fehlende
Paketabdeckung und einen fehlenden Herstellerbeleg.

Der Quality-Workflow führt die Formularprüfungen in Chromium und Firefox mit
schmalem und breitem Fenster und festgelegten Browserzeitzonen aus. Der
Playwright-Bericht ordnet jeden ausgeführten Fall seinem Browserprofil zu.
Die Fälle prüfen Bedienelemente, Feldwerte und übergebene Formulardaten an
der Grenze zur Serveraktion. Der gesonderte vollständige E2E-Lauf verwendet
die gebaute Anwendung mit den angeschlossenen Diensten.

Die PostgreSQL-Gegenproben der Browsertests gleichen den konfigurierten
Datenbanknamen mit der Anwendungs-URL ab. Der Fixture-Test erfasst auch
ein widersprüchliches Ziel und die Behandlung einer fehlgeschlagenen
SQL-Anweisung. Ein solcher Fehler darf keine Wiederholung auf einem anderen
Zugangsweg auslösen.

Der Stack-Smoke prüft vor dem ersten Containerstart, ob die Umgebung frei
und der Docker-Daemon erreichbar ist. In beiden Abbruchfällen prüft
`smoke-preflight.test.mjs`, dass nur die Bestandsabfrage erfolgt. Ein gestarteter
Testlauf verwendet eigene Namen für sein Compose-Projekt und seine Hilfsimages.

Die E2E-Testbereinigung verwendet ausdrücklich die Datenbanknummer aus der
Redis-URL. Sie bestätigt `SELECT`, bevor sie `FLUSHDB` sendet; ein fehlerhafter
Index darf nicht versehentlich Datenbank 0 leeren. Nicht unterstützte
Authentifizierungs-/TLS-URLs und mehrdeutige Pfade werden vor Netzwerkzugriff
abgewiesen. Die im normalen Unit-Job ausgeführten Node-Tests prüfen getrennte
DB-Inhalte, fragmentierte Antworten und Fehler-/Verbindungsabbruchpfade über
einen lokalen TCP-Server. Das ersetzt keinen vollständigen Browserlauf.
Der normale Workspace-Typecheck umfasst nun auch sämtliche E2E-Specs und
Helper-Units; die Inbox-Testdaten sind entsprechend ihrem Fixture-Payload
typisiert. Die Laufzeitassertionen und die vollständige Playwright-Erkennung
bleiben erhalten.

Der Schema-Check prüft zunächst das Migrations-Ledger der Ziel-DB und baut
anschließend eine ausdrücklich getrennte Shadow-Datenbank auf. Er entfernt
auch das handgepflegte `app`-Schema; ein bloßer Prisma-Reset von `public`
ließ dort zuvor Funktionen zurück und scheiterte beim wiederholten Lauf.
Konfigurations- und Live-Datenbankprüfung verhindern das Zurücksetzen derselben
Zieldatenbank. CI führt den vollständigen Check zweimal aus. Die Regression
prüft Wiederholbarkeit an einer eigenen PostgreSQL-Datenbank; das ist kein
Beweis der fachlichen Richtigkeit aller dort installierten Funktionen.

Die Release-Gate-Tests manipulieren Pflichtabhängigkeiten, Tag- und
Digest-Bindung, Registry-Immutability, Scanner-, SBOM-, Smoke- und
Manifestpfade und erwarten fail-closed Fehler. Die Konfigurationstests prüfen
HTTPS, credentialfreie Ziel-URLs und den erforderlichen Ed25519-Schlüssel. Sie
belegen die Workflowstruktur, nicht die tatsächliche Durchführung eines
bestimmten Release-Laufs.

Die Manifestregression prüft übergroße Antworten ohne verlässliche
Content-Length, mehrbyteigen Whitespace, die exakt zulässige Signaturgröße
und die Abbruchweitergabe bei früher Ablehnung. Sie belegt den begrenzten
Transport und die erhaltene Signaturprüfung, keine Release-Freigabe.
