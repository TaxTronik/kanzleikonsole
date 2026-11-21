# CI-Nachprüfung für Formulare und Berliner Tagesgrenzen vom 21. November 2026

## Ausgangspunkt

Die frühere Ticketprüfung leerte das Fälligkeitsfeld vor dem Ablesen. Der
mobile Rechnungsbefund war in einem lokalen Bildbericht belegt. Ein grüner
Standardbrowserlauf konnte deshalb einen falschen Vorschlag oder ein
unbedienbares Feld in einem anderen Browser übersehen.
[Visuelle Checkliste mit 23 Befunden](2026-11-21-ui-nachpruefung.md) ·
[Nachprüfung der Berliner Tagesgrenze](2026-11-21-berliner-kalendertag.md)

Der vollständige Browserjob für den vorherigen Commit `9fc9a287` bestand
247 Fälle. Im selben Quality-Lauf überschritt ein Archivtest beim ersten Import
des Evidence-Pakets die 20-Sekunden-Grenze. Der Unit-Job brach ab, während
die Websuite noch lief. [Forgejo-Lauf 1283](https://git.hirschmann-koxha.de/TaxTronik/kanzleikonsole/actions/runs/1283)

## Übernommene Prüfpunkte

- [x] **Kalender, Portal und Anforderungsvorlagen.** Sieben Bedienfälle lesen
      die erste Vorbelegung und kontrollieren die Werte beim Absenden.
      Sie umfassen den Berliner Tageswechsel sowie Wochen, in denen Berlin und
      New York an unterschiedlichen Tagen die Uhren umstellen. Gegen den alten
      Stand `8966e602` scheiterten alle sieben Fälle in zwei Chromium-Zeitzonen.
      [Browserfälle mit Sollwerten](../../apps/e2e/tests/ui/berlin-form-defaults.spec.ts)
- [x] **Beide Rechnungsmasken.** Bei 390 Pixeln hatte die Umsatzsteuer im
      historischen Formular keinen Platz für den Wert. In der PDF-Rechnung
      lag das Datum neben der Nummer im zu schmalen Raster. Alle vier
      Gegenproben auf `8966e602` scheiterten in Chromium und Firefox. Der neue
      Test prüft Geometrie, Tastaturbedienung und die eingegebenen Werte an der
      Serveraktion einschließlich der gewählten PDF-Datei.
      [Bedienprüfung der Rechnungen](../../apps/e2e/tests/ui/invoice-form-layout.spec.ts)
- [x] **Neue Kalenderfelder.** Das Root-Lint meldet eine aktuelle UTC-Vorgabe
      auch in einer neu angelegten Komponente und wenn eine lokale Variable
      den Wert weiterreicht. Auf den ursprünglichen Quellen schlugen die
      Prüfungen für Ticketanlage, Telefonnotiz und beide BWA-Planungsseiten an.
      Gegenproben erlauben gespeicherte DATE-Werte und technische Zeitstempel.
      [Regeltests gegen die echte ESLint-Konfiguration](../../apps/web/src/__tests__/berlin-calendar-lint.test.ts)
- [x] **Zusätzlicher CI-Job.** Die neun neuen Bedienfälle bestanden lokal
      auf jedem der vier Profile. Sowohl unter Windows als auch im frischen
      Linux-Checkout bestanden jeweils alle 36 Prüfungen. Die Tests verwenden
      echte UI-Komponenten und erfassen übermittelte Formulardaten. Bei den
      Rechnungsmasken wird das Stylesheet aus den aktuellen Quellen gebaut.
      Die vollständige Browsersuite nimmt dieselben Specs automatisch auf.
      Der Guard prüft zusätzlich die Testerkennung sowie Browser, Fensterbreiten
      und Zeitzonen. [Browserkonfiguration](../../apps/e2e/playwright.ui.config.ts) ·
      [Ungefilterte Vollsuite und UI-Job](../../.forgejo/workflows/ci.yml)
- [x] **Browser-Cache in beiden Jobs.** Die frühere Cache-Aktion suchte unter
      `apps/e2e/`. Der echte pnpm-Aufruf installiert die Browserrevisionen im
      Repository-Root unter `.cache/ms-playwright/`. Gegen den alten Pfad
      schlug der Test für beide Jobs fehl. Er gleicht nun die vom Installer
      gemeldeten Verzeichnisse und die von Playwright beim Start aufgelösten
      Binärpfade mit der Cache-Konfiguration ab.
      [Cacheprüfung](../../scripts/tests/ci-caches.test.mjs)
- [x] **Abbruch der Unit-Suite in Lauf 1283.** Der Archivtest importiert
      die benötigten echten Hash- und Archivfunktionen direkt. Drei frische
      lokale Testprozesse benötigten für den gültigen Fall vor der Änderung
      237 bis 291 ms und danach jeweils weniger als 9 ms. Der Fall mit
      manipulierter Kette prüft weiterhin die Ablehnung vor dem Schreiben.
      Im CI-Job arbeiten bis zu zwei Pakete parallel mit jeweils bis zu vier
      Vitest-Prozessen. Bei einem Fehler führen unabhängige Pakete ihre Tests
      zu Ende. [Archivtest](../../apps/worker/src/jobs/__tests__/audit-rotate.test.ts)
- [x] **Weitere Tagesgrenzen.** Fünf neue Gegenproben schlugen auf der
      bisherigen Implementierung fehl. Nach der Korrektur bestanden alle 131
      Tests der sieben betroffenen Suiten. Die folgenden drei Einstiege haben
      eigene prüfbare Sollwerte.
  - Mit Beginn des Berliner Folgetags zeigen Personenübersicht und Detail den
    Ausweis als abgelaufen. Auch die Serveraktion weist eine Bestätigung dann
    zurück. [GwG-Anzeige](<../../apps/web/src/app/staff/(protected)/clients/[id]/gwg/__tests__/page-render.test.tsx>) ·
    [Bestätigung](<../../apps/web/src/app/staff/(protected)/clients/[id]/gwg/__tests__/actions.test.ts>)
  - Entwurf und Abgabe des Personalfragebogens erlauben den heutigen Berliner
    Tag als Geburtstag und weisen morgen zurück. Beide Grenzen sind im Sommer
    und im Winter geprüft. [Personalfragebogen](../../apps/web/src/server/payroll/__tests__/definition.test.ts)
  - Der Wandkalender für Abwesenheiten wechselt am Berliner Montag um 00:00
    auf die neue Woche. Eine offene Abwesenheit ist bis heute sichtbar. Der
    Test prüft die Anzeige unmittelbar vor und ab Mitternacht.
    [Abwesenheitskalender](<../../apps/web/src/app/staff/(protected)/absences/calendar/__tests__/page.test.tsx>)

## Reichweite und offene Punkte

Die übrigen visuellen Befunde behalten die Einzelbelege ihres ursprünglichen
Durchlaufs. Dieser Nachtrag prüft zwei Rechnungsmasken und drei zeitabhängige
Formularabläufe zusätzlich in beiden Browsern. Der vollständige Playwright-Job
führt alle versionierten E2E-Fälle gegen die gebaute Anwendung aus.

- [ ] Die Kanzlei muss für den Auswahlzeitraum beim Quantenlos entscheiden,
      wann ein lokal gemeinter Auswahltag beginnt.
- [ ] Der produktive Bestand gespeicherter Schutzfristen ist vor Freigabe mit
      den Akten abzugleichen. Die ursprüngliche Checkliste benennt die
      Zuständigkeit und den nächsten Schritt. [Offene fachliche Prüfungen](2026-11-21-berliner-kalendertag.md#bestehende-utc-konventionen-und-offene-punkte)
