# GwG-Erfassung, Kontrollliste und Steuerdaten

Stand: 31. August 2026. Implementierungsdokumentation, keine fachliche Freigabe.

Die Erweiterung führt getrennte steuerliche Stammdaten, das zusätzliche
Berufsträgermerkmal, zwei gleichwertige GwG-Erfassungswege, lokale OCR,
ausdrückliche Personenverbindungen und einen begrenzten XLSX-Export ein.
Die Auditansicht erhält abgeleitete Kategorien und eine gemeinsame Filterlogik
mit dem CSV-Export. Gespeicherte Auditereignisse werden nicht umgeschrieben.

## Fachregeln und Verträge

- `GWG-OCR-ASSIST-001`, `GWG-IDENTIFICATION-EVIDENCE-001` und
  `GWG-SELF-ONBOARDING-001`: Vorschläge auswählen, Daten speichern und
  Identitätsprüfung bestätigen sind getrennte Schritte. Vor-/Rückseite sind
  Ansichten einer unveränderten, sauberen Version; maximal zwei Originaldateien.
- `GWG-RISK-REVIEW-001`, `ACCESS-STAFF-PERMISSION-001`: neue Freigaben verlangen
  aktiven Mitarbeiter, Berufsträgermerkmal und Mandantenzuordnung. Historische
  Zuordnungen begründen lediglich die technische Übernahme des Merkmals.
- `TAX-MASTER-DATA-001`, `GWG-REVERIFICATION-VALIDITY-001`: Steuerverbindungen
  sind der einzige schreibbare Steuernummernbestand. USt-ID bleibt am Mandanten,
  ist aber nicht Teil neuer GwG-Projektionen oder GwG-Änderungsauslöser.
- `GWG-PERSON-LINKS-001`, `GWG-CONTROL-EXPORT-001`: ausschließlich zugängliche
  Mandate vor Gruppenbildung filtern. Keine gemeinsamen editierbaren
  Personendaten. Keine automatische Namens- oder Ausweisnummernverknüpfung.
- `GWG-RETENTION-DESTRUCTION-001`, `DSGVO-MANDATE-ANONYMIZATION-001`:
  neue Verbindungen besitzen Lösch-/Anonymisierungspfade; steuerliche historische
  Abrufnachweise behalten ihren bestehenden gesonderten Aufbewahrungspfad.
- `AUDIT-HASH-CHAIN-001`, `AUDIT-VERIFY-ALERT-001`: Kategorien und Sortierung
  betreffen nur die Sicht; ein vorhandener Checkpoint beschönigt keine neuen
  Fehler. Weitergehende bestehende Recovery-Lücken stehen in der Auditregel.

Alle neuen Regeln sind ungeprüfte Entwürfe. Kein Review-Metadatum wurde als
menschliche Freigabe ergänzt.

## Koordinierter Versionswechsel

Kein Rolling Deployment mit parallel schreibenden alten Prozessen. Vor dem
Einsatz Backup erstellen und Wiederherstellbarkeit organisatorisch prüfen.

1. Alte Web-/Worker-Schreibprozesse im Wartungsfenster anhalten.
2. Neues Artefakt mit den vier Migrationen vom 31. August 2026 bereitstellen;
   Migrationen über den bestehenden Deployment-Runner ausführen.
3. Backfill prüfen: alte Steuernummer unverändert als Standard übernommen,
   kein Finanzamt oder Zweck geraten; bestehende ausdrücklich zugeordnete
   Berufsträger mit Herkunft `legacy`; Personen zunächst mandatsgetrennt.
4. Widerrufene offene Einladungen stehen mit Migrationsgrund zur manuellen
   Neuausstellung bereit. Der SQL-Schritt speichert Auditmarker. Vor erneuter
   Freigabe der Schreibprozesse diese Marker über den regulären Hashketten-
   Writer protokollieren. Zuerst ohne `--apply` prüfen:

   ```sh
   pnpm --filter @taxtronik/web exec tsx --env-file-if-exists=../../.env src/server/gwg-onboarding/migrate-invite-v2-audit.ts
   pnpm --filter @taxtronik/web exec tsx --env-file-if-exists=../../.env src/server/gwg-onboarding/migrate-invite-v2-audit.ts --apply
   ```

   Der Vorgang ist wiederholbar und sendet keine E-Mail. Die Protokollierung
   benennt ihren tatsächlichen Zeitpunkt nach der Migration, statt einen
   historischen Auditzeitpunkt zu erfinden.

5. Neue Prozesse gemeinsam starten. Alte Freigabeformulare müssen neu geladen
   werden. Laufende `IN_REVIEW`-Prüfungen bleiben eingereicht; die neue Fassung
   erfordert eine ausdrückliche Bestätigung. Alte Freigabehashes bleiben erhalten.
6. Offene Einladungen bei Bedarf bewusst neu ausstellen. Bereits eingereichte
   Daten, Rechnungen und Ausweisoriginale bleiben erhalten. Alte ELSTER-Abrufe
   erhalten keine nachträglich erfundene Steuerverbindungszuordnung.

Die Migrationen und der Auditmarker-Writer wurden nicht gegen die bestehende
Arbeitsdatenbank ausgeführt. Die Tests verwenden isolierte synthetische Daten.

## Lokale OCR und Originale

`pnpm --filter @taxtronik/web identity:assets` kopiert Tesseract-Worker, alle
benötigten WASM-Kerne, deutsche/englische Sprachmodelle und die PDF-Runtime aus
den installierten, im Lockfile gebundenen Paketen nach `public/identity-assets`.
`dev` und `build` führen diesen Schritt automatisch aus. Der Docker-Build
führt ihn ebenfalls ausdrücklich vor seinem direkten Next-Aufruf aus und
kopiert `public` vollständig in das Runtime-Image. Dieser Ordner muss
auch bei anderen Deployments wie die übrigen öffentlichen Dateien enthalten sein. Er ist
generiert und wird nicht eingecheckt. Die
[Tesseract-Dokumentation](https://github.com/naptha/tesseract.js/blob/master/docs/local-installation.md)
beschreibt die lokalen Worker-, Core- und Sprachpfade.

Die Anwendung sendet keine Ausweise an externe OCR-Dienste. Verarbeitete Bilder
und Rohtext bleiben im Browser-Arbeitsspeicher. Der Server erhält ausschließlich
normale Originaluploads, gewählte Seitenverweise und bewusst übernommene
strukturierte Felder. Die CSP erlaubt WASM nur auf den eigenen Assetantworten,
nicht globales JavaScript-eval. Ein kurzlebiger übergeordneter Worker beendet
die Erkennung auch während der Initialisierung. PDFs werden lokal gerendert.

Vor der Erkennung entsteht eine Arbeitskopie im Browser: kleine Aufnahmen
werden auf etwa 2000 px vergrößert (höchstens doppelt, Pixelgrenze wie beim
Rendern), in Graustufen gewandelt und auf das 1.–99. Perzentil kontrastgestreckt.
Original und gespeicherter Ausschnitt bleiben unverändert. Der Parser
(`identity-ocr.ts`) kennt das Layout des aktuellen Personalausweises
(„[a]“/„[b]“-Marker, dreisprachige und zweispaltige Beschriftungen) und entfernt
Störzeichen am Rand der Werte. Die maschinenlesbare Zone (`identity-mrz.ts`,
ICAO 9303 TD1) wird an festen Positionen gelesen; als K, L oder S gelesene
Füllzeichen stören nicht, Ziffernfelder werden auf Ziffern abgebildet, und
T/7 bzw. Z/2 in der Ausweisnummer werden nur korrigiert, wenn genau eine Lesart
Einzel- und Gesamtprüfziffer erfüllt. Die Erfassung gleicht die gesicherte Zone
der Rückseite mit den Angaben der Vorderseite bzw. bereits übernommenen Werten ab
und warnt bei Widerspruch. Ein zweiter, auf die Zone beschränkter
OCR-Durchlauf wurde mit dem Muster erprobt und verworfen: im Browser las er die
Zone schlechter als der erste Durchlauf nach der Kontraststreckung.

Die Erfassung kennt zwei Zielgruppen (`audience`): Die Kanzlei sieht die
fachlichen Hinweise, Mandanten im öffentlichen Wizard verständliche Fassungen
derselben Hinweis-Codes (`identity-hints.ts`), Daten als TT.MM.JJJJ und unter
„Bitte selbst eintragen“ nur noch leere Felder. In beiden Fassungen steht der
Ausweisausschnitt neben den Vorschlägen. Übernommene Felder markiert der Wizard
grün mit „Aus dem Ausweis übernommen – bitte prüfen“ (per `aria-describedby`
zugeordnet), scrollt zum ersten und hebt die Markierung je Feld bei eigener
Bearbeitung auf. Eine weitere Übernahme (die andere Ausweisseite) ergänzt die
Markierungen, statt frühere aufzuheben. Die Erfassung meldet die Übernahme zusätzlich in einer
Live-Region. Vorschläge bleiben einzeln anzuhaken. In Großbuchstaben gelesene
Namen, Orte, Straßen und Behörden schlägt die Hilfe in üblicher Schreibweise vor
(`identity-suggestions.ts`); die Ausweisfassung steht als Beschreibung der
Auswahl daneben, Umlaute und ß werden nicht ergänzt. Entspricht eine bisherige
Angabe dem Vorschlag bis auf Groß-/Kleinschreibung oder von der Erkennung
verlorene Umlaute (Köln ↔ KOLN, Heidestraße ↔ HEIDESTRASSE, DE ↔ DEUTSCH), wird
sie nicht zum Ersetzen angeboten, sondern als passend genannt; der Hinweis auf
die Schreibweise des aus der Rückseite gelesenen Namens entfällt dann. Im Fixture lässt sich die
Zielgruppe umschalten. Ein vollständiger Durchlauf des Wizards im lokalen
Dev-Stack setzt vollständige Datenschutzhinweise der Kanzlei voraus; sonst
zeigt der Wizard „Das Onboarding ist noch nicht freigegeben“.

Im Personenschritt des Wizards (`person-steps.tsx`) steht zuerst eine Übersicht
aller Personen mit dem Stand je Abschnitt; bearbeitet wird eine Person nach der
anderen: wirtschaftlich Berechtigte in Ausweis → Angaben → Beteiligung und PEP,
Vertretungen in Rolle → Ausweis → Angaben (bei der Doppelrolle nur die Rolle).
Der Name steht über den Abschnitten, damit Uploads dem Personenordner zugeordnet
werden und eine übernommene Schreibweise in jedem Abschnitt sichtbar bleibt.
Solange eine Person offen ist, ruht die Schrittnavigation des Wizards. Aus der
Zusammenfassung lassen sich vergessene Personen ergänzen; „Weiter zur
Zusammenfassung“ prüft danach den Personenschritt und springt direkt zurück.
Beim Weiter listet `onboardingPersonIssues` alle offenen Angaben je Person in
Alltagssprache mit Sprung in den Abschnitt der ersten Lücke; im Abschnitt steht
„Hier fehlt noch: …“. Upload-Felder zeigen ein Vorschaubild (Objekt-URL der
gewählten Datei) und bieten auf Touch-Geräten „Foto aufnehmen“ (`capture`,
JPG); die Dateiauswahl nimmt kein HEIC mehr an, damit iPhones JPG liefern.
„Seiten tauschen“ vertauscht Dateien und Seitenverweise. Bis zum Übermitteln
fragt der Browser beim Verlassen nach (`beforeunload`). Land und
Staatsangehörigkeit sind Auswahlfelder (`lib/countries.ts`, statische deutsche
Namen zu ISO-Codes, damit Server und Browser gleich rendern); mehrere
Staatsangehörigkeiten werden als „DE, TR“ gespeichert. Die Ausweishilfe schlägt
DEUTSCH als DE vor und ergänzt das zweistellige Ausstellungsjahr nur, wenn es
eindeutig ist (`completeIssueYear`). Mandanten
lesen jede Seite mit „Vorderseite auslesen“ bzw. „Rückseite auslesen“ aus
(`sideSources`); Original, Ausweisseite, PDF-Seite, Drehung und Ausschnitt liegen
eingeklappt unter „Ausschnitt anpassen“. Die Kanzlei behält die bisherige,
ausgeklappte Erfassung. Auf schmalen Bildschirmen nennt die Fortschrittsleiste
nur den aktuellen Schritt („Schritt 2 von 5: …“); vorher ragte sie bei 375 px
über den Rand.

Ergebnis mit dem veröffentlichten Musterausweis (Erika Mustermann) im echten
Browserablauf, 2026-10-22: vorher ein falsches Ablaufdatum (07.05. statt
01.05.2034) sowie PLZ/Ort; danach Name und Ablaufdatum von der Vorderseite und
Behörde, PLZ, Ort (ohne Umlaut), Ausweisnummer, Staatsangehörigkeit und Name
von der Rückseite, ohne Widerspruch im Abgleich. Geburtsdatum und -ort liegen
beim Muster unter dem Stempel „MUSTER“. Reale Scans sind davon getrennt zu
prüfen; eine Erkennungsquote wird nicht zugesagt.

Vollständiger Mandantendurchlauf im lokalen Dev-Stack, 2026-10-22 (Dev-Kanzlei
mit als Testdaten gekennzeichneten Datenschutzangaben, Einladung aus der
Mandantenakte, Musterausweis als zwei Bilder): Nach beiden Seiten waren sieben
Felder übernommen und grün markiert (Name, Staatsangehörigkeit, PLZ, Ort,
Ausweisnummer, Behörde, Gültig bis). Geburtsdatum, Geburtsort, Straße und
Ausstellungsdatum blieben selbst einzutragen. Vor der Korrektur hob die
Übernahme der Rückseite die Markierung von „Gültig bis“ auf. Mit angepasster
Schreibweise (gleicher Tag, erneuter Durchlauf): Der Name aus der Einladung
(„Erika Mustermann“) und die vorbelegte Staatsangehörigkeit DE galten als
passend und blieben unverändert; angeboten und übernommen wurden Gültig bis
(Vorderseite) sowie Behörde „Stadt Koln“, Ausweisnummer, PLZ und Ort „Koln“
mit Hinweis auf die Ausweisfassung (Rückseite), fünf Felder grün markiert.

Die bestehende Storage-Lese-API adressiert Bucket und eindeutigen Objektschlüssel.
Zusätzlich werden Länge und SHA-256 gegen die gespeicherte Quellversion geprüft;
ein abweichendes Objekt wird abgewiesen, niemals stillschweigend verwendet.
Eine spätere Erweiterung um explizite Objectstore-Version-Reads wäre sinnvoll.

Die Seitenzahl einer PDF-Ausweisquelle wird beim Upload (Staff-Upload, neue
Version, Onboarding sowie alle wiederaufnehmbaren Uploads, darunter die
Übernahme von Portal-Posteingangsanlagen und Mailbox-Anhängen mit
GwG-Dokumenttyp) einmalig aus genau diesen Bytes im begrenzten Worker-Thread
gezählt und an der Dokumentversion gespeichert
(`document_version.pdf_page_count`, P-13). Die Ausschnittsprüfung unter
Lifecycle-Lock liest deshalb keine Bytes mehr. Für Versionen ohne gespeicherten
Wert (Altbestand, nachträglich als GwG-Beleg eingestufte Dokumente) zählt der
nächtliche Worker-Job `pdf-page-count-backfill` nach: nur die neueste Version
nicht zugeordneter GwG-PDFs, mit Längen- und Hashprüfung, demselben Programm und
denselben Grenzen (`@taxtronik/mail/pdf-page-count`), in Stapeln unter der
App-Rolle bis zum Zeitbudget der Wartungsjobs; gezählte und nicht lesbare
Versionen erhalten `pdf_page_count_checked_at`. Versionen zugeordneter Belege
sperrt der GwG-Trigger gegen jede Änderung; für sie und alles noch nicht
Nachgetragene zählt die Aktion vor der Transaktion (Download, Längen- und
Hashprüfung, Worker-Thread); die Transaktion vergleicht nur Version-ID und
SHA-256. Eine PDF, die die Grenzen des Worker-Threads überschreitet, gilt als
nicht lesbar.

## Tests und Grenzen

Unit-/Action-/Route-Tests decken alle 16 Länderformate, Revisionen, Freigaberechte,
abgelaufene und fremde Einladungen, OCR-Vorschläge, Quellversionen, PDF-Deduplizierung,
Save/Confirm-Trennung, Personengraphen, XLSX-Textzellen und Auditfilter ab.
Die DB-Tests benötigen eine vollständig migrierte isolierte Testdatenbank.
Ein lokaler PostgreSQL-18.4-Lauf hat den Stand vor den vier neuen Migrationen
mit synthetischer Steuernummer, bereits anonymisiertem Legacy-Mandanten und
offener v1-Einladung aufgebaut und anschließend erfolgreich aktualisiert.
Geprüft wurden unveränderter Nummernbackfill als Standard, Entfernung des
anonymisierten Legacy-Werts, sichtbarer Einladungswiderruf und Auditmarker.
Der Nachweis-CLI schrieb dort ein SYSTEM-Ereignis; die Wiederholung schrieb
keines. Sieben echte DB-Tests zu Steuerverbindungs-Constraints, Portal-/Staff-RLS,
Mandantenbindung der ELSTER-Historie, redigierten Archivzeilen und
Personenankergrenzen waren erfolgreich. Rollenpasswörter und bestehende
Arbeitsdatenbank blieben unverändert.

Eine zusätzliche Upgrade-Probe führte einen synthetischen Altcheck durch die
bestehenden DB-Gates bis `VERIFIED` und verglich nach Migration alle bisherigen
Felder von Prüfung, Personen, Ausweis, Dokument und Version unverändert. Nur
technische Personenanker und leere Ansichtsmetadaten kamen hinzu;
Schutztrigger blieben aktiv. Auf dem frisch migrierten Stand waren alle 185
Migrationschecksummen konsistent, der Prisma-Schemavergleich leer und alle 96
erfassten Tabellen mit ENABLE/FORCE RLS samt Policies geschützt. Die neue
Cutover-Auditkette war intern konsistent; für ihr einzelnes Ereignis wurde
kein externer Zeitanker behauptet.
Die abschließende vollständige Datenbankregression bestand mit 283 Tests in
42 Dateien, einschließlich des zentralen Tenant-/Client-Paartrigger-Nachweises
für die beiden neuen mandantengebundenen Tabellen.

Vier PostgreSQL-Racetests laden den tatsächlichen Reviewer-Helper:
Qualifikationsentzug, Zuordnungsentzug und Entfernen der letzten Staff-Rolle
warten nachweislich auf die laufende Entscheidungstransaktion. Ein früher
gestarteter Entzug blockiert die Prüfung bis zum Commit und führt anschließend
zur Ablehnung der Berechtigung. Die Tests beobachten PostgreSQL-Blocker und
erzeugen keine GwG-Freigaben.

Formatvalidierung bestätigt nicht, dass eine Steuernummer tatsächlich vergeben
wurde; die Grundlage ist die
[veröffentlichte ELSTER-Ländertabelle](https://www.elster.de/eportal/helpGlobal?themaGlobal=wo_ist_meine_steuernummer).

Ein reproduzierbarer lokaler Browser-Fixture mit ausschließlich synthetischen
Angaben steht über `node apps/web/scripts/identity-smoke-server.mjs` auf
`http://localhost:4319` bereit. Er lädt die echte gemeinsame Erfassungskomponente
unter einer CSP mit ausschließlich lokalen Quellen. Er testet die OCR-/PDF-
Runtime ohne Schreibzugriff auf Kanzleidaten. Ein fachlicher Test mit geeigneten
realen Nachweisen und die organisatorische Freigabe bleiben davon getrennt.

Die sieben Browser-E2E-Fälle in `apps/e2e/tests/16-identity-local.spec.ts` waren
erfolgreich (zuletzt 2026-10-22 lokal unter Windows/Chromium): JPG, PNG, PDF mit
zwei Seiten, eine synthetische Rückseite mit MRZ (Nummer über Prüfziffer,
Staatsangehörigkeit, Behörde, kein geratenes Jahrhundert), Ausschnitt/Drehung,
selektive Feldübernahme ohne Überschreiben, Abbruch während Initialisierung
sowie unlesbare PDF und neuer manueller Versuch. Die Netzwerkbeobachtung im Test
erlaubte ausschließlich den lokalen Ursprung. Für lokale Proben mit eigenen
Dateien (etwa dem veröffentlichten Muster) bietet der Fixture zusätzlich
„Eigene Testdatei (nur lokal)“; die Datei bleibt im Browser. Nach Start des
Fixtures:

```powershell
$env:E2E_IDENTITY_FIXTURE_URL = 'http://localhost:4319'
pnpm --filter @taxtronik/e2e exec playwright test tests/16-identity-local.spec.ts
```

Die abschließende Websuite bestand mit 2.367 Tests in 331 Dateien; die übrigen
Workspace-Pakettests waren ebenfalls erfolgreich. Ein synthetischer Export des
produktiven XLSX-Writers ließ sich zusätzlich mit openpyxl ohne Warnung öffnen:
beide Blattnamen, gemeinsame Kennungen, Textnummern, Formelsicherheit und Filter
wurden unabhängig geprüft. Das ersetzt keinen separaten Abnahmelauf in Microsoft Excel.

Workspace-Typecheck und Produktionsbuild waren erfolgreich. Für den Build
wurden kurzlebige synthetische Secrets und Beispielhosts nur im Buildprozess
gesetzt; die vorhandene Entwicklungsdatei `.env` und ihre Zugangsdaten blieben
unverändert. Der generierte Stand ist damit ein Buildnachweis, keine deployte
Installation. Die Produktionskonfiguration muss beim tatsächlichen Deployment
weiterhin die bestehenden Sicherheitsprüfungen erfüllen.

Nicht enthalten: Scanneranbindung, DATEV-Synchronisation, zentrale gemeinsame
Personenstammdaten, automatische Finanzamtzuständigkeit oder vollständige
Prüfaktenexporte. Mehr als 10.000 XLSX-Detailzeilen werden ausdrücklich
abgewiesen, statt Daten still zu kürzen.

## Staff-Einzelprüfung: Darstellung und aktueller Zustand

Die Route `clients/[id]/gwg/page.tsx` übernimmt Authentifizierung, Mandantenauswahl
und Abschnittsreihenfolge. `gwg-page-data.ts` lädt den bestehenden Snapshot,
Historie, saubere Nachweisoptionen, Einladungen und Kontakte im Tenantkontext;
der gemeinsame Berufsträger-Helper bestimmt die sichtbare Freigabemöglichkeit.

`gwg-page-model.ts` projiziert ausschließlich die Anzeige: gespeicherte
Personen-Fremdschlüssel, Dokumentset-IDs und unveränderte Rohdaten für CAS bleiben
maßgeblich. Übersicht, Einladung, Personen, Nachweise, Risikobewertung/Entscheidung
und Status besitzen eigene Darstellungsbausteine. Die zuvor ungenutzte
Upload-Zusammenfassung samt zusätzlichem Dokumentabruf entfällt.

Nach `GWG-REVERIFICATION-VALIDITY-001` zeigt eine bereits erreichte Gültigkeitsgrenze
auch vor dem Worker-Lauf keinen Freigabebanner oder Onboarding-Fortsetzungslink.
Kopfstatus, Fortschritt und Statusbereich verwenden denselben Anzeigezeitpunkt.
Nach `GWG-RETENTION-DESTRUCTION-001` bleibt ein vernichtetes Prüfskelett ausdrücklich
Historie: keine rekonstruierten Personen-/Nachweisdetails und keine Einladungs-,
Risiko- oder Entscheidungsformulare. Der bestehende neue Zyklus bei terminalem
Status übernimmt weiterhin keine Daten einer vernichteten Quelle.

`page-render.test.tsx` rendert die echten synchronen Seiten-/Formkomponenten;
Serveraktionen, Tenantzugriffe und das separate asynchrone Strukturpanel sind
abgegrenzt. Nachweise betreffen Gültigkeit/Vernichtung, Abschnittsreihenfolge,
explizite Vertreter-/WB-Verknüpfung, ersetzte/gesperrte Nachweise, unveränderte
CAS-Revisionen und Freigabehashes sowie die frische Berufsträgerzuordnung
(`GWG-IDENTIFICATION-EVIDENCE-001`, `GWG-BENEFICIAL-OWNERS-001`,
`GWG-REPRESENTATIVE-AUTHORITY-001`, `GWG-RISK-REVIEW-001`,
`GWG-SELF-ONBOARDING-001`). Die bisherigen Quelltextprüfungen der Seitenstruktur
werden durch diese Rendernachweise ersetzt. Entscheidungsaktionen,
Aktivierungsgates, Auditbelege und professionelle Freigabefelder ändern sich nicht.
