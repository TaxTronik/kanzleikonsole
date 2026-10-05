# Eingebettete PDF-Schriften

Unveränderte Noto Sans (Regular/Bold) und die offiziellen Noto Sans SC
Subset-OTF-Dateien (Regular/Bold). Beide Projekte stehen unter SIL Open Font
License 1.1; vollständige Lizenz-/Copyrighttexte liegen in `OFL.txt` und
`OFL-NotoSans.txt`. Keine Schriften einer Windows-Installation werden verteilt.

`upstream.json` bindet jeden Download an den Commit im offiziellen
`notofonts/noto-fonts` beziehungsweise `notofonts/noto-cjk` Repository, URL,
SHA-256 und Dateigröße. Die Herkunft wurde am 31.08.2026 kontrolliert.
Noto Sans stammt aus dem seit 2023 archivierten offiziellen Release-Repository.

`manifest.json` ergänzt die tatsächlich vorhandenen Unicode-Zeichenbereiche.
Nach einem bewusst geprüften Assetwechsel erzeugt
`node scripts/pdf-font-coverage.mjs` sie mit PDFKits eigener Fontkit-Abhängigkeit
neu. Der Server verifiziert die Dateihashes vor der ersten Einbettung.
Die Dateien liegen bewusst nicht unter `apps/web/public`: Sie werden nur
serverseitig zur PDF-Einbettung gelesen und sind nicht ohne Sitzung abrufbar.
`outputFileTracingIncludes` in `apps/web/next.config.mjs` nimmt sie samt
Lizenztexten in das Standalone-Paket und damit in das Docker-Image auf. Es gibt
keinen Schrift-Download im Produktivbetrieb.

Abdeckung ist keine Behauptung vollständiger Unicode-/Sprachunterstützung.
Latin Extended und Vietnamesisch verwenden Noto Sans; vorhandene CJK-Zeichen
verwenden Noto Sans SC (vereinfachte chinesische Formvarianten). Nicht abgedeckte
Grapheme, etwa Emoji oder nicht enthaltene Schriften, sperren die PDF-Ausgabe
ausdrücklich. Namen werden nicht transliteriert, normalisiert oder still ersetzt.
PDFKit bettet die verwendeten Glyphen als Untermenge ein; die Quelldateien bleiben
unverändert unter ihrer ursprünglichen Lizenz.
