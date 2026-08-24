# Fachkatalog – Regelindex

<!-- Diese Datei wird durch `pnpm fachkatalog:generate` erzeugt. Nicht manuell bearbeiten. -->

> Der fachliche Status und der technische Umsetzungsstand sind unabhängig.
> „Umgesetzt“ bedeutet nicht „fachlich freigegeben“.
> `approved` authentifiziert die eingetragene Person nur mit separater Repository-Governance oder signierter Attestation.

## Audit und Software-Assurance

### [ASSURANCE-PROFESSIONAL-REVIEW-001 — Fachliche Freigabe von technischer Umsetzung und KI-Beiträgen trennen](regeln/audit-und-assurance/assurance-professional-review-001-fachreview.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Teilweise umgesetzt**
- Geltung: nicht eingegrenzt
- Kurzfassung: Der Fachkatalog führt den technischen Umsetzungsstatus unabhängig vom berufsträgerlichen Reviewstatus. Eine fachliche Freigabe benötigt benannte Person, Prüfdatum und einen Hash des geprüften Fachinhalts. KI-Werkzeuge dürfen diese Freigabedaten nicht setzen. Der Validator erkennt nachträgliche Änderungen am gebundenen Inhalt, authentifiziert aber weder die Person noch deren Berufsqualifikation.

### [ASSURANCE-RELEASE-EVIDENCE-001 — Releasebezogene technische Nachweise in einem Dossier binden](regeln/audit-und-assurance/assurance-release-evidence-001-release-dossier.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Teilweise umgesetzt**
- Geltung: nicht eingegrenzt
- Kurzfassung: Für einen konkret benannten Release sollen Tag und Commit, unveränderliche Image-Digests, signiertes Update-Manifest, ausgeführte CI- und Security-Jobs, SBOMs, KoSIT-Berichte, Abweichungen und getrennte Freigabeentscheidungen in einem nachvollziehbaren Dossier zusammengeführt werden. Workflow und Vorlage schaffen dafür technische und dokumentarische Voraussetzungen, sind aber noch kein ausgefüllter Nachweis und keine externe Prüfaussage.

### [AUDIT-ARCHIVE-001 — Audit-Ketten in deterministischen Segmenten archivieren](regeln/audit-und-assurance/audit-archive-001-segmentarchiv.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Teilweise umgesetzt**
- Geltung: nicht eingegrenzt
- Kurzfassung: Der Audit-Rotationsjob exportiert einen zusammenhängenden ID-Bereich eines Kanzlei-Tenants als deterministisches NDJSON-Segment. Das Segment enthält Kettenanker und einen Datei-Hash, wird vor der Ablage vollständig nachgerechnet und im Storage mit COMPLIANCE Object Lock gespeichert. Wiederholungen können bereits hochgeladene, aber noch nicht in der Datenbank registrierte Segmente erkennen und übernehmen.

### [AUDIT-HASH-CHAIN-001 — Audit-Ereignisse je Kanzlei-Tenant kanonisch verketten](regeln/audit-und-assurance/audit-hash-chain-001-tenant-hashkette.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Umgesetzt und getestet**
- Geltung: nicht eingegrenzt
- Kurzfassung: TaxTronik schreibt über den Evidence-Service Audit-Ereignisse in eine eigene Kette je Kanzlei-Tenant. Jeder Kettenwert bindet den Vorgänger und eine deterministisch kanonisierte Darstellung von Zeitpunkt, Tenant, Akteur, Aktion, Ressource sowie Vorher- und Nachherzustand. Schreiben und spätere Prüfung verwenden dieselbe Hash-Abbildung.

### [AUDIT-RFC3161-ANCHOR-001 — Audit-Spitzen mit geprüften RFC-3161-Zeitankern koppeln](regeln/audit-und-assurance/audit-rfc3161-anchor-001-externe-zeitanker.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Teilweise umgesetzt**
- Geltung: nicht eingegrenzt
- Kurzfassung: TaxTronik kann Spitzen der lokalen Audit-Kette und Tagesabschlüsse mit RFC-3161-Antworten verankern. Eine Antwort gilt erst nach Prüfung von Message-Imprint, CMS-Signatur, Zertifikatskette, Timestamping-EKU, Zertifikatsbindung und Erzeugungszeit als vertrauenswürdiger externer Anker. Lokale Entwicklungsstempel werden nicht als externe Evidenz ausgegeben.

### [AUDIT-VERIFY-ALERT-001 — Audit-Ketten regelmäßig prüfen und Abweichungen alarmieren](regeln/audit-und-assurance/audit-verify-alert-001-prueflauf-und-alarm.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Umgesetzt und getestet**
- Geltung: nicht eingegrenzt
- Kurzfassung: Ein täglicher und manuell auslösbarer Worker prüft die Audit-Kette jedes Kanzlei-Tenants. Er erkennt Hash- oder Vorgängerfehler, eine gegenüber dem letzten erfolgreichen Lauf verkürzte lokale oder externe Spitze sowie Fehler bei Versiegelung, Ankerkette und externer TSA-Policy. Das Ergebnis wird persistiert und bei Abweichungen an interne Admin-/Partner-Rollen gemeldet.

## BWA und Planung

### [BWA-IMPORT-MAPPING-001 — DATEV- und Addison-BWA nur anhand bekannter Strukturen importieren](regeln/bwa-und-planung/bwa-import-mapping-001-strukturimport.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Teilweise umgesetzt**
- Geltung: nicht eingegrenzt
- Kurzfassung: TaxTronik liest strukturierte DATEV-BWA aus XLSX und Addison-BWA aus Semikolon-CSV ein. Perioden und Kennzahlen entstehen nur aus den im Parser bekannten Spalten-, Zeilen- und Positionsmustern. Ein erfolgreicher Import belegt weder die Vollständigkeit der Quelldatei noch die richtige fachliche Zuordnung oder Vorzeichenlogik.

### [BWA-PROJECTION-001 — BWA-Hochrechnungen nur als bandbreitenbehaftete Szenarien ausweisen](regeln/bwa-und-planung/bwa-projection-001-szenariorechnung.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Weicht ab**
- Geltung: nicht eingegrenzt
- Kurzfassung: TaxTronik stellt zwei bewusst einfache Szenarien bereit: eine lineare Jahres-Run-rate aus der jüngsten unterjährigen Periode und eine lineare Regression aus mindestens zwei vollständigen Vorjahren. Beide zeigen einen Schätzwert und eine heuristische Spanne. Die Werte sind keine Garantie für Ergebnis, Steuer, Liquidität oder Saisonalität.

### [BWA-TAX-ESTIMATE-001 — BWA-Steuerschätzung auf eng begrenzte Annahmen beschränken](regeln/bwa-und-planung/bwa-tax-estimate-001-vereinfachte-steuerschaetzung.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Teilweise umgesetzt**
- Geltung: 2025-01-01 bis 2026-12-31
- Kurzfassung: TaxTronik berechnet eine unverbindliche Orientierung aus einem vorläufigen BWA-Ergebnis. Einzelne gesetzliche Parameter sind für 2025 und 2026 im Code hinterlegt; die erforderlichen steuerlichen Bemessungsgrundlagen werden aber nicht aus einem vollständigen Steuerfall ermittelt. Deshalb ist der Stand nur teilweise umgesetzt und ungeprüft. Ein Disclaimer, die Bezeichnung „Beta“ oder eine plausible Zahl macht eine sachlich unvollständige Berechnung nicht richtig.

## Datenschutz

### [DSGVO-CONSENT-SNAPSHOT-001 — Angezeigte Einwilligungs- und Hinweisfassung unverändert nachweisen](regeln/datenschutz/dsgvo-consent-snapshot-001-einwilligungsnachweis.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Umgesetzt und getestet**
- Geltung: nicht eingegrenzt
- Kurzfassung: TaxTronik trennt freiwillige Einwilligungsoptionen von erforderlichen Kenntnisnahmen oder Bestätigungen. Neue Erklärungen enthalten keine vorausgewählte freiwillige Option. Gespeichert werden die tatsächlich angezeigte Hinweisfassung, kanonische Optionsdaten und gegebenenfalls ein Snapshot des zugeordneten Dienstleisters; spätere Katalogänderungen schreiben historische Erklärungen nicht um.

### [DSGVO-CONTACT-EXPORT-001 — Kontaktbezogenes Auskunfts- und Portabilitätspaket vorbereiten](regeln/datenschutz/dsgvo-contact-export-001-kontaktpaket.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Teilweise umgesetzt**
- Geltung: ab 2018-05-25
- Kurzfassung: TaxTronik erzeugt für einen Mandantenkontakt ein strukturiertes JSON-Paket aus den technisch zuordenbaren Datenklassen und bindet die exakten Ausgabebytes mit SHA-256. Das Paket ist eine Arbeitsgrundlage für Auskunft und gegebenenfalls Datenübertragbarkeit, keine Vollständigkeitsbestätigung. Vor Herausgabe sind Identität, Umfang, Daten Dritter und weitere Speicherorte manuell zu prüfen.

### [DSGVO-MANDATE-ANONYMIZATION-001 — Personenbezogene Mandatsdaten nach manueller Fristenprüfung anonymisieren](regeln/datenschutz/dsgvo-mandate-anonymization-001-mandatsende.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Teilweise umgesetzt**
- Geltung: nicht eingegrenzt
- Kurzfassung: TaxTronik stellt personenbezogene Mandatsdaten nicht automatisch frei zur Anonymisierung. Für natürliche Personen erscheint nach dem dokumentierten Mandatsende und einem pauschalen Zehnjahresfenster ab Jahresende ein Prüfvorschlag; die Ausführung bleibt ein manueller Admin-/Partner-Schritt. Dieser Vorschlag ersetzt weder die aktenbezogene Prüfung des § 66 StBerG noch weitere Aufbewahrungs-, Herausgabe-, Anspruchs- oder Beweisgründe.

### [DSGVO-OPERATIONAL-RETENTION-001 — Feste technische Löschfristen für definierte Betriebsdaten anwenden](regeln/datenschutz/dsgvo-operational-retention-001-technische-loeschfristen.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Teilweise umgesetzt**
- Geltung: nicht eingegrenzt
- Kurzfassung: TaxTronik setzt für ausdrücklich benannte Betriebsdaten feste technische Lösch- oder Neutralisierungsfristen durch. Diese Werte sind Kanzlei-/Produkt- Defaults, keine aus Art. 5 oder Art. 17 DSGVO unmittelbar ableitbaren Einzelfristen. Die Kanzlei muss Zweck, Rechtsgrundlage, Aufbewahrungspflicht und Sperrbedarf je Datenklasse prüfen.

### [DSGVO-REQUEST-DEADLINE-001 — Monatsfrist für Betroffenenanträge als Kontrolltermin berechnen](regeln/datenschutz/dsgvo-request-deadline-001-monatsfrist.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Teilweise umgesetzt**
- Geltung: ab 2018-05-25
- Kurzfassung: Art. 12 Abs. 3 DSGVO verlangt die Information über Maßnahmen grundsätzlich unverzüglich, spätestens innerhalb eines Monats nach Antragseingang. TaxTronik berechnet dafür ab dem erfassten Eingangsdatum einen monatsende-sicheren Kontrolltermin. Dieser Wert ist kein abschließend freigegebenes Fristende.

### [DSGVO-REQUEST-EVIDENCE-001 — Abschluss und Ablehnung eines Betroffenenantrags technisch nachweisen](regeln/datenschutz/dsgvo-request-evidence-001-abschlussnachweis.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Umgesetzt und getestet**
- Geltung: nicht eingegrenzt
- Kurzfassung: TaxTronik lässt einen Betroffenenantrag nur mit einem strukturierten technischen Nachweis auf COMPLETED oder REJECTED wechseln. Auskunft und Datenübertragbarkeit benötigen ein Ergebnisartefakt, eine dokumentierte personelle Prüfung und einen Versandnachweis; eine Ablehnung benötigt eine Begründung und den bestätigten Hinweis auf Rechtsbehelfe. Das Produkt beurteilt nicht, ob Inhalt und Rechtsauffassung fachlich richtig sind.

## Dokumente und Aufbewahrung

### [DOC-OBJECT-LOCK-001 — Geschützte Dokumentbytes mit passendem Object Lock speichern](regeln/dokumente-und-aufbewahrung/doc-object-lock-001-speicherschutz.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Umgesetzt und getestet**
- Geltung: nicht eingegrenzt
- Kurzfassung: TaxTronik schreibt GOBD-geschützte Bytes im S3-Object-Lock-Modus COMPLIANCE und GwG-Bytes im Modus GOVERNANCE. Vorbereitete Uploads binden Tenant, Bucket, Schlüssel, Hash, Größe und Retention; ein geschützter Commit gilt nur mit nachweisbarer Objektversions-ID als erfolgreich. Das belegt einen technischen Lösch-/Überschreibschutz, nicht die Ordnungsmäßigkeit des gesamten Verfahrens.

### [DOC-PORTAL-SHARING-001 — Dokumente im Portal nur nach ausdrücklicher Mandantenfreigabe ausliefern](regeln/dokumente-und-aufbewahrung/doc-portal-sharing-001-mandantenfreigabe.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Umgesetzt und getestet**
- Geltung: nicht eingegrenzt
- Kurzfassung: Ein von Mitarbeitern geführtes Dokument ist im Mandantenportal nur sichtbar und abrufbar, wenn es dem Session-Mandanten gehört, nicht soft-gelöscht ist und ausdrücklich freigegeben wurde. Download und Vorschau erzwingen dieselben Filter. Die technische Freigabe entscheidet nicht, ob eine Herausgabe fachlich, berufsrechtlich oder datenschutzrechtlich zulässig ist.

### [DOC-RETENTION-CLASS-001 — Dokumenttyp in technische Schutz- und Aufbewahrungsklasse überführen](regeln/dokumente-und-aufbewahrung/doc-retention-class-001-aufbewahrungsklasse.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Teilweise umgesetzt**
- Geltung: nicht eingegrenzt
- Kurzfassung: TaxTronik bildet einen gewählten Datei-Typ auf die technische Schutzstufe NONE, GWG oder GOBD ab. Für GoBD-Typen sind ausschließlich sechs, acht oder zehn Jahre vorgesehen; die Kernzuordnung lautet Vertrag sechs, Rechnung/Buchungsbeleg acht und Steuerunterlage zehn Jahre. Diese Zuordnung ist eine Produktklassifikation und ersetzt keine Inhalts- und Fristbeginnprüfung.

### [DOC-UPLOAD-JOURNAL-001 — Geschützte Uploads über eine auffindbare Speicherabsicht wiederaufnehmen](regeln/dokumente-und-aufbewahrung/doc-upload-journal-001-zweiphasiger-upload.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Teilweise umgesetzt**
- Geltung: nicht eingegrenzt
- Kurzfassung: Der zweiphasige Uploadpfad persistiert vor dem Object-Store-Write eine PENDING-Dokumentversion mit festem Bucket, Schlüssel, Hash, Größe und Retention. Nach einem mehrdeutigen Commit kann genau dieser Intent gesucht und auf CLEAN finalisiert werden. Diese Vorab-Journalisierung ist derzeit nicht einheitlich auf allen geschützten Uploadwegen eingesetzt.

### [DOC-VERSION-IMMUTABILITY-001 — Geschützte Dokumentversionen nur anfügen und Schutz nicht herabsetzen](regeln/dokumente-und-aufbewahrung/doc-version-immutability-001-geschuetzte-versionen.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Umgesetzt und getestet**
- Geltung: nicht eingegrenzt
- Kurzfassung: TaxTronik überschreibt bei einem normalen Versionsupload keine bestehenden Bytes, sondern legt eine weitere nummerierte Dokumentversion an. Eine bereits geschützte Version wird auch beim Retagging nicht auf eine neue Speicheridentität umgebogen; die höher geschützte Kopie wird angefügt. Schutzstufen und gesetzte Retention dürfen nicht nachträglich abgesenkt werden.

### [GOBD-VERFAHRENSDOKU-001 — Technischen IST-Baustein der Verfahrensdokumentation erzeugen](regeln/dokumente-und-aufbewahrung/gobd-verfahrensdoku-001-ist-dokument.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Teilweise umgesetzt**
- Geltung: nicht eingegrenzt
- Kurzfassung: TaxTronik kann einen datierten Markdown-Baustein aus dem aktuell erfassten Systemzustand und versionierten Herstellertexten erzeugen. Er enthält unter anderem Version, Module, Mengengerüst, Backup-/Drillstatus, Auditprüfung und TSA-Konfiguration. Nach GoBD muss die Verfahrensdokumentation jedoch das tatsächlich eingesetzte organisatorische und technische Verfahren vollständig, schlüssig, verständlich, aktuell und historisch nachvollziehbar beschreiben; der Generator allein erfüllt das nicht.

## Fristen und Bescheide

### [TAX-CONTROL-STATUS-001 — Offene und erledigte Fristen beweisorientiert aus dem Quellvorgang ableiten](regeln/fristen-und-bescheide/tax-control-status-001-fristenkontrollbuch.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Teilweise umgesetzt**
- Geltung: nicht eingegrenzt
- Kurzfassung: Das Fristenkontrollbuch führt keinen frei editierbaren parallelen „Erledigt“-Schalter, sondern leitet seine Sicht aus dem jeweiligen Fachvorgang ab. Ein Statusname allein ist dafür nicht immer ausreichend: Eine relevante Frist soll erst geschlossen werden, wenn Erledigungsgrund und erforderlicher Nachweis im Quellvorgang dokumentiert sind.

### [TAX-DEADLINE-AUTOREQUEST-001 — Automatische Mandantenanforderung vor Steuerterminen steuern](regeln/fristen-und-bescheide/tax-deadline-autorequest-001-automatische-anforderung.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Teilweise umgesetzt**
- Geltung: nicht eingegrenzt
- Kurzfassung: TaxTronik darf zu einem bevorstehenden Steuertermin genau eine Portal-Anforderung anlegen, wenn die Kanzlei die Automatik aktiviert, der Mandant freigeschaltet ist und keine dokumentierte Sperre besteht. Nach Ablauf des Fälligkeitstags wird keine neue automatische Anforderung mehr angelegt.

### [TAX-DEADLINE-WORKDAY-001 — Fristende auf den nächsten Werktag verschieben](regeln/fristen-und-bescheide/tax-deadline-workday-001-werktagsverschiebung.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Teilweise umgesetzt**
- Geltung: nicht eingegrenzt
- Kurzfassung: TaxTronik darf ein Datum nur dann nach § 108 Abs. 3 AO verschieben, wenn es das Ende einer Frist ist und keine gesetzliche Ausnahme greift. Fällt dieses Fristende auf einen Sonnabend, Sonntag oder einen am rechtlich maßgeblichen Ort geltenden gesetzlichen Feiertag, endet die Frist mit Ablauf des nächstfolgenden Werktags.

### [TAX-NOTICE-APPEAL-001 — Einspruchsfrist im dokumentierten Bekanntgabe-Regelfall berechnen](regeln/fristen-und-bescheide/tax-notice-appeal-001-einspruchsfrist-regelfall.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Teilweise umgesetzt**
- Geltung: ab 2025-01-01
- Kurzfassung: TaxTronik ermittelt in klar dokumentierten Standardfällen zunächst den rechtlichen Bekanntgabetag und berechnet daran anschließend grundsätzlich die einmonatige Einspruchsfrist nach § 355 Abs. 1 AO. Bei unterbliebener oder unrichtiger Rechtsbehelfsbelehrung wird nach § 356 Abs. 2 AO grundsätzlich eine Jahresfrist vorgeschlagen.

### [TAX-NOTICE-DATARETRIEVAL-001 — Bekanntgabetag bei Bereitstellung zum Datenabruf nach § 122a AO bestimmen](regeln/fristen-und-bescheide/tax-notice-dataretrieval-001-bereitstellung-datenabruf.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Teilweise umgesetzt**
- Geltung: ab 2026-01-01
- Kurzfassung: Ein nach § 122a AO zum Datenabruf bereitgestellter Verwaltungsakt gilt grundsätzlich am vierten Tag nach seiner Bereitstellung als bekannt gegeben. Fällt dieser Tag auf einen Sonnabend, Sonntag oder am regelmäßig maßgeblichen Empfängerort geltenden gesetzlichen Feiertag, ist § 108 Abs. 3 AO zu prüfen.

## Geldwäschegesetz

### [GWG-ACTIVATION-GATE-001 — Operative Aktivierung nur nach gültiger GwG-Freigabe](regeln/gwg/gwg-activation-gate-001-operative-aktivierung.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Umgesetzt und getestet**
- Geltung: nicht eingegrenzt
- Kurzfassung: TaxTronik behandelt client.allowActive als produktseitige GwG-Schranke. Die Freischaltung ist nur möglich, wenn ein noch gültiger, nicht vernichteter VERIFIED-Prüfsnapshot mit der für den Mandantentyp erforderlichen Identitätszuordnung existiert. Ohne Freischaltung blockiert die Datenbank neue Anforderungen, Rechnungen und reguläre Dokumente.

### [GWG-BENEFICIAL-OWNERS-001 — Wirtschaftlich Berechtigte ermitteln, erfassen und plausibilisieren](regeln/gwg/gwg-beneficial-owners-001-wirtschaftlich-berechtigte.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Teilweise umgesetzt**
- Geltung: nicht eingegrenzt
- Kurzfassung: Bei Rechtsträgern muss geklärt werden, welche natürlichen Personen letztlich Eigentum oder Kontrolle ausüben beziehungsweise auf wessen Veranlassung die Geschäftsbeziehung begründet wird. TaxTronik erfasst diese Personen, ihre Risikodaten sowie eine freie Beschreibung der Eigentums- und Kontrollstruktur und verlangt vor der Freigabe mindestens einen Datensatz.

### [GWG-IDENTIFICATION-EVIDENCE-001 — Identitätsangaben erheben und mit zugeordnetem Nachweis prüfen](regeln/gwg/gwg-identification-evidence-001-identitaet-und-nachweis.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Teilweise umgesetzt**
- Geltung: nicht eingegrenzt
- Kurzfassung: Vor der Produktfreigabe müssen die für den Mandantentyp vorgesehenen Identitätsangaben gespeichert und mit einem konkreten Nachweis verbunden sein. Bei natürlichen Personen akzeptiert das aktuelle Gate einen gültigen Personalausweis oder Reisepass; bei Rechtsträgern werden Rechtsform, Registerdaten beziehungsweise Registerlosigkeit und ein Register- oder Gründungsnachweis verlangt.

### [GWG-REPRESENTATIVE-AUTHORITY-001 — Auftretende Person identifizieren und Vertretungsberechtigung prüfen](regeln/gwg/gwg-representative-authority-001-vertretung.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Teilweise umgesetzt**
- Geltung: nicht eingegrenzt
- Kurzfassung: Handelt für den Vertragspartner eine andere Person, sind deren Identität und die Berechtigung zum Auftreten zu prüfen. TaxTronik erfasst bei Rechtsträgern eine geordnete Vertreterliste, kann eine Person zugleich als wirtschaftlich Berechtigten kennzeichnen und verlangt für die Freigabe mindestens einen eindeutig zugeordneten, gültigen Vertreter-Ausweis.

### [GWG-RETENTION-DESTRUCTION-001 — GwG-Aufzeichnungen fristgerecht aufbewahren und vollständig vernichten](regeln/gwg/gwg-retention-destruction-001-aufbewahrung-und-vernichtung.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Teilweise umgesetzt**
- Geltung: nicht eingegrenzt
- Kurzfassung: GwG-Aufzeichnungen und -Belege sind grundsätzlich fünf Jahre aufzubewahren, soweit andere gesetzliche Vorschriften nicht länger verpflichten, und spätestens nach zehn Jahren zu vernichten. Bei einer Geschäftsbeziehung beginnt die Frist mit dem Schluss des Kalenderjahres ihres Endes, in übrigen Fällen mit dem Schluss des Jahres der jeweiligen Feststellung.

### [GWG-REVERIFICATION-VALIDITY-001 — Prüfungsablauf und relevante Änderungen lösen einen neuen Prüfzyklus aus](regeln/gwg/gwg-reverification-validity-001-wiederholungspruefung.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Umgesetzt und getestet**
- Geltung: nicht eingegrenzt
- Kurzfassung: TaxTronik versieht jede freigegebene GwG-Prüfung mit einer Produktgültigkeit: 365 Tage bei HIGH, sonst 1095 Tage. Der tägliche Worker warnt 90 und 30 Tage vor Ablauf. Ist der Zeitpunkt erreicht und existiert kein neuerer gültiger Prüfsnapshot, wird der alte Check EXPIRED und der Mandant deaktiviert.

### [GWG-RISK-REVIEW-001 — Regelbasierten Risikoentwurf nur durch zugeordneten Berufsträger freigeben](regeln/gwg/gwg-risk-review-001-risikobewertung-und-freigabe.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Umgesetzt und getestet**
- Geltung: nicht eingegrenzt
- Kurzfassung: TaxTronik erzeugt aus sechs manuell beantworteten Risikofaktoren einen reproduzierbaren Vorschlag für LOW, MEDIUM oder HIGH. Eine PEP-Angabe erzwingt unabhängig vom Summenscore HIGH. Erst nach vollständiger Identifizierungs- und Risikoprüfung kann der Entwurf eingereicht und durch den dem Mandanten zugeordneten Berufsträger ausdrücklich freigegeben werden.

### [GWG-SELF-ONBOARDING-001 — Mandantendaten per gebundener Einladung nur als Prüfentwurf einreichen](regeln/gwg/gwg-self-onboarding-001-einreichung.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Umgesetzt und getestet**
- Geltung: nicht eingegrenzt
- Kurzfassung: Der öffentliche GwG-Wizard erlaubt einer eingeladenen Person, Stammdaten, wirtschaftlich Berechtigte, Vertreter, Identitätsbelege und Zusatzunterlagen ohne Portal-Konto zu übermitteln. Jeder Schreibzugriff ist an den geheimen, noch gültigen Link, den Mandanten und einen bei Einladungsausgabe gebundenen Ausgangsstand gekoppelt.

## Mandat und Zugriff

### [ACCESS-CLIENT-MODE-001 — Kanzleiweiten Mandantenzugriff nach OPEN, RESTRICTED und Vertraulichkeit steuern](regeln/mandat-und-zugriff/access-client-mode-001-zugriffsmodus.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Umgesetzt und getestet**
- Geltung: nicht eingegrenzt
- Kurzfassung: TaxTronik trennt organisatorische Zuständigkeit vom technischen Lesezugriff. Im Modus OPEN dürfen aktive Mitarbeiter an allen nicht vertraulichen Mandanten der Kanzlei mitarbeiten. RESTRICTED und ein gesetztes Vertraulichkeitsflag beschränken Nicht-Admins auf zugeordnete Berufsträger oder Hauptbearbeiter; ADMIN und PARTNER sind immer zugelassen.

### [ACCESS-NOTIFICATION-RECIPIENT-001 — Mandantenbezogene Mitarbeiterbenachrichtigungen nach aktuellem Zugriff filtern](regeln/mandat-und-zugriff/access-notification-recipient-001-benachrichtigungsscope.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Teilweise umgesetzt**
- Geltung: nicht eingegrenzt
- Kurzfassung: Eine alte Zuständigkeit darf nicht dauerhaft Zugang zu einem später vertraulichen oder RESTRICTED-Mandanten vermitteln. Mandantenbezogene Notifications werden daher an eine bekannte Fachressource und deren Mandanten gebunden; Anzeige und Mutation verlangen den aktuellen Clientzugriff. Technisch globale oder persönliche Systemmeldungen bleiben ein getrennter Scope.

### [ACCESS-STAFF-PERMISSION-001 — Aktionsrechte getrennt vom Mandantenzugriff prüfen](regeln/mandat-und-zugriff/access-staff-permission-001-einzelrechte.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Umgesetzt und getestet**
- Geltung: nicht eingegrenzt
- Kurzfassung: Ein sichtbarer Mandant allein berechtigt nicht automatisch zu jeder Aktion. TaxTronik prüft für die dafür eingerichteten Funktionen zusätzlich ein Einzelrecht. ADMIN und PARTNER haben diese Rechte implizit; andere Mitarbeiter benötigen einen expliziten Grant.

### [ACCESS-TENANT-RLS-001 — Tenantdaten mit Kontext und erzwungener Row-Level-Security isolieren](regeln/mandat-und-zugriff/access-tenant-rls-001-tenant-isolation.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Umgesetzt und getestet**
- Geltung: nicht eingegrenzt
- Kurzfassung: Anwendungszugriffe auf Tenantdaten laufen in einer Transaktion mit gesetztem Tenant-, Akteur- und Akteurtyp-Kontext. PostgreSQL erzwingt auf den erfassten Tabellen Row-Level-Security auch für den Tabellenowner der App-Rolle. Die Schicht ist ein technischer Backstop gegen Cross-Tenant-Zugriffe, kein Ersatz für Objektberechtigungen innerhalb einer Kanzlei.

### [CLIENT-MANDATE-LIFECYCLE-001 — Mandatsende auditieren und als nachgelagerten Workflow-Anker verwenden](regeln/mandat-und-zugriff/client-mandate-lifecycle-001-mandatsende.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Teilweise umgesetzt**
- Geltung: nicht eingegrenzt
- Kurzfassung: TaxTronik speichert ein Mandatsende am Mandanten, protokolliert Setzen und Zurücknehmen und nutzt den Zeitpunkt als Anker für Aufbewahrungs- und Anonymisierungsvorschläge. Eine Wiederaufnahme setzt den Wert auf null. Das Feld ist derzeit kein einheitlicher terminaler Status für alle Fachmodule.

### [FORM-PRESUBMIT-UPLOAD-001 — Eigene Formularuploads nur vor der Abgabe kontrolliert verwerfen](regeln/mandat-und-zugriff/form-presubmit-upload-001-upload-verwerfen.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Umgesetzt und getestet**
- Geltung: nicht eingegrenzt
- Kurzfassung: Ein Mandant darf einen eigenen Formularupload vor dem Absenden wieder entfernen. Die Datei muss eindeutig zu seiner Submission und dem konkreten FILE-Feld gehören; Submission und gebundene Anforderung müssen noch offen sein. Nach Submit oder Request-Abschluss verweigern App und Datenbank den Pfad.

### [REQ-INTERNAL-COMMENT-001 — Interne Anforderungskommentare vom Mandantenkanal trennen](regeln/mandat-und-zugriff/req-internal-comment-001-interne-kommentare.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Umgesetzt und getestet**
- Geltung: nicht eingegrenzt
- Kurzfassung: Interne Kanzleinotizen an einer Anforderung bleiben auch nach einer Mandantenantwort oder dem formellen Abschluss möglich. Sie werden getrennt von RequestResponse gespeichert, nur staffseitig geladen und lösen keine Mandantenmail aus.

### [REQ-LIFECYCLE-001 — Mandantenkanal einer Anforderung kontrolliert schließen und wieder öffnen](regeln/mandat-und-zugriff/req-lifecycle-001-anforderungsstatus.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Umgesetzt und getestet**
- Geltung: nicht eingegrenzt
- Kurzfassung: Eine mandantensichtbare Antwort oder Formularabgabe ist nur möglich, solange die Anforderung OPEN oder INPROGRESS ist. Eine erfolgreiche Mandantenantwort führt zu RESPONDED; Kanzleimitarbeiter können den Vorgang schließen oder aus RESPONDED/CLOSED wieder öffnen. Interne Kommentare folgen einer getrennten Regel.

## Rechnungen

### [INV-ARCHIVE-EINVOICE-001 — E-Rechnungsformate aus einer kanonischen Archivfassung bereitstellen](regeln/rechnungen/inv-archive-einvoice-001-kanonische-archivfassung.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Umgesetzt und getestet**
- Geltung: nicht eingegrenzt
- Kurzfassung: Bei der Ausstellung einer In-App-E-Rechnung erzeugt TaxTronik die menschenlesbare ZUGFeRD-PDF und die separate XRechnung-XML aus demselben fachlichen Snapshot und archiviert beide eindeutig verknüpft. Spätere Downloads liefern die gespeicherten Bytes und rendern den ausgestellten Beleg nicht mit heutigen Stammdaten oder Branding-Einstellungen neu.

### [INV-DUE-OVERDUE-001 — Fällige offene Rechnungen als Produktstatus überfällig markieren](regeln/rechnungen/inv-due-overdue-001-ueberfaelligkeitsstatus.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Umgesetzt und getestet**
- Geltung: nicht eingegrenzt
- Kurzfassung: Ein täglicher Worker markiert eine versendete, noch nicht bezahlte Originalrechnung ab dem Kalendertag nach ihrem gespeicherten Fälligkeitsdatum mit dem internen Status OVERDUE. Statuswechsel, Audit-Ereignis und interne Benachrichtigung erfolgen in einer Tenant-Transaktion und werden bei Wiederholung nicht dupliziert. Der Produktstatus ist keine abschließende rechtliche Feststellung des Schuldnerverzugs.

### [INV-LIFECYCLE-FREEZE-001 — Rechnungsinhalt nach Verlassen des Entwurfs festschreiben](regeln/rechnungen/inv-lifecycle-freeze-001-festschreibung.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Umgesetzt und getestet**
- Geltung: nicht eingegrenzt
- Kurzfassung: Solange eine In-App-Rechnung Entwurf ist, dürfen ihre Geschäftsdaten technisch geändert werden. Sobald sie den Entwurfsstatus verlässt, sind Nummer, Beträge, Daten, Steuerangaben und Positionen unveränderlich. Eine fachliche Korrektur erfolgt über den vorgesehenen Storno- und Neuausstellungsprozess, nicht durch Überschreiben des Originalbelegs.

### [INV-NUMBER-ALLOCATION-001 — In-App-Rechnungsnummern atomar und ohne Wiederverwendung vergeben](regeln/rechnungen/inv-number-allocation-001-rechnungsnummern.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Teilweise umgesetzt**
- Geltung: nicht eingegrenzt
- Kurzfassung: In-App-Rechnungen erhalten automatisch eine Nummer im Format JJJJ-NNNN aus einem getrennten Zähler je Kanzlei-Tenant und Rechnungsjahr. Vergabe, Zählererhöhung und Rechnungsanlage laufen in derselben Transaktion unter einem Tenant-Jahres-Advisory-Lock. Ein Rollback verbraucht daher keinen Zählerstand; stornierte Entwürfe und ausgestellte Rechnungen behalten ihre Nummer.

### [INV-PORTAL-SHARING-001 — Rechnungen erst nach Ausstellung im Mandantenportal zeigen](regeln/rechnungen/inv-portal-sharing-001-mandantensicht.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Weicht ab**
- Geltung: nicht eingegrenzt
- Kurzfassung: Ein Rechnungsentwurf ist ausschließlich kanzleiintern und darf dem Mandanten nicht als Rechnung angezeigt oder als Archivbeleg geteilt werden. Wurde eine Rechnung bereits versendet, bleibt sie auch nach einem späteren Storno als historischer Beleg im Portal sichtbar. Ein nie versendeter stornierter Entwurf bleibt dagegen intern.

### [INV-STORNO-REFERENCE-001 — Ausgestellte In-App-Rechnungen durch referenzierten Korrekturbeleg stornieren](regeln/rechnungen/inv-storno-reference-001-korrekturbeleg.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Teilweise umgesetzt**
- Geltung: nicht eingegrenzt
- Kurzfassung: Eine bereits ausgelieferte In-App-Rechnung wird nicht inhaltlich geändert. TaxTronik erzeugt stattdessen einen neuen Korrekturbeleg mit eigener Nummer, invertierten Positions- und Gesamtbeträgen, XRechnung-TypeCode 381 und Referenz auf die ursprüngliche Rechnungsnummer. Erst wenn der Korrekturbeleg archiviert und auf SENT festgeschrieben ist, wird das Original atomar auf CANCELLED gesetzt.

### [INV-TIME-ENTRY-CLAIM-001 — Zeiteinträge atomar genau einem Rechnungsentwurf zuordnen](regeln/rechnungen/inv-time-entry-claim-001-zeiteintraege.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Umgesetzt und getestet**
- Geltung: nicht eingegrenzt
- Kurzfassung: Beim Erstellen einer Rechnung aus Zeiten berücksichtigt TaxTronik nur abgeschlossene, abrechenbare und noch keiner Rechnung zugeordnete Einträge des gewählten Mandanten. Nach Anlage des Entwurfs beansprucht ein bedingtes Sammelupdate alle ausgewählten IDs. Werden nicht alle Einträge gewonnen, bricht die Transaktion ab und rollt Rechnung sowie Nummernvergabe vollständig zurück.

### [INV-VAT-TOTALS-001 — Netto-, Umsatzsteuer- und Bruttosummen je Steuersatzgruppe bilden](regeln/rechnungen/inv-vat-totals-001-steuersummen.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Teilweise umgesetzt**
- Geltung: nicht eingegrenzt
- Kurzfassung: TaxTronik berechnet In-App-Rechnungsbeträge serverseitig aus den Positionen. Nettobeträge werden nach Umsatzsteuersatz gruppiert, die Steuer wird einmal je Gruppe auf zwei Dezimalstellen gerundet und die Kopfwerte werden aus den Gruppensummen gebildet. Für E-Rechnungen werden technische Kategorien für steuerpflichtige, nullbesteuerte, befreite und Reverse-Charge-Positionen abgeleitet.

## Subsumtion und TCMS-Produktgrenzen

### [RISK-AI-SUGGESTION-001 — Automatische Risiko- und Normmarkierungen nur als Vorschläge behandeln](regeln/subsumtion-und-tcms/risk-ai-suggestion-001-vorschlagscharakter.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Teilweise umgesetzt**
- Geltung: nicht eingegrenzt
- Kurzfassung: Deterministische Treffer, Embedding-Treffer und LLM-Markierungen sind Hinweise für die fachliche Bearbeitung. Sie sind weder eine Subsumtion noch eine Freigabe und dürfen nicht allein wegen ihrer technischen Herkunft als richtig gelten. TaxTronik speichert die Herkunft; beim initialen Analysepfad wird auch ein Engine-Rohoutput referenziert. Die spätere Worker-Anreicherung archiviert ihren LLM-Rohoutput dagegen nicht. Materielle Richtigkeit oder Vollständigkeit des extern gepflegten Risiko- und Normkatalogs werden nicht validiert.

### [RISK-ARCHIVE-SNAPSHOT-001 — Subsumtionsstand als geschützten Snapshot archivieren und Änderungen begrenzen](regeln/subsumtion-und-tcms/risk-archive-snapshot-001-archivstand.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Teilweise umgesetzt**
- Geltung: nicht eingegrenzt
- Kurzfassung: TaxTronik serialisiert den aktuellen Sachverhalt, die Analysemetadaten und alle Markierungen als JSON, bildet darüber einen SHA-256-Wert und speichert eine gzip-Fassung im geschützten Speicher. Anschließend werden Archivverweis und Audit-Ereignis gesetzt. Der Snapshot konserviert einen wichtigen Arbeitsstand, ist aber nicht vollständig selbsttragend und die Sperre erfasst noch nicht jede mögliche Folgemutation.

### [RISK-CATALOG-FOUR-EYES-001 — Geteilte Beraterbegriffe nur vorwärts und durch eine zweite Person freigeben](regeln/subsumtion-und-tcms/risk-catalog-four-eyes-001-freigabe.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Umgesetzt und getestet**
- Geltung: nicht eingegrenzt
- Kurzfassung: Ein geteilter Beraterbegriff durchläuft den Engine-Status nur vorwärts. Ist sein Autor in der lokalen Audit-Chain bekannt, darf diese Person den eigenen Begriff nicht selbst weiterschalten. TaxTronik auditiert den Übergang erst nach bestätigtem Engine-Erfolg. Dieser Lebenszyklus ist vollständig vom Berufsträger-Review der Dateien unter docs/fachkatalog getrennt.

### [RISK-EXTERNAL-ANONYMIZATION-001 — Externe Recherche nur nach enger Datenminimierung und manueller Vorschau senden](regeln/subsumtion-und-tcms/risk-external-anonymization-001-rechercheversand.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Teilweise umgesetzt**
- Geltung: ab 2018-05-25
- Kurzfassung: TaxTronik ersetzt vor einem n8n-Rechercheauftrag bekannte Mandanten- und Kontaktdaten durch Platzhalter und markiert zusätzliche heuristische Treffer. Das Platzhalter-Mapping bleibt in der tenantgeschützten Anwendung und wird nicht in den Outbound-Payload aufgenommen. Unverändert mitgesendete Normanker können allerdings Freitext enthalten. Die Heuristik ist unvollständig; deshalb sind Vorschau, bewusste Auswahl des Ausschnitts und eine rechtliche beziehungsweise organisatorische Freigabe weiterhin erforderlich. Der Server erzwingt oder bindet diese Vorschauprüfung aktuell nicht.

### [TCMS-SAMPLE-PROOF-001 — Stichprobennachweis nur auf den deklarierten Rahmen und die konkrete Ziehung beziehen](regeln/subsumtion-und-tcms/tcms-sample-proof-001-rahmenbindung.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Teilweise umgesetzt**
- Geltung: nicht eingegrenzt
- Kurzfassung: TaxTronik erstellt für einen gewählten Zeitraum einen sortierten Rahmen aus Subsumtions- oder Audit-IDs und übergibt nur diese opaken IDs an den Risk-Layer. Nachweis, Rahmen, Backend-Metadaten und Treffer werden gemeinsam im Audit gespeichert und können später gegen genau diesen gespeicherten Rahmen geprüft werden. Damit ist die Ziehung nachvollziehbar, nicht aber die Vollständigkeit oder fachliche Eignung der Grundgesamtheit und Nachschau.

## Vollmachten und Signaturen

### [POA-LIFECYCLE-001 — Vollmachten kontrolliert durch DRAFT, SENT, SIGNED, REVOKED und EXPIRED führen](regeln/vollmachten-und-signaturen/poa-lifecycle-001-statusmaschine.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Umgesetzt und getestet**
- Geltung: nicht eingegrenzt
- Kurzfassung: TaxTronik führt Vollmachten in einer technischen Statusmaschine. Ein Entwurf wird versandt, eine versandte Vollmacht kann nach erfolgreichem Bestätigungsprozess signiert werden, und DRAFT, SENT oder SIGNED können in den vorgesehenen Grenzen widerrufen oder als abgelaufen markiert werden. REVOKED und EXPIRED sind technische Endzustände.

### [POA-SIGNER-RETENTION-001 — Personen- und Nachweisdaten elektronischer Vollmachten kontrolliert redigieren](regeln/vollmachten-und-signaturen/poa-signer-retention-001-signer-redaktion.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Teilweise umgesetzt**
- Geltung: nicht eingegrenzt
- Kurzfassung: TaxTronik behandelt Vollmachtsinhalt, Unterzeichner-Kontaktdaten und technische Bestätigungsdaten als personenbezogene Aufbewahrungsbestände. Nach dem derzeitigen Produktmodell werden sie frühestens nach zehn vollen Kalenderjahren ab dem Ende des Mandatsjahres manuell und protokolliert redigiert.

### [POA-SIGNING-CONFIRMATION-001 — Vollmachtsinhalt mit Magic-Link, E-Mail-Code und ausdrücklicher Zustimmung bestätigen](regeln/vollmachten-und-signaturen/poa-signing-confirmation-001-token-und-email-code.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Umgesetzt und getestet**
- Geltung: nicht eingegrenzt
- Kurzfassung: TaxTronik stellt einen technischen elektronischen Bestätigungsprozess bereit: Ein zufälliger Magic-Link öffnet die unveränderliche Vollmachtsfassung. Erst nach ausdrücklicher Zustimmung wird ein kurzlebiger sechsstelliger Code an dasselbe E-Mail-Postfach versandt; ein gültiger Code schließt den Vorgang atomar ab.

### [POA-SIGNING-SNAPSHOT-001 — Die versandte Vollmachtsfassung unveränderlich an den Bestätigungsnachweis binden](regeln/vollmachten-und-signaturen/poa-signing-snapshot-001-versandsnapshot.md)

- Fachprüfung: **Ungeprüfter Entwurf**
- Umsetzung: **Umgesetzt und getestet**
- Geltung: nicht eingegrenzt
- Kurzfassung: Vor dem Versand friert TaxTronik die konkret angezeigte Vollmachtsfassung ein. Bei einer Textvollmacht enthält der Snapshot den vollständigen Text, bei einer PDF-Vollmacht die konkrete Dokumentversions-ID und deren SHA-256. Der öffentliche Bestätigungsprozess zeigt und verarbeitet danach nur noch diese Fassung.
