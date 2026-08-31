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

Die bestehende Storage-Lese-API adressiert Bucket und eindeutigen Objektschlüssel.
Zusätzlich werden Länge und SHA-256 gegen die gespeicherte Quellversion geprüft;
ein abweichendes Objekt wird abgewiesen, niemals stillschweigend verwendet.
Eine spätere Erweiterung um explizite Objectstore-Version-Reads wäre sinnvoll.

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

Die sechs Browser-E2E-Fälle in `apps/e2e/tests/16-identity-local.spec.ts` waren
erfolgreich: JPG, PNG, PDF mit zwei Seiten, Ausschnitt/Drehung, selektive
Feldübernahme ohne Überschreiben, Abbruch während Initialisierung sowie
unlesbare PDF und neuer manueller Versuch. Die Netzwerkbeobachtung im Test
erlaubte ausschließlich den lokalen Ursprung. Nach Start des Fixtures:

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
