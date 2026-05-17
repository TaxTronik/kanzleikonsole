# Compliance-Dokumentation

Vorlagen und Hinweise für die regulatorischen Pflichten einer
Steuerberatungskanzlei. Diese Dateien sind **Templates** — jede Kanzlei
muss sie an die eigene Situation anpassen.

## Übersicht

| Datei | Zweck |
|---|---|
| [dsfa-template.md](./dsfa-template.md) | Datenschutz-Folgenabschätzung nach Art. 35 DSGVO |
| [vvt-template.md](./vvt-template.md) | Verzeichnis von Verarbeitungstätigkeiten nach Art. 30 DSGVO |
| (eigene) gobd-konzept.md | GoBD-Verfahrensdokumentation (Pflicht nach AEAO § 146) |
| (eigene) gwg-richtlinie.md | Interne GwG-Richtlinie und Risikoanalyse |

## Pflichten im Überblick

| Vorschrift | Was wird verlangt | Wo abgebildet |
|---|---|---|
| **DSGVO Art. 30** (VVT) | Liste aller Verarbeitungstätigkeiten | siehe vvt-template.md |
| **DSGVO Art. 35** (DSFA) | Folgenabschätzung bei hohem Risiko | siehe dsfa-template.md |
| **DSGVO Art. 28** (AVV) | Auftragsverarbeitungs-Verträge | erfasst in `/staff/service-providers` |
| **DSGVO Art. 15-21** | Betroffenenrechte | abgewickelt in `/staff/admin/dsgvo` |
| **§ 146 AO + GoBD** | Unveränderbarkeit der Aufzeichnungen | Hash-Chain + RFC-3161 (ADR-0004), Object-Lock (ADR-0005) |
| **§ 147 AO** | 10-jährige Aufbewahrung | Object-Lock COMPLIANCE 10 Jahre |
| **§ 10 GwG** | Identifizierung des Mandanten | GwG-Modul mit Risikoanalyse + DB-Trigger (ADR-0007) |
| **§ 11 GwG / DSGVO Art. 28** | Dienstleister-Kontrolle | `/staff/service-providers` |
| **eIDAS Art. 26** | Fortgeschrittene elektronische Signatur | Token + OTP-Verfahren (ADR-0009) |
| **§ 257 HGB** | 6-jährige Aufbewahrung kaufmännischer Korrespondenz | Object-Lock COMPLIANCE |
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
