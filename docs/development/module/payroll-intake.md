# Personalfragebogen mit getrennten Zugängen

Fachkatalog: PAYROLL-INTAKE-001, DOC-UPLOAD-JOURNAL-001, DOC-VERSION-IMMUTABILITY-001, DOC-PORTAL-SHARING-001, DOC-RETENTION-CLASS-001.

Das standardmäßig deaktivierte Modul `payrollIntake` bereitet Mitarbeiterneuanlagen für DATEV Lohn und Gehalt vor. Die Kanzleioberfläche liegt unter `/staff/payroll`, der ausdrücklich berechtigte Arbeitgeberkontakt arbeitet unter `/portal/payroll`, die beschäftigte Person ausschließlich unter `/payroll/employee`. Das Modul erzeugt keinen allgemeinen Mandantenzugang.

## Abgabe und Prüfung

Die Kanzlei legt einen Einzelvorgang für ein aktives Mandat an und wählt den Arbeitgeberkontakt ausdrücklich aus. Beschäftigung und Vergütung werden von diesem Kontakt bestätigt. Kanzleimitarbeitende können diesen Teil vorbereiten, aber keine Arbeitgeberbestätigung ersetzen. Die beschäftigte Person bearbeitet und bestätigt ihre eigenen Stammdaten. Arbeitgeberkontakte sehen weder Arbeitnehmerantworten noch deren Anlagen, private Revisionen oder Kanzleiexporte.

Der bei Anlage gespeicherte Formularstand ist unveränderlich. Jede fachliche Änderung verlangt die aktuelle Revision; parallele veraltete Abgaben werden abgewiesen. `DRAFT` beziehungsweise `RETURNED` sind bearbeitbar, `SUBMITTED` verlangt beide Abgaben und `REVIEWED` zusätzlich die Kanzleiprüfung. Eine Rückgabe öffnet beide Teile erneut und verlangt neue Bestätigungen. Der gemeinsame Rückgabevermerk wird Arbeitgeber und Arbeitnehmer angezeigt und darf keine vertraulichen Arbeitnehmerdetails enthalten. Bestätigte DATEV-Zuordnungsnummern und dokumentierte externe Nachweise werden revisionsgebunden gespeichert; nachträgliche Änderungen eines geprüften Standes verlangen eine erneute Kanzleiprüfung.

## Zugriffsgrenzen

Kanzleizugriff verlangt `PAYROLL_MANAGE`, das Modul und aktuellen Mandatszugriff. Der Portalzugang verlangt zusätzlich eine aktive, vorgangsbezogene Arbeitgeberfreigabe. Weitere Kontakte desselben Mandanten erhalten dadurch keine Rechte. Ein Mandatsende, anonymisiertes oder deaktiviertes Mandat, Modulabschaltung, Ablauf oder Widerruf sperrt den Gastzugriff bei jeder Operation erneut.

Arbeitnehmerlinks enthalten ein zufälliges Einmalgeheimnis im URL-Fragment. Es wird vor der Einlösung aus der Adresszeile entfernt und nicht als Queryparameter versandt. Die Einlösung geschieht durch eine ausdrückliche POST-Aktion, nicht durch den Seitenaufruf. Gespeichert werden nur SHA-256-Hashes. Die daraus erzeugte, getrennte HttpOnly-/SameSite-Strict-Session gilt höchstens acht Stunden und nie länger als die Einladung. Eine neu ausgestellte Einladung widerruft vorherige Einladungen einschließlich der daran gebundenen Sessions. Ein empfangener Link ist ein Zugangsschlüssel, kein Identitätsnachweis; die Kanzlei organisiert seine vertrauliche, überprüfte Zustellung selbst. Die Anwendung versendet keine Einladung automatisch.

Gastoperationen verwenden weder eine `CLIENT_CONTACT`-Session noch einen `SYSTEM`-Akteur oder einen realen Tenantkontext. Sie laufen in einem leeren Sentinelkontext und können nur eng begrenzte `SECURITY DEFINER`-Funktionen aufrufen. Diese prüfen Geheimnis, Session, Einladung, Fachvorgang, Mandat und Modul jeweils neu. Private Hilfsfunktionen sind der App-Rolle entzogen. Generische Tenant-, Mandanten- oder Dokumentabfragen im Gastkontext liefern keine Daten.

## Anlagen und Prüfexporte

Lohnanlagen besitzen eigene Tabellen und Rechte; es werden keine allgemeinen `Document`-Einträge erzeugt. Arbeitgeber laden ausschließlich Arbeitgeberanlagen, Arbeitnehmer ausschließlich eigene Anlagen. Die Kanzlei kann mit Lohnberechtigung beide Seiten sehen. Zulässig sind PDF, PNG und JPEG bis 25 MiB je Datei, mit verpflichtender Malwareprüfung. Die technische Verarbeitung benutzt die vorhandenen Storage-Primitiven: vorbereiteter Hash und Speicherort, persistentes PENDING-Journal vor dem PUT, Versions-ID und SHA-256-Prüfung beim Commit und bei der Wiederaufnahme. Ein erneut gesendeter Dateistand muss zum Journal passen. Offene Uploads müssen vor der jeweiligen Abgabe abgeschlossen werden.

PDF und ZIP entstehen ausschließlich aus einer geprüften privaten Revision. Anlagen sind mit ID, SHA-256 und Storage-Version gebunden; spätere Dateien werden nicht still in alte Exporte aufgenommen. ZIP ist auf 20 MiB Quelldateien begrenzt. Artefakte und Exporthistorie liegen ebenfalls im Lohnbereich, nicht in der allgemeinen Dokumentensuche. Downloads prüfen die konkrete Berechtigung vor und nach dem Lesen des exakten gespeicherten Dateistands. Antworten sind privat, nicht zwischenspeicherbar und als Download gekennzeichnet. Ein PDF ist ein Prüfstand und kein Nachweis einer Meldung oder eines DATEV-Imports.

## DATEV und externe Meldungen

Der einzige vorgesehene DATEV-Zweck ist die Mitarbeiterneuanlage in **Lohn und Gehalt**. Berater-, Mandanten- und Personalnummer müssen mit dem Zielbestand abgeglichen und bestätigt werden; die Anwendung vergibt keine Nummern automatisch. Die Feldspezifikation der tatsächlich installierten Version und eine dokumentierte reale Importprobe fehlen. Deshalb ist das DATEV-Gate dauerhaft sichtbar **BLOCKED**, auch nach Kanzleiprüfung und Nummernbestätigung. Es wird keine vermeintlich importfähige ASCII-/CSV-Datei ausgegeben. Prüfversuche werden an der jeweiligen Revision protokolliert. Eine spätere Freigabe erfordert eine gesonderte, geprüfte Implementierung und Abnahme des echten Formats; ein manueller Statusschalter genügt nicht.

Die Sofortmeldung wird als eigenständige externe Aufgabe geführt. Ein Arbeitgeberhinweis stellt keine Branchen- oder Meldepflicht fest. Kanzleipersonen können einen Einzelfallgrund für „nicht erforderlich“ oder einen externen Übermittlungsnachweis mit Referenz/Ereignisdatum dokumentieren. Diese Angaben bewirken weder eine elektronische Meldung noch die Erledigung anderer Fristen oder Aufgaben.

## Plausibilität und Grenzen

Pflichtfelder, echte Kalenderdaten, positive Beträge/Stunden, Auswahlwerte und widersprüchliche Angaben werden geprüft. Nicht vergebene Steuer-ID und Versicherungsnummer sind ausdrücklich auswählbar; leere oder erfundene Platzhalter müssen nicht als Nummern eingetragen werden. Die Steuer-ID erhält nur eine offen ausgewiesene Formatprüfung auf elf Ziffern, keine Prüfung ihrer Vergabe oder Prüfziffer. Die Versicherungsnummer wird hinsichtlich Aufbau und Prüfziffer geprüft; Geschlecht oder andere persönliche Merkmale werden daraus nicht abgeleitet. IBAN wird über Aufbau und Modulo-97 sowie die deutsche Länge geprüft. Die Prüfung ist keine vollständige länderspezifische IBAN-Registerprüfung und beweist weder Kontoinhaberschaft noch Erreichbarkeit des Kontos.

Primärquellen für diese begrenzten Prüfungen: [§ 1 StIdV](https://www.gesetze-im-internet.de/stidv/__1.html), [§ 2 VKVV bei der Deutschen Rentenversicherung](https://rvrecht.deutsche-rentenversicherung.de/SharedDocs/rvRecht/05_Normen_und_Vertraege/02_S-Z/VKVV/0002/0002_2020_07_01.html), [IBAN-Regeln der Bundesbank](https://www.bundesbank.de/de/aufgaben/unbarer-zahlungsverkehr/serviceangebot/iban-regeln). Diese Quellen ersetzen keine fachliche Freigabe der Lohnbearbeitung.

## Aufbewahrung, Nachweise und Abnahme

Personenbezogene Antworten, Anlagen, externe Nachweistexte und private Revisionen sind private Fachvorgangsbestände des bestehenden Löschkonzepts. Es wird keine neue gesetzliche Jahresfrist behauptet und kein Massenlöschlauf hinzugefügt. Eine Löschung muss den gesamten zusammengehörigen Vorgang einschließlich privater Revisionen, Sessions, Exporthistorie und Storage-Versionen sowie mögliche Sperren berücksichtigen. Audit-Evidenz speichert ausschließlich IDs, Revision und knappe Statusmerkmale, keine Steuer-ID, IBAN, Versicherungsnummer oder Antworttexte.

Die bestehende Mandats-Stammdatenanonymisierung anonymisiert diese neuen Lohnvorgänge nicht automatisch. Ihr Erfolg ist daher kein Nachweis einer vollständigen Anonymisierung des Personalfragebogens, seiner Anlagen oder privaten Historie. Diese Bestände verlangen vor produktiver Aktivierung einen gesondert geprüften Lösch- beziehungsweise Aufbewahrungsprozess. Ein Mandatsende sperrt die Zugänge, ersetzt aber keine Löschung.

Technische Nachweise stehen in `packages/db/src/__tests__/payroll-intake.test.ts` und `apps/web/src/server/payroll/__tests__/definition.test.ts` sowie `pdf.test.ts`. Die Datenbanktests verlangen eine isolierte Owner-/App-Testdatenbank; übersprungene Tests sind kein Zugriffsnachweis. Vor produktiver Freischaltung bleiben die fachliche Prüfung der Vorlagen, die Datenschutz-/Aufbewahrungsorganisation und eine Bedienabnahme einschließlich unterbrochenem Storage-Commit erforderlich. DATEV-Importabnahme bleibt ausdrücklich offen. Migrationen und negative Zugriffsprüfungen ersetzen keine Berufsträgerfreigabe.
