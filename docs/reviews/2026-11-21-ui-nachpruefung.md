# Visuelle Nachprüfung vom 21. November 2026

## Checkliste des damaligen Durchlaufs

Diese 23 Punkte stammen aus der visuellen Nachprüfung auf dem lokalen
Arbeitsstand mit 166 aufgerufenen Seiten in zwei Bildschirmgrößen. Für jeden
Punkt wurde der genannte Bedienablauf oder der sichtbare Zustand geprüft.
Die Häkchen beziehen sich auf diesen Durchlauf. Der damalige ungefilterte
Playwright-Lauf bestand alle 240 Fälle. Die anschließende [Nachprüfung zum
Berliner Kalendertag](2026-11-21-berliner-kalendertag.md) dokumentiert die
zusätzlichen Einstiege und ihre eigenen Ergebnisse.

Der lokale HTML-Bericht mit Screenshots und Rohprotokollen liegt im Verzeichnis
`.codex-run/ui-nachpruefung-20261121/`. Die Protokollnamen in den Einträgen
beziehen sich auf dessen Unterordner `intern/`.

- [x] **Tax-CMS · Kontrolldurchführung.** Fünf Einträge mit unterschiedlichem Status
      öffnen ihre Detailansicht mit Schritten, Nachweisen und Ergebnis.
      Chromium (`tcms-browser.json`)
- [x] **Wissen im Kontext.** Die Navigation blendet die Leitfadenverwaltung für
      Mitarbeiter aus. Ein Partner kann sie über das Menü öffnen.
      Chromium (`eigene-chromium.json`) · Firefox (`eigene-firefox.json`)
- [x] **Portal · Abgebrochene Anforderung.** Dashboard, Liste und Detail zeigen beim
      selben Vorgang „Abgebrochen“.
      Chromium und Firefox (`form-recheck-normal.json`)
- [x] **Kalender · Weitere Einträge.** Der vierte Termin und die fünfte Steuertermingruppe
      sind erreichbar. Der Dialog enthält auch Abwesenheiten und abgesagte Termine.
      Termine (`work-bilder/kalender-zusatzeintraege.png`) · Steuertermingruppe
      (`work-bilder/steuerkalender-gruppe.png`) · Chromium (`work-browser.json`)
- [x] **Portalformular · Pflichtbeleg.** Tab erreicht die Dateiauswahl. Eingabe- und
      Leertaste öffnen den Dateidialog. Bei einer fehlenden Pflichtbestätigung erscheint
      die Fehlermeldung vor dem Absendedialog.
      Chromium und Firefox (`form-recheck-normal.json`)
- [x] **Rechnungen · Positionsfelder.** Beschreibung, Menge, Einheit, Preis und USt-Satz
      passen auf das Handy. Bei 390 Pixeln bleiben 122 Pixel für den USt-Wert. Nummer und
      Datumsfelder der externen PDF-Rechnung stehen untereinander.
      Chromium und Firefox · Standardmodus (`form-recheck-normal.json`) · Chromium und Firefox
      · PDF-Modus (`form-recheck-external.json`)
- [x] **Workflow-Vorlagen · Aktionen.** „Starten“ öffnet den Dialog, Escape schließt ihn.
      „Bearbeiten“ öffnet die gewählte Vorlage. Alle vier Zeilenaktionen sind bei 390
      Pixeln erreichbar.
      Bildbeleg (`work-bilder/vorlage-aktionen.png`) · Chromium (`work-browser.json`)
- [x] **BWA · Plan gegen Hochrechnung.** Die Tabelle scrollt innerhalb der Karte bis zu
      den absoluten und prozentualen Abweichungen. Bei 390 Pixeln bleiben der 128 Pixel
      breite Positionskopf und die Prozentangabe gleichzeitig sichtbar. Die befüllten
      Planeditoren in Portal und Kanzlei passen ohne seitlichen Seitenüberlauf auch auf
      320 Pixel.
      Chromium und Firefox (`form-recheck-normal.json`)
- [x] **Wiedervorlagen · Berliner Kalendertag.** Kurz nach Berliner Mitternacht erhält das
      neue Ticket das Datum 21. November. Auch die verknüpfte Wiedervorlage wird vom
      Berliner Kalendertag aus berechnet. Der Testbrowser war auf Los Angeles eingestellt.
      Bildbeleg (`work-bilder/ticket-faellig.png`) · Chromium (`work-browser.json`)
- [x] **Workflow-Filter · Zurücksetzen.** „Mandantenfilter entfernen“ leert die Auswahl
      sowohl in der Adresse als auch im sichtbaren Suchfeld und behält die übrigen Filter
      bei.
      Bildbeleg (`work-bilder/workflows-mobil.png`) · Chromium (`work-browser.json`)
- [x] **Dashboard · Stammdaten-Anträge.** Die Kachel öffnet die zugänglichen offenen
      Anträge. Von dort lässt sich der konkrete Einzelantrag aufrufen.
      Bildbeleg (`work-bilder/dashboard-stammdaten-einzelantrag.png`) · Chromium
      (`work-browser.json`)
- [x] **Dashboard · Offene Anforderungen.** Zähler und Zielliste verwenden jetzt dieselbe
      Auswahl offener und in Bearbeitung befindlicher Anforderungen.
      Bildbeleg (`work-bilder/dashboard-anforderungen.png`) · Chromium (`work-browser.json`)
- [x] **Mandantenakte · Kopfaktionen.** Anforderung erstellen und Stammdaten bearbeiten
      sind auch bei 390 und 768 Pixeln erreichbar. Auf dem Handy lassen sich die
      Fachbereiche aufklappen.
      Chromium (`eigene-chromium.json`) · Firefox (`eigene-firefox.json`)
- [x] **Dokumente · Tastaturfokus.** Die Aktionsgruppe der fokussierten Zeile wird
      sichtbar. Die Tastatur erreicht die Aktion, ohne dass sich der Mauszeiger bewegt.
      Chromium (`eigene-chromium.json`) · Firefox (`eigene-firefox.json`)
- [x] **Erscheinungsbild · Logo-Uploads.** Tab erreicht die getrennt benannten Logos für
      die helle und dunkle Ansicht. Der Fokus ist sichtbar. Bei der Vollmacht öffnet die
      Leertaste die Dateiauswahl für das PDF.
      Chromium und Firefox · Standardmodus (`form-recheck-normal.json`) · Chromium und Firefox
      · PDF-Modus (`form-recheck-external.json`)
- [x] **Wiedervorlagen · Erwähnung.** Tab wechselt vom Textfeld zum Namensvorschlag. Enter
      übernimmt den Namen und bringt den Fokus in das Textfeld zurück.
      Bildbeleg (`work-bilder/ticket-mention.png`) · Chromium (`work-browser.json`)
- [x] **RSS-Reader · Hinzufügen.** Auch bei der kleinsten Widgetgröße 4 × 5 öffnet die
      Feedverwaltung als eigenständiger Dialog. Hinzufügen und Schließen sind erreichbar.
      Chromium (`eigene-chromium.json`) · Firefox (`eigene-firefox.json`)
- [x] **Workflows · Kennzahlentitel.** Bei 390 Pixeln bleiben alle Kennzahlentitel
      vollständig lesbar.
      Bildbeleg (`work-bilder/workflows-mobil.png`) · Chromium (`work-browser.json`)
- [x] **Audit-Log · Hash und Navigation.** Der komplette Hash bricht um. Älter oder Neuer
      öffnet den benachbarten Eintrag, ohne den Hauptbereich zu verbreitern.
      Chromium (`eigene-chromium.json`) · Firefox (`eigene-firefox.json`)
- [x] **Personalfragebogen · Einmal-Link.** Nach Einlösung öffnet sich der persönliche
      Fragebogen ohne Einladungskennung in der Adresszeile. Auch nach dem Neuladen bleiben
      die 22 Eingaben erreichbar und die Einstiegsaktion ausgeblendet.
      Chromium (`einladungen-recheck-Chromium.json`) · Firefox
      (`einladungen-recheck-Firefox.json`)
- [x] **GwG-Onboarding · Land.** Straße und Land erhalten eigene Zeilen. Postleitzahl und
      Ort stehen nebeneinander. Bei 390 Pixeln Breite ist die Länderauswahl 308 Pixel
      breit und zeigt „Deutschland“ vollständig. Geprüft wurden auch 320, 768 und 1440
      Pixel.
      Chromium (`einladungen-recheck-Chromium.json`) · Firefox
      (`einladungen-recheck-Firefox.json`)
- [x] **Tax-CMS · Tabellen.** Kontrollen, Risiken, Kalender, Feststellungen und
      Durchführungen scrollen lokal. Der Hauptbereich bleibt bei 390 Pixeln Breite.
      Chromium (`tcms-browser.json`)
- [x] **Dokumente und Mandantenpost · Seitenstruktur.** Der Dokumentenstart hat eine H1.
      Im Posteingang und in Nachrichtendetails gibt es je einen Hauptbereich.
      Chromium (`eigene-chromium.json`) · Firefox (`eigene-firefox.json`)

Im Repository liegen unter anderem die [Browserfälle zur Bedienung](../../apps/e2e/tests/13-accessible-display.spec.ts),
die [BWA-Prüfungen](../../apps/e2e/tests/21-bwa-basis-state.spec.ts) und die
[Ticketprüfungen](../../apps/e2e/tests/22-reminder-tickets.spec.ts).
