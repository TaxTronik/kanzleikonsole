# Barrierefreiheit der TaxTronik-Weboberfläche

- **Dokumentstatus:** technische Ist-/Gap-Dokumentation
- **Stand:** 2026-08-30
- **Zielniveau:** WCAG 2.2, Konformitätsstufe AA
- **Geltungsbereich:** Weboberflächen für Mitarbeiter und Mandanten in
  `apps/web` sowie die zugehörigen statischen und browsergestützten Prüfungen

## 1. Aussage und klare Abgrenzung

TaxTronik wird mit dem Ziel entwickelt, die Erfolgskriterien der WCAG 2.2 auf
Stufe AA zu erfüllen. Der aktuelle Quellcode enthält dafür gemeinsame
Komponenten, Design-Tokens und automatisierte Gates. Diese Dokumentation ist
jedoch **keine Erklärung vollständiger WCAG-Konformität, keine Zertifizierung
und kein Ergebnis einer unabhängigen Barrierefreiheitsprüfung**.

Ein bestandener Lint-, Komponenten- oder Axe-Lauf beweist nur den jeweils
geprüften Ausschnitt. Vollkonformität würde zusätzlich die manuelle Prüfung
aller relevanten Seiten, Zustände, Inhalte und Bedienwege mit der festgelegten
Browser-/Assistive-Technology-Matrix erfordern. Ein erfolgreicher CI-Lauf ist
erst dann ein Release-Nachweis, wenn er an den konkreten Commit und das
Release-Artefakt gebunden wurde.

Nicht zum zugesicherten Geltungsbereich gehören die Barrierefreiheit von
hochgeladenen Dokumenten, Bildern, Kanzleilogos, frei verfassten
Artikelinhalten oder extern eingebetteten Diensten. Die Anwendung soll deren
Bedienung möglichst zugänglich machen, kann aber die Beschaffenheit dieser
Inhalte nicht allgemein garantieren.

## 2. Umgesetzter technischer Stand

| Ebene                        | Umgesetzter Stand                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Beleg und verbleibende Abgrenzung                                                                                                                                                                                                                                     |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dokumentstruktur             | Die Dokumentsprache ist Deutsch. Öffentliche und geschützte Layouts verwenden semantische Landmarks; Hauptnavigationen sind benannt. Staff- und Portal-Shell besitzen einen Skip-Link zu einem fokussierbaren Hauptinhalt; die aktive Navigation wird semantisch ausgewiesen.                                                                                                                                                                                                                                                                                         | Strukturtests decken die gemeinsamen Layouts ab. Eine fehlerfreie Überschriftenhierarchie jeder einzelnen Fachseite ist damit nicht bewiesen.                                                                                                                         |
| Formulare und Rückmeldungen  | Zahlreiche Formulare wurden mit `label`/`htmlFor`, Gruppenbeschriftungen, Hilfetextbeziehungen, `aria-invalid` sowie `alert`-/`status`-Live-Regions ergänzt. Dekorative Icons werden in den bearbeiteten Komponenten ausgeblendet.                                                                                                                                                                                                                                                                                                                                    | Die Änderungen betreffen die geprüften und bei der Überarbeitung auffälligen Formulare. Dynamisch selten erreichbare Validierungs- und Berechtigungszustände bleiben je Workflow zu prüfen.                                                                           |
| Tastatur und Fokus           | Der Skip-Link, sichtbare Fokusindikatoren, Dialog-Fokusfallen, Fokus-Rückgabe, Escape-Behandlung und Hintergrundisolierung mit `inert` sind zentral umgesetzt. Die mobile Navigation verwaltet Zustand, Initialfokus, Fokusfalle und Rückgabe.                                                                                                                                                                                                                                                                                                                        | Drag-and-drop, dichte Tabellen, Kalender und seltene Overlay-Kombinationen benötigen weiterhin eine manuelle Tastaturprüfung. Ein Fokusindikator allein belegt noch keine sinnvolle Fokusreihenfolge.                                                                 |
| Suche und dynamische Widgets | Die globale Suche bildet Combobox, Listbox, aktive Option, Trefferstatus und Tastatursteuerung semantisch ab. Native Elemente wie `details`/`summary` werden bevorzugt.                                                                                                                                                                                                                                                                                                                                                                                               | Das Verhalten wurde für die gemeinsame Suche abgesichert, nicht für jedes Autocomplete- oder Auswahlwidget im Produkt.                                                                                                                                                |
| Dialoge                      | Die zentrale Dialog-Infrastruktur benennt Dialoge, isoliert den Hintergrund, behandelt leere Dialoge, hält Tab-Fokus im Dialog und stellt den vorherigen Fokus wieder her. Eingabedialoge besitzen sichtbare Labels und angesagte Fehler.                                                                                                                                                                                                                                                                                                                             | Browser-/Screenreader-Unterschiede und ineinander verschachtelte oder asynchron ersetzte Dialoge bleiben manuell zu prüfen.                                                                                                                                           |
| Editoren                     | Wissensdatenbank und Subsumtion/TCMS besitzen benannte Toolbars, hörbare Toggle-Zustände, Pfeil-/Home-/End-Navigation, verständliche Modusumschalter und Live-Status für Uploads. Der editierbare Inhalt ist als mehrzeiliges Textfeld ausgezeichnet.                                                                                                                                                                                                                                                                                                                 | Frei gewählte Text- und Markerfarben können ungeeignete Kontraste erzeugen. Die Anwendung verhindert das derzeit nicht. Die tatsächliche Lesereihenfolge komplexer Artikel ist inhaltlich zu prüfen.                                                                  |
| Farben und Whitelabeling     | Semantische Farb-Tokens gelten für Light und Dark Mode. Für die exakte Kanzlei-Akzentfarbe wird automatisch schwarze oder weiße Schrift mit mindestens 4,5:1 gewählt. Wortmarken und Brand-Text erhalten getrennte, im Farbton erhaltene AA-Farben für helle und dunkle Flächen; der Fokusfarbton wird gegen beide Flächentypen mit mindestens 3:1 geprüft. Muted-/Informationstext ist auch auf vertieften Flächen auf mindestens 4,5:1 ausgelegt. Die Branding-Oberfläche erklärt die automatische Kontrastwahl. Windows-Kontrastmodus erhält einen System-Outline. | Die Berechnung gilt nur dort, wo die semantischen Tokens verwendet werden. Logos, Bilder, freie Rich-Text-Farben und nicht migrierte Sonderdarstellungen sind nicht automatisch abgesichert. Kontrast bei erzwungenen Browserfarben ist zusätzlich visuell zu prüfen. |
| Bewegung                     | Switches, Modern-UI-Animationen, Sidebar-Übergänge und animierte Zähler berücksichtigen `prefers-reduced-motion`.                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Für neu eingebrachte Animationen und Verhalten von Drittkomponenten bleibt eine Regression möglich; deshalb ist Reduced Motion Teil der manuellen Releaseprüfung.                                                                                                     |
| Reflow und Zielgrößen        | Geteilte Icon-Aktionen und Dialog-Schaltflächen wurden vergrößert. Die A11Y-E2E-Suite prüft ausgewählte Kernseiten bei 320 CSS-Pixeln auf horizontalen Dokument-Overflow.                                                                                                                                                                                                                                                                                                                                                                                             | Die Prüfung umfasst nicht jede Tabelle, jeden Editorzustand oder 400-Prozent-Zoom. Interne Scrollcontainer können zulässig sein und müssen auf Bedienbarkeit geprüft werden.                                                                                          |

### 2.1 Persönlicher barrierearmer Anzeigemodus

Unter **Konto → Benutzerprofil** (Mitarbeiter) beziehungsweise **Einstellungen**
(Mandantenportal) lässt sich „Barrierearmen Anzeigemodus aktivieren“ einschalten.
Der Wechsel wird automatisch gespeichert; ein fehlgeschlagener Speichervorgang
wird angesagt und die Anzeige fällt auf den gespeicherten Stand zurück. Der
Tastaturfokus bleibt dabei am Schalter. Ein erwarteter Profilschlüssel dient
ausschließlich als Vergleich mit der aktuellen Sitzung: Nach einem Profilwechsel
in einem anderen Tab darf eine alte Ansicht nicht das falsche Profil ändern.

Der Modus ergänzt größere Schrift, mehr Zeilenabstand, größere zentrale
Bedienelemente, stärkere neutrale Text-/Rahmenkontraste, deutlich markierte
Textlinks und Fokusrahmen. Er reduziert CSS-Bewegung und ersetzt transparente
Modern-UI-Flächen durch opake Flächen. Light/Dark und Klassik/Modern bleiben
separate Auswahlmöglichkeiten; der persönliche Modus hat bei den genannten
Lesehilfen Vorrang. Fachinhalte, Berechtigungen und fachliche Abläufe ändern
sich dadurch nicht.

Unter „Anzeige individuell anpassen“ sind Schriftgröße (100, 112,5 oder
125 Prozent), Zeilenabstand (1,5-, 1,6- oder 1,8-fach), Standard-/verstärkter
Kontrast und Bewegungsreduktion getrennt wählbar. Empfohlen sind 112,5 Prozent,
1,6-facher Abstand, verstärkter Kontrast und reduzierte Bewegung. Die Optionen
bleiben beim Ausschalten gespeichert; ein eigener Button stellt die
empfohlenen Werte wieder her. Betriebssystemseitiges Reduced Motion kann
damit nicht ausgeschaltet werden. Die Auswahl skaliert gemeinsame UI-Texte,
nicht pauschal jedes frei formatierte Pixelmaß in Dokumentinhalten.

Der Avatar bleibt auch in seiner vergrößerten 44-Pixel-Klickfläche zentriert.
Konto- und gemeinsame Aktionsmenüs begrenzen im Modus ihre Höhe auf den von
Radix ermittelten verfügbaren Bildschirmraum; lange Einträge umbrechen und
der Inhalt bleibt scrollbar. Die gemeinsamen Menüs sind nichtmodal: Die
übrige Seite wird nicht nur mit `aria-hidden` verborgen, während dort weiterhin
fokussierbare Elemente liegen. Tab und Umschalt+Tab verlassen das Menü in
der normalen Reihenfolge, Escape führt zum Auslöser zurück. Diese
Tastaturkorrektur gilt auch ohne persönlichen Anzeigemodus.

Die JavaScript-Hochzählanimation der Dashboard-Kennzahlen berücksichtigt
zusätzlich die Bewegungsoption des Profilmodus. Bei aktivierter Reduktion
wird sofort der Endwert angezeigt; eine laufende Animation wird beendet. Eine während der
Animation neu aktivierte OS-Bewegungsreduktion beendet sie ebenfalls.

Auf schmalen Ansichten bis 640 CSS-Pixeln wird das Dashboard im Lesemodus
einspaltig angezeigt; größere Texte sollen nicht in schmalen Kacheln abgeschnitten
werden. Das gespeicherte Raster wird dabei nicht überschrieben. Der
Dashboard-Bearbeitungsmodus bietet zusätzlich benannte Positions-/Größenfelder
und bei geringer Breite eine gestapelte Vorschau. Derselbe alternative
Bedienweg steht im Portal-Layouteditor der Administration zur Verfügung.
Er verwendet die bestehenden Grenzwerte und Speicherpfade. Kleinere mobile Außenabstände
schaffen zusätzlich Schreib- und Lesefläche. Nicht jede individuelle px-basierte
Schrift wird erfasst. Andere JavaScript-/Canvas-Animationen sind nicht durch
die CSS-Regeln pauschal abgedeckt; der Zähler besitzt dafür eine eigene
Implementierung und Abbruchtests.

Die Präferenz liegt als `accessibleDisplay` am jeweiligen `StaffUser` oder
`ClientContact` (Standard: aus). Server-Actions erlauben ausschließlich das
Ändern des angemeldeten, aktiven Profils. Portal-Kontakte derselben E-Mail
können unterschiedliche Einstellungen besitzen. Es gibt dafür keinen
gemeinsamen Cookie oder Local-Storage-Wert: Auch auf einem anderen Gerät gilt
nach Anmeldung der Datenbankstand. Der geschützte Layout-Baum liefert den
CSS-Marker bereits im Server-HTML; profilgebundene Provider verhindern die
Übernahme optimistischer Zustände beim Profilwechsel. Body-Portale werden
durch denselben CSS-Scope erfasst. Auf der ausgeloggten Loginseite ist kein
persönlicher Modus aktiv. Andere bereits geöffnete Tabs/Geräte übernehmen eine
Änderung spätestens beim erneuten Laden; eine Echtzeit-Synchronisierung ist
nicht zugesichert.

Die vier individuellen Optionen liegen an denselben Profilen in separaten
Spalten. Die Server-Actions akzeptieren ausschließlich benannte Werte und
ändern nur die angeforderten Spalten. Eine Schriftänderung überschreibt somit
keine gleichzeitig in einem anderen Tab gewählte Kontrastoption. Gleichzeitige
Änderungen derselben Option sind nicht als Konflikteditor serialisiert.

Das ist **keine getrennte, garantiert barrierefreie Produktversion** und kein
Ersatz für die Basismaßnahmen. Tastaturbedienung, Semantik, Screenreader-
Unterstützung und sichtbarer Fokus dürfen nicht vom Schalter abhängen.
Freie Rich-Text-Farben, Bilder, PDFs und komplexe Drittkomponenten werden durch
diesen Modus nicht automatisch korrigiert. Alle Zielgrößen und Reflow-Zustände
sämtlicher Fachseiten sind damit nicht nachgewiesen. CSS `:has()` setzt einen
aktuellen unterstützten Browser voraus. Die manuelle Prüfmatrix bleibt offen.

Technische Umsetzung:
[persönliche Anzeige](../../apps/web/src/components/accessible-display.tsx),
[Modus-Styles](../../apps/web/src/app/accessible-display.css) und
[Profilpersistenz](../../apps/web/src/server/actions/accessible-display.ts).

## 3. Automatisierte Schutzmechanismen

### 3.1 Statische Prüfung

[`eslint.config.mjs`](../../eslint.config.mjs) aktiviert für `apps/web` die
empfohlenen Regeln von `eslint-plugin-jsx-a11y`. Dadurch blockiert das normale
CI-Lint unter anderem neue, statisch erkennbare Fehler bei zugänglichen Namen,
Formularlabels, Rollen und Tastaturereignissen.

`jsx-a11y/no-autofocus` ist bewusst deaktiviert. Mehrstufige Login- und
Dialogabläufe setzen den Fokus gezielt; dieses Verhalten wird durch eigene
Fokus- und Strukturtests abgesichert. Diese Ausnahme ist keine allgemeine
Erlaubnis, beliebig `autoFocus` zu verwenden.

### 3.2 Komponenten- und Regressionstests

Quellcode- und Komponententests sichern insbesondere folgende gemeinsame
Grundlagen ab:

- Skip-Link, Hauptinhalt und Navigations-Landmarks;
- mobile Navigation mit `inert`, Dialogsemantik, Escape und Fokus-Rückgabe;
- Combobox-/Listbox-Semantik der globalen Suche;
- Dialogrollen, Fokusfalle, Hintergrundisolierung und Eingabelabels;
- wahrnehmbare Fokus- und Text-Tokens sowie Forced-Colors-Regeln;
- Editor-Toolbars, Toggle-Zustände und Upload-Meldungen;
- Auswahl der On-Brand-Schrift- und Fokusfarbe, einschließlich eines
  Property-Tests mit 1.000 erzeugten RGB-Markenfarben.

Diese Tests schützen konkrete Implementierungsverträge. Sie simulieren keinen
vollständigen Screenreader und ersetzen keine Bedienprüfung.

Zentrale technische Nachweise sind derzeit:

- die
  [globalen A11Y-Grundlagentests](../../apps/web/src/components/__tests__/accessibility-foundations.test.ts);
- der
  [Konsolidierungs- und Fokustest der Dialog-Infrastruktur](../../apps/web/src/components/ui/__tests__/modal-consolidation.test.ts);
- die
  [Property-Tests der Brand-Palette](../../apps/web/src/lib/__tests__/brand-palette.test.ts);
- die
  [Strukturtests des Wissensdatenbank-Editors](<../../apps/web/src/app/staff/(protected)/knowledge/__tests__/editor-structure.test.ts>);
- die
  [Strukturtests des Subsumtions-Editors](<../../apps/web/src/app/staff/(protected)/clients/[id]/subsumtion/__tests__/compose-editor-structure.test.ts>).

### 3.3 Axe und Playwright

[`apps/e2e/tests/12-accessibility.spec.ts`](../../apps/e2e/tests/12-accessibility.spec.ts)
führt Axe mit den Tags `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa` und
`wcag22aa` aus. Der gegenwärtige Browser-Scope umfasst:

- Staff- und Portal-Login;
- Staff-Dashboard, Mandantenliste, Dokumente, Anforderungen, Rechnungen,
  Kalender, Formulare, Workflows, Wissensdatenbank, Administration,
  Benutzerverwaltung, Einstellungen und eine datenbelegte GwG-Prüfung;
- Portal-Dashboard, Termine, Dokumente, Anforderungen, Rechnungen, Formulare,
  Einstellungen und Stammdaten;
- Staff-Login, Dashboard, Wissensdatenbank und Einstellungen im Dark Mode;
- Staff-Login, Dashboard und Wissensdatenbank bei 320 CSS-Pixeln;
- Tastaturverhalten des Skip-Links und der mobilen Navigation.

Erkannte Axe-Verstöße lassen den Test fehlschlagen. Die Verletzungsliste wird
je geprüfter Seite als JSON an den Playwright-Bericht angehängt. Der Test ist
in der paranoiden E2E-Suite des Forgejo-Workflows verdrahtet. Lokal kann er mit
`pnpm a11y:e2e` gegen einen laufenden, geseedeten Stack gestartet werden.

Die Verdrahtung des Gates ist noch kein Beleg, dass ein bestimmter Release-Lauf
erfolgreich war. Dafür ist der Playwright-Bericht des konkreten CI-Laufs
aufzubewahren und mit Commit beziehungsweise Release zu verbinden.

Die ergänzende
[Profilmodus-Suite](../../apps/e2e/tests/13-accessible-display.spec.ts) prüft
Tastaturaktivierung, Persistenz nach Reload und in einem neuen Browserkontext,
Trennung von Mitarbeiter- und Portalpräferenz sowie Light/Dark-Kontrast und
320-Pixel-Reflow an ausgewählten Seiten. Unit-Tests ergänzen Authentisierung,
Eingabevalidierung, profilgebundene Schreibfilter, Server-Rendering und
Farb-/CSS-Verträge. Tests verändern nur die Entwicklungsprofile und stellen
deren ursprüngliche Anzeigepräferenz anschließend wieder her.

Die Suite prüft außerdem die einzelnen Anzeigeoptionen nach Speicherung und
Server-Rendering, ihre Erhaltung beim Ausschalten, den Rücksetzbutton und
Fehler-Rollback mit Fokus-Erhalt. Die ergänzende
[Layout-Suite](../../apps/e2e/tests/14-dashboard-keyboard.spec.ts) deckt Dashboard
und Portal-Layouteditor einschließlich Tab-Erreichbarkeit bei 320 Pixeln ab.
Speicherrequests werden dort abgefangen; echte Layoutänderungen werden nicht
persistiert. Die
[Panel-Suite](../../apps/e2e/tests/15-search-notifications-a11y.spec.ts) prüft lange
Such-/Benachrichtigungslisten bei 320 × 240 Pixeln, lokale Scrollposition,
Tab/Home/End/Escape, nichtmodales Fokusverhalten und Toast-Lesezeiten mit
lokalen GET-Fixtures. Diese drei zusätzlichen Suiten sind ebenfalls im
paranoiden CI-Lauf verdrahtet.

Lokaler Nachweis vom 30. August 2026 für diesen Modus: 76 neue Unit-/SSR-/CSS-
Tests und alle drei Profilmodus-E2E bestanden. Geprüft wurden auch der
Speicherfehler mit Fokus-Erhalt, Modern-Ansicht in Light/Dark, Dokument- und
Hauptinhalt-Reflow sowie die einspaltigen Dashboard-Kacheln. Die sieben
Baseline-E2E bestanden ebenfalls im abschließenden Basislauf. Der gesamte
Web-Testlauf bestand mit 2.053 Tests; Typprüfung und RLS-Inventur waren grün.
ESLint meldete keine Fehler, jedoch weiterhin 167 bestehende Warnungen.
Dies sind lokale Entwicklungsnachweise, keine Release- oder Fachfreigabe.

Ergänzender Nachweis desselben Tages nach der Avatar-/Menü-/Zählerkorrektur:
Der vollständige Web-Testlauf bestand mit 2.090 Tests. Alle vier Profilmodus-
E2E bestanden, einschließlich Avatar-Zentrierung in Light/Dark und bei
320 CSS-Pixeln sowie des geöffneten Konto-Menüs bei 320 × 240 Pixeln in
Staff und Portal. Die neuen Menüprüfungen decken Axe, sichtbare letzte
Einträge, Home/Pfeiltasten, Escape mit Fokus-Rückgabe und Tab/Shift+Tab zu
den nativen Nachbarzielen ab; der Tab-Ausstieg wurde auch ohne Modus geprüft.
Die gemeinsamen Overflow-Aktionsmenüs sind über denselben Hook und
Strukturtests abgesichert, aber nicht jede einzelne Verwendung wurde im
Browser geöffnet.

Typprüfung einschließlich E2E-TypeScript, Dokumentationslinks und beide
Fachkatalog-Gates bestanden. Das Repository-Lint meldete keine Fehler und
166 weiterhin bestehende Warnungen.

Die Zählertests prüfen den echten Profil-Context beim Server-Rendering sowie
Animationsablauf, Abbruch, OS-Präferenzwechsel und Cleanup mit deterministischen
Frame-Fakes. Ein Live-Umschalten des React-Profilproviders mitten in einer
laufenden Zähleranimation wurde nicht als eigener Browsertest ausgeführt.
Auch dieser Nachweis ist keine vollständige manuelle A11Y-Abnahme.

## 4. Manueller Prüfumfang

Die Überarbeitung beruhte auf einer breiten Quellcodeprüfung der gemeinsamen
Shell, Formulare, Suche, Dialoge, Editoren und Farb-Tokens. Der oben benannte
Routensatz wurde am 30. August 2026 gegen den laufenden lokalen Dev-Stack mit
der vollständigen A11Y-E2E-Suite ohne Axe-Befund durchlaufen; auch Skip-Link,
mobile Navigation, Dark Mode und 320-Pixel-Stichproben bestanden. Dieser lokale
Lauf ist ein Entwicklungsnachweis, aber weder an ein Release-Artefakt gebunden
noch eine manuelle Prüfung. Es liegt weiterhin **kein versioniertes Protokoll
einer vollständigen Screenreader-/Browser-Matrix für alle authentifizierten
Workflows** vor.

Vor einer Barrierefreiheits- oder Releasefreigabe ist deshalb mindestens
folgende manuelle Matrix am konkreten Build auszuführen und zu protokollieren:

1. vollständige Tastaturbedienung mit Tab, Umschalt+Tab, Enter, Leertaste,
   Escape und den widgetbezogenen Pfeiltasten;
2. Fokusreihenfolge, jederzeit sichtbarer Fokus, Fokus-Rückgabe und Freiheit
   von Tastaturfallen;
3. NVDA mit einem unterstützten Chromium-Browser und Firefox; ergänzend
   VoiceOver mit Safari, sofern macOS/iOS zum zugesagten Plattformumfang
   gehört;
4. Light Mode, Dark Mode, `prefers-reduced-motion` und Windows
   Forced-Colors/High-Contrast;
5. Browserzoom bei 200 und 400 Prozent sowie Reflow bei 320 CSS-Pixeln ohne
   Verlust von Inhalt oder Bedienfunktion;
6. Validierungsfehler, Lade-, Speicher-, Upload- und Konfliktmeldungen sowie
   asynchrone Zustandswechsel;
7. Login, globale Navigation und Suche, GwG, Wissensdatenbank,
   Subsumtion/TCMS, Administration, Mandantenportal, Tabellen, Kalender,
   Datei-Uploads und destruktive Bestätigungen;
8. Whitelabel-Stichproben mit sehr hellen, sehr dunklen und hoch gesättigten
   Akzentfarben sowie realen Kanzleilogos;
9. Bedienung ohne präzise Zeigerbewegung, einschließlich Zielgrößen und
   Alternativen für Drag-and-drop beziehungsweise Resize-Funktionen.

Die konkrete Kombination aus Betriebssystem, Browser- und
Screenreader-Version, Testperson, Ergebnis, Abweichung und Entscheidung gehört
in den Release-Nachweis. Ein undokumentierter lokaler Smoke-Test reicht dafür
nicht aus.

## 5. Bekannte Grenzen und offene Arbeit

1. **Automatisierung ist unvollständig.** Axe und ESLint erkennen nur einen
   Teil der WCAG-Erfolgskriterien und können sinnvolle Namen, Lesereihenfolge,
   Verständlichkeit oder vollständige Tastaturbedienung nicht allgemein
   beurteilen.
2. **Der Axe-Routensatz ist repräsentativ, nicht vollständig.** Viele
   Detailseiten, seltene Rollen, leere/fehlerhafte Datenzustände und komplexe
   Workflowübergänge sind noch nicht automatisch abgedeckt.
3. **Die Screenreader-Matrix ist nicht releaseweit nachgewiesen.** NVDA,
   VoiceOver und verschiedene Browser können ARIA- und Fokusverhalten
   unterschiedlich ausgeben.
4. **Reflow ist nur punktuell automatisiert.** Dichte Tabellen, Kalender,
   Editoren und modale Kombinationen müssen bei Zoom und kleinen Viewports
   weiterhin manuell geprüft werden.
5. **Frei erstellte Inhalte können Barrieren enthalten.** Artikelautoren
   können ungeeignete Farbpaare, Überschriftenfolgen, Linktexte oder Bilder
   ohne aussagekräftige Alternativtexte einbringen. Hochgeladene PDFs und
   Office-Dateien werden nicht auf Dokumentbarrierefreiheit validiert.
6. **Drittkomponenten bleiben eine Abhängigkeit.** Insbesondere Kalender,
   Rich-Text-Editor und Browser-/Dateidialoge sind in den tatsächlich
   unterstützten Versionen und Plattformen zu prüfen.
7. **Komplexe Zeigerinteraktionen bleiben ein Prüffeld.** Dashboard und
   Portal-Layouteditor besitzen nun Alternativen für Position/Größe. Damit ist
   noch keine repositoryweite Tastaturäquivalenz aller Kalender-, Editor- und
   Drittkomponenten nachgewiesen.
8. **Es gibt keine unabhängige Zertifizierung.** Die vorhandenen Gates und
   diese Gap-Dokumentation sind interne Qualitätsmaßnahmen, kein externes
   Audit und keine rechtliche Konformitätsbescheinigung.

### 5.1 Erledigte Erweiterungen und verbleibende Arbeit

Die konkret identifizierten Erweiterungen des persönlichen Modus und der
gemeinsamen Bedienkomponenten sind umgesetzt. Ein allgemeines „Maximum“ ist
damit nicht nachgewiesen: Weitere Arbeit muss aus konkreten Bedienprüfungen
und Rückmeldungen entstehen. Basiskorrekturen bleiben unabhängig vom
Profil-Schalter verfügbar.

- **Erledigte Lesehilfen:** Benachrichtigungstitel und -texte sind im Modus
  vollständig lesbar; Zeitangaben wachsen mit. Such-/Benachrichtigungspanels
  bestimmen ihren verfügbaren Platz selbst. Toasts laufen im Modus nicht
  automatisch ab; in der Standardansicht pausiert die Frist bei Hover/Fokus
  und geöffnetem Feed. Dies ersetzt keine fachliche Fristenkontrolle.
- **Erledigte Basiskorrekturen:** Die globale Suche scrollt ihre aktive Option
  lokal ins Sichtfeld. Dashboard und Portal-Layouteditor besitzen eine
  Alternative zum Ziehen. Diese Änderungen gelten in beiden Anzeigevarianten.
- **Erledigte individuelle Präferenzen:** Schriftgröße, Zeilenabstand, Kontrast
  und Bewegung sind getrennt einstellbar; siehe Abschnitt 2.1.
- **Manueller Nachweis:** Screenreader, echter 200-/400-Prozent-Browserzoom,
  Forced Colors und komplexe Editor-/Dialogzustände bleiben nach der Matrix
  in Abschnitt 4 zu prüfen. Eine 320-Pixel-Stichprobe ersetzt diese Prüfung
  nicht.

Die Umsetzung dieser konkreten Punkte ist keine abschließende Bestandsaufnahme
aller Fachseiten. Frei gestaltete Inhalte, seltene Workflowzustände, verschachtelte
Overlays und Plattformunterschiede bleiben Teil der manuellen Prüfung.

## 6. Release-Gate und Pflege

Für einen Release mit Barrierefreiheitsanspruch sind mindestens erforderlich:

- erfolgreiches Repository-Lint einschließlich `eslint-plugin-jsx-a11y`;
- bestandene Komponenten- und A11Y-Regressionstests;
- bestandene Axe-/Playwright-Suite am gebauten Releasekandidaten;
- dokumentierte manuelle Prüfung der für den Release geänderten und
  risikobehafteten Bedienwege;
- keine ungeklärten kritischen Barrieren; akzeptierte Abweichungen benötigen
  Scope, Begründung, verantwortliche Person und geplanten Abbauzeitpunkt.

Neue Seiten und gemeinsame Komponenten sind in den passenden automatisierten
und manuellen Scope aufzunehmen. Änderungen an dieser Dokumentation beschreiben
den belegten Stand; sie dürfen weder einen fehlenden Test ersetzen noch eine
fachliche oder organisatorische Freigabe vortäuschen. Das übergreifende
Verfahren steht im [Test- und Abnahmekonzept](../development/testkonzept.md).
