# Belegassistenten und mandantenbezogene Verfahrensdokumentation

`CLIENT-ASSISTANCE-001` ergänzt `expenseAssistance` und `clientProcedures`. Einstieg: `/staff/client-assistance` bzw. `/portal/client-assistance`. Die Assistenten dokumentieren Bewirtungsergänzungen, Eigenbelege und vom Mandanten beschriebene Verfahren. Sie entscheiden nicht über Betriebsausgaben, Vorsteuerabzug, steuerliche Anerkennung oder GoBD-Konformität. Der installationsbezogene IST-Generator (`GOBD-VERFAHRENSDOKU-001`) bleibt getrennt.

## Bearbeitung und Prüfung

Neue Vorgänge kopieren die Felddefinition. DRAFT/RETURNED kann bearbeitet werden; Einreichung verlangt Pflichtangaben und Bestätigung. SUBMITTED/REVIEWED-Antworten bleiben unverändert, bis eine Korrektur angefordert wird. Jede Speicherung und Prüfentscheidung schreibt eine Revision mit Antworten, Schema, Original-/Word-Bindung, Status, Bestätigung, Prüfvermerk, Akteur und Zeit. Ein kanonischer SHA-256 bindet den vollständigen Snapshot. Trigger schützen die Historie vor UPDATE/DELETE. Alte Historie ohne vollständigen Snapshot wird nicht nachträglich als ausgabefähig dargestellt.

Prüfen und Zurückgeben sind Staff-Aktionen mit ausdrücklichem Vermerk und erwarteter Revision. Eine Anwendungsrolle beweist keine Berufsträgerqualifikation. Die vollständige gelebte Organisation, fehlende Nachweise und materielle Anerkennung bleiben einzeln zu prüfen.

## Gebundene Dokumente und Ausgaben

Original und externe Word-Fassung sind echte DocumentVersion-Fremdschlüssel, auch je Revision. Quellen müssen demselben Mandanten gehören, CLEAN mit abgeschlossenem Scan sein und dürfen nicht gelöscht, zur GwG-Vernichtung vorgesehen oder vernichtet sein. GwG-, Personal-, private und `requiresPayrollAccess`-Dokumente sind ausgeschlossen. Portalquellen benötigen aktuelle Freigabe. Diese Grenze verhindert, dass eine erzeugte Ergänzung eine Schutzklasse umgeht.

Ausgaben werden ausdrücklich über `persistResumableDocumentUpload` abgelegt; GET erzeugt keine Datei. `ClientAssistanceOutput` reserviert je Revision/Format/Generator genau einen Vorgang. Journal und Dokumentverknüpfung entstehen atomar, anschließend wird dieselbe Objektversion finalisiert. Nach mehrdeutigem Store-Erfolg wird derselbe PENDING-Intent fortgesetzt. PDF und erzeugtes DOCX verwenden feste Zeitstempel für identische Recovery-Bytes. Der Generator `client-assistance/1` muss bei Änderungen der Byte-Erzeugung erhöht werden.

Das Manifest bindet Fall, Revision, Snapshot, Generator, Format, Quellen, Dokumentfassung und Bytehash. Download prüft aktuellen Zugriff, Quellenfreigabe, Store-Version, Größe und SHA-256 erneut. Ausgaben verwenden GOBD_INVOICE (8 Jahre) bzw. GOBD_TAX (10 Jahre), technisch am Jahr der Fallrevision verankert. Diese Produktzuordnung ersetzt keine Rechts-/Fristentscheidung. Staff-Ausgaben bleiben bis zur ausdrücklichen Portal-Freigabe privat. Portalinitiierte Ausgaben eigener zugänglicher Angaben werden geteilt angelegt.

Bewirtungsergänzung und Original bleiben getrennt verfügbar. Optional entsteht aus PDF/JPEG/PNG-Original und Ergänzung eine kombinierte PDF-Ansicht. Der Originalblob bleibt unverändert. Grenzen: 25 MiB je gelesener Datei, 200 PDF-Originalseiten und das vorhandene Uploadlimit für die resultierende Ausgabe.

## Externer Word-Reimport

Bearbeitete DOCX zuerst im Dokumentbereich hochladen und prüfen, dann ausdrücklich als neue Fassung auswählen. Der Reimport schreibt eine neue SUBMITTED-Revision und entfernt die aktuelle alte Prüfentscheidung. Er überschreibt keine Strukturantworten mit automatisch extrahiertem Word-Text. Die Oberfläche kennzeichnet Word als vollständige externe Fassung und zeigt alte Strukturantworten nur in deren Historie.

Die externe DOCX-Ausgabe archiviert exakt die gebundenen Word-Bytes. Das PDF ist ausdrücklich ein Prüfprotokoll mit Hash und Vermerk, keine Word-Konvertierung und keine vollständige Darstellung des Word-Inhalts. Alte Freigaben werden nicht automatisch übernommen.

## Nachweise und Grenzen

Migrationen: `20260831140000_client_assistance` und `20260831170000_assistance_outputs`. Tests unter `apps/web/src/server/client-assistance/__tests__` prüfen Snapshotintegrität, gefrorene Felder, neue Word-Revisionen, erneute Prüfung, Quellen-/Portalgrenzen, Store-Version, Bytehash, Wiederaufnahme und echte PDF-/DOCX-Ausgabe. DB-Tests verwenden ausschließlich eine isolierte Datenbank mit realer App-Rolle.

Keine automatische Buchung, kein Versand und keine automatische Löschung der historischen Arbeitssnapshots. Ausgabedokumente unterliegen der bestehenden Dokumentablage; für Fallmetadaten wird keine neue allgemeine Retention-Engine behauptet.
