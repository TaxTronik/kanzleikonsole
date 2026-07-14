# TaxTronik — Dokumentierte Grenzen (Known Limits)

> Vertrauen wird nicht behauptet, sondern nachgewiesen. Teil des Nachweises ist
> die ehrliche Dokumentation dessen, was TaxTronik **nicht** leistet.

## 1. TaxTronik ersetzt keine fachliche Würdigung

Die Software automatisiert Workflows, Dokumentation, Fristen und Kommunikation.
Die **fachliche Beurteilung** steuerlicher Sachverhalte bleibt Aufgabe des
Berater. TaxTronik strukturiert und konserviert, entscheidet aber nicht.

## 2. TaxTronik ist kein TCMS an sich

Ein Tax Compliance Management System (TCMS) umfasst Organisationsstrukturen,
Prozesse und Dokumentation über die Software hinaus. TaxTronik kann ein TCMS
**unterstützen**, aber nicht ersetzen. Die Verantwortung für ein funktionierendes
TCMS liegt bei der Kanzlei.

## 3. TaxTronik ersetzt keine IDW-Prüfung

Die IDW PS 880 / PS 980 Prüfungen erfordern unabhängige Prüfer und können nicht
durch Software allein erfüllt werden. TaxTronik ist auf Prüfungsreadiness
ausgelegt, ersetzt aber nicht die Prüfung selbst.

## 4. Quantum Randomness

Die Quantum-Randomness-Komponente (`packages/tax`) beschleunigt nichts und
beweist nicht die Vollständigkeit der Population. Sie stellt sicher, dass die
Auswahl **nicht vorhersagbar** ist und **reproduzierbar** bleibt (gleiche Inputs
→ gleiche Auswahl). Die Vollständigkeit der Erfassungsgrundlage ist eine
fachliche Eingabe, kein Software-Ergebnis.

## 5. Replay beweist nur Reproduzierbarkeit

Der Replay-Mechanismus beweist: Gleiche Inputs führen zur gleichen Auswahl.
Er beweist **nicht**, dass die Auswahl korrekt, vollständig oder rechtlich
vertretbar ist. Die fachliche Prüfung der Stichproben-Parameter bleibt
obligatorisch.

## 6. Externe KI ist Hilfsmittel, nicht Entscheidungsinstanz

TaxTronik kann externe KI-Dienste (z. B. für Risiko-Analyse, Dokumenten-
Klassifizierung) einbinden. Diese Dienste liefern Vorschläge und Einschätzungen,
treffen aber keine bindenden Entscheidungen. Die Verantwortung liegt immer beim
menschlichen Berater. KI-Ergebnisse sind als Arbeitserleichterung zu verstehen,
nicht als fachliches Urteil.

## 7. RLS ist die letzte Barriere, nicht die einzige

Row-Level Security verhindert Cross-Tenant-Zugriff auf Datenbankebene. Sie ist
aber kein Ersatz für App-Level-Filter — beide Schichten müssen konsistent sein.
Wenn die App versehentlich alle Datensätze lädt (ohne Tenant-Filter) und nur RLS
filtert, ist das ein Performance- und Design-Problem, auch wenn keine Daten
leaken.

## 8. Audit-Chain schützt vor nachträglicher Änderung, nicht vor Echtzeit-Manipulation

Die Hash-Chain mit RFC 3161 TSA beweist, dass die Aufzeichnungen nach dem
Sealing nicht verändert wurden. Sie kann nicht verhindern, dass ein Angreifer
mit Datenbankzugriff vor dem Sealing Einträge manipuliert. Das Sealing erfolgt
täglich; bis zum nächsten Seal ist die Chain nur kryptographisch verkettet,
aber nicht extern timestamped.

## 9. Open Source bedeutet nicht automatisch sicher

Der Code ist offen einsehbar. Das ermöglicht unabhängige Prüfungen, bedeutet
aber auch, dass Angreifer die Sicherheitsarchitektur studieren können.
Security-by-Obscurity ist keine Schutzmaßnahme — aber Open Source ist kein
Schutz allein. Die Sicherheit resultiert aus den dokumentierten Schichten
(RLS, RBAC, Audit, Tests), nicht aus der Geheimhaltung des Codes.

## 10. Backups schützen nur, wenn sie getestet wurden

Ein ungetestetes Backup ist kein Backup. Der monatliche `backup-drill`
Worker-Job lädt den letzten erfolgreichen **Datenbank-Dump**, prüft dessen
SHA-256-Wert, spielt ihn in eine Wegwerf-Datenbank ein und verifiziert dort die
Audit-Hash-Chain. Das ist ein wichtiger DB-Nachweis, aber kein isolierter
Wiederanlauf des Gesamtsystems.

Der automatische Drill entschlüsselt kein versiegeltes `backup-full`, stellt
keine Cold-Snapshots von SeaweedFS, Redis oder n8n wieder her und prüft weder
n8n-Credentials noch Dokumentabruf, Login, Release-Images oder die
Recovery-Konfiguration. Auch `backup-verify` und `backup-decrypt` belegen nur
Signatur, Hashes, Entschlüsselbarkeit und Archivstruktur. Ein regelmäßig
dokumentierter **Full-Restore-Drill auf einem isolierten Zielsystem** bleibt
deshalb Betreiberpflicht. Gleiches gilt für getrennte Offsite-Kopien, die
Verfügbarkeit der offline verwahrten age-Identity und Public Keys sowie einen
getesteten Disaster-Recovery-Plan.

## 11. Release-Promotion ist fail-closed, die Publikation nicht transaktional

Der Release-Workflow erzwingt die vollständigen CI- und Security-Workflows im
selben Lauf für den exakten annotierten Tag-Commit. Das signierte Manifest
bindet Commit-SHA sowie Web- und Worker-Image an getrennte SHA-256-Digests. Die
Operator-CLI prüft Checkout und OCI-Labels, deployt beide Images digest-gepinnt
und bewahrt für Rollbacks einen vollständigen Last-Good-Vertrag auf. Die früher
dokumentierten CI- und Single-Image-Lücken sind damit keine offenen
Release-Blocker mehr.

Die Veröffentlichung über Container-Registry und separates Manifest-Repository
ist jedoch nicht atomar. Wenn ein Image bereits gepusht wurde und ein späterer
Push oder die Manifest-Publikation fehlschlägt, können partielle SemVer-Artefakte
in der Registry verbleiben. Ohne erfolgreich publiziertes Manifest werden sie
vom verifizierten Betreiberpfad nicht promotet oder deployt. Da Release-Tags
write-once sind, muss das Release-Team solche Reste vor einem Wiederholungslauf
prüfen und gegebenenfalls manuell bereinigen; automatische Registry-Bereinigung
und standortübergreifende Transaktionsgarantien bestehen nicht.

## 12. DATEV-Beleg-ZIP ist kein vollständiger GoBD-Datenzugriff

Ein aus TaxTronik erzeugtes DATEV-Beleg-ZIP dient dem strukturierten
Belegexport. Es weist für sich allein weder einen vollständigen Datenzugriff
nach den Formen Z1, Z2 und Z3 noch die Vollständigkeit aller steuerlich
relevanten Vorsystemdaten nach. Auswahl, Bereitstellung und Verfahrensnachweis
bleiben eine organisatorische Aufgabe der Kanzlei und ihrer angebundenen
Systeme.

## 13. Dokument-Uploads sind größenbegrenzt, aber noch nicht vollständig gestreamt

Die dokumentierten Upload-Routen parsen Multipart-Daten derzeit im
Web-Prozess. Eine einzelne Datei ist deshalb auf 25 MiB begrenzt; der
mitgelieferte nginx begrenzt den Request auf 26 MiB und parallele
Dokument-Uploads zusätzlich pro IP und für den gesamten Virtual Host. Diese
Schranken reduzieren den Speicher- und DoS-Radius, machen den Parser aber nicht
zu einem O(1)-Streaming-Pfad.

Ein eigener oder umgangener Reverse Proxy muss mindestens gleichwertige Body-
und Parallelitätsgrenzen setzen. Für größere Dateien oder höhere parallele Last
ist vor einer Kapazitätsfreigabe ein Streaming-Multipart-Parser beziehungsweise
ein isolierter Import-Job erforderlich.
