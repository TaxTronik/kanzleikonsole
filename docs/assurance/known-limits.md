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

Ein ungetestetes Backup ist kein Backup. Der `backup-drill` Worker-Job testet
regelmäßig die Restore-Funktionalität gegen eine Wegwerf-Datenbank. Dennoch
bleibt die Verantwortung für Offsite-Backups und Disaster-Recovery-Pläne bei
der betreibenden Kanzlei.
