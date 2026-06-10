# Compliance-Dokumentation

Vorlagen und Hinweise für die regulatorischen Pflichten einer
Steuerberatungskanzlei. Diese Dateien sind **Templates** — jede Kanzlei
muss sie an die eigene Situation anpassen.

## Übersicht

| Datei | Zweck |
|---|---|
| [dsfa-template.md](./dsfa-template.md) | Datenschutz-Folgenabschätzung nach Art. 35 DSGVO |
| [vvt-template.md](./vvt-template.md) | Verzeichnis von Verarbeitungstätigkeiten nach Art. 30 DSGVO |
| [gobd.md](./gobd.md) | GoBD-Verfahrensdokumentation der Software (die kanzleieigene Verfahrensdoku bleibt Pflicht, siehe [gobd-template.md](./gobd-template.md)) |
| [gwg.md](./gwg.md) | GwG-Pflichten → Module-Mapping (Identifizierung, Aufzeichnung, Vernichtung); die interne GwG-Richtlinie + Risikoanalyse (§ 5 GwG) erstellt die Kanzlei selbst |
| [idw-ps880-pruefungsbereitschaft.md](./idw-ps880-pruefungsbereitschaft.md) | Prüfungsbereitschaft der Software nach IDW PS 880: Scope, Gap-Analyse, Maßnahmenstand |
| [idw-ps980-tcms.md](./idw-ps980-tcms.md) | TCMS nach IDW PS 980: Grundelemente-Mapping, Teilbereich Organschaft (Konzept iter88) |

## Pflichten im Überblick

| Vorschrift | Was wird verlangt | Wo abgebildet |
|---|---|---|
| **DSGVO Art. 30** (VVT) | Liste aller Verarbeitungstätigkeiten | siehe vvt-template.md |
| **DSGVO Art. 35** (DSFA) | Folgenabschätzung bei hohem Risiko | siehe dsfa-template.md |
| **DSGVO Art. 28** (AVV) | Auftragsverarbeitungs-Verträge | erfasst in `/staff/service-providers` |
| **DSGVO Art. 15-21** | Betroffenenrechte | abgewickelt in `/staff/admin/dsgvo` |
| **§ 146 AO + GoBD** | Unveränderbarkeit der Aufzeichnungen | Hash-Chain + RFC-3161 (ADR-0004), Object-Lock (ADR-0005) |
| **§ 147 AO** | 10-jährige Aufbewahrung | Object-Lock COMPLIANCE 10 Jahre |
| **§ 10 GwG** | Identifizierung des Mandanten | GwG-Modul mit Risikoanalyse + DB-Trigger (ADR-0007), siehe [gwg.md](./gwg.md) |
| **§ 8 GwG** | Aufzeichnung (5 J. Höchstfrist) + Vernichtungspflicht | `gwg`-Bucket GOVERNANCE 5 J. + Review-Queue `/staff/admin/gwg-retention`, siehe [gwg.md](./gwg.md) |
| **§ 11 GwG / DSGVO Art. 28** | Dienstleister-Kontrolle | `/staff/service-providers` |
| **eIDAS Art. 26** | Fortgeschrittene elektronische Signatur | Token + OTP-Verfahren (ADR-0009) |
| **§ 257 HGB** | 6-jährige Aufbewahrung kaufmännischer Korrespondenz | keine eigene 6-Jahres-Lock-Stufe — es gibt genau drei Schutzstufen (kein Lock / GwG 5 J. GOVERNANCE / GoBD 10 J. COMPLIANCE). Korrespondenz ohne GoBD-Einstufung liegt ohne Object-Lock im `general`-Bucket; wer Unveränderbarkeit braucht, stuft als GoBD-Typ ein (10 J. decken die 6 J. ab) |
| **§ 203 StGB** | Verschwiegenheit | RBAC, RLS, separater Auth-Flow |
| **§ 26 BDSG** | Mitarbeiterdaten | Mitarbeiter-Zeit/Urlaub mit RBAC |

## Vorgehen bei einer Aufsichtsbehörden-Anfrage

1. VVT auf Stand bringen (`/staff/admin/audit` für Beleg, dass System aktiv ist)
2. DSFA vorlegen, falls vorhanden
3. AVV-Liste aus `/staff/service-providers` exportieren (CSV)
4. Audit-Log-CSV-Export für den angefragten Zeitraum
5. Hash-Chain-Verifikation als Beweis der Manipulationsfreiheit:
   `pnpm verify:chain` (CLI) oder `/staff/admin/audit` (UI)

## Bei einer Datenpanne (Art. 33 DSGVO)

Innerhalb 72 Stunden nach Kenntnis melden bei der zuständigen
Aufsichtsbehörde, wenn ein Risiko für betroffene Personen besteht.

Vorbereitung:
- Audit-Log-Export für den fraglichen Zeitraum
- Liste der wahrscheinlich betroffenen Mandanten/Personen
- Bereits ergriffene Gegenmaßnahmen
- Bei hohem Risiko: zusätzlich Betroffeneninformation (Art. 34)
