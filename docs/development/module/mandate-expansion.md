# Mandatsorganisation: Strukturen, Abhängigkeiten, Übergabe und VDB-Nachweise

Vier getrennt schaltbare Module ergänzen die bestehenden Mandantenakten. Einstieg: `/staff/mandate-expansion`. Alle Funktionen verlangen Staff-Authentifizierung, einen aktiven Modulschalter und aktuellen Mandantenzugriff. Die Migration `20260831120000_mandate_expansion` ergänzt reale Fremdschlüssel, Scope-Prüfungen und erzwungene Tenant-RLS.

## Struktur (`mandateStructure`)

`MANDATE-STRUCTURE-001`: Die Kanzlei dokumentiert direkte Beteiligungen in einer versionierten Struktur. Bestehende Mandanten werden explizit ausgewählt; Personen und externe Organisationen werden manuell benannt. Kapital, Stimmrechte und sonstige Kontrolle sind unterschiedliche Kantenarten. Grafikpositionen lassen sich ziehen oder in der Tabelle ändern. Neue Versionen ersetzen keine historischen Inhalte. Die ausdrückliche Archivierung legt ein PDF mit Grafik, Knotennummern, vollständiger Tabelle und Versionshash ab. Sichtbare Ellipsen kennzeichnen kurze Grafiklabels. Eingebettete Unicode-Schriften unterstützen internationale Namen; unbekannte Zeichen sperren die Ausgabe ausdrücklich.

Keine automatische Identitätszusammenführung, indirekte Quote, wirtschaftlich-berechtigte Person oder Organschaft. Das bestehende GwG-/Personenankermodell bleibt unverändert. Vollständige Strukturen werden nur bei Zugriff auf sämtliche referenzierten Mandanten ausgegeben; andernfalls gibt es keine teilweise Offenlegung von Namen, Knotenzählern oder Verbindungswegen.

Die allgemeine Struktur besitzt außerdem eine ausdrückliche Verwendung als Arbeitsgrundlage einer konkreten GwG-Prüfung: `GwgStructureBinding` bindet unveränderliche Strukturversion, Hash, Prüfreferenz, Vermerk, Mitarbeiter und Übernahmerevision. Struktur- und GwG-Seite bieten dieselbe Übernahme mit vollständiger Tabelle und Verlauf. Nur die neueste offene Prüfung darf verändert werden; der vorhandene Lifecycle-Lock und `claimCheckMutation` setzen IN_REVIEW auf DRAFT zurück. Eine erneute Einreichung bleibt erforderlich. VERIFIED-/REJECTED-/EXPIRED-Checks bleiben unverändert; Personendaten, Rollen und Quoten werden nicht automatisch übernommen. Die vorhandene kontrollierte GwG-Vernichtung löst Referenz, Hash und Vermerk über einen eng begrenzten Trigger; minimale Nachweismetadaten und die separate allgemeine Struktur bleiben unter ihren eigenen Aufbewahrungsfragen. Migration: `20260831260000_gwg_structure_binding`. Betroffen: `GWG-BENEFICIAL-OWNERS-001`, `GWG-RISK-REVIEW-001`, `GWG-RETENTION-DESTRUCTION-001`.

## Abhängigkeiten (`workflowDependencies`)

`WORKFLOW-DEPENDENCY-001`: Zwei existierende Workflow-Schritte verschiedener Mandanten werden ausdrücklich verbunden. Die Bereitschaftsanzeige wird beim Laden aus allen Vorgängern berechnet. Nicht zugängliche Voraussetzungen führen nie zu einer positiven Bereitschaftszusage. Ein DB-Trigger verhindert Tenant-/Scope-Verletzungen und Zyklen unter serialisiertem Zugriff.

Beide Vorgänge benötigen dasselbe ausdrücklich bestätigte `assessmentYear`. Die Übersicht bietet eine Jahresbestätigung mit erwartetem Altstand; laufende Altvorgänge erhalten kein erfundenes Jahr. Bestehende Verbindungen müssen vor einer Änderung entfernt werden. Eine echte Wiederöffnung nimmt die Bereitschaft beim nächsten Laden zurück und benachrichtigt den aktiven, aktuell zugänglichen Nachfolger-Bearbeiter (hilfsweise Workflow-Ersteller). Nachrichten enthalten keine Vorgängeridentität und werden bei Modulpausen nicht erzeugt. Migration: `20260831270000_workflow_dependency_period`.

Diese Übersicht blockiert nicht sämtliche bestehenden Workflow-Actions. Sie ändert weder Fristen noch Aufgabenstatus. Eine weitergehende harte Bearbeitungssperre wäre eine gesonderte fachliche Änderung.

## Übergabe (`mandateOffboarding`)

`CLIENT-OFFBOARDING-001`: ADMIN/PARTNER bestätigt einen eindeutigen Empfänger und erstellt einen Prüfstand mit tatsächlichem Enddatum, einzelner Herausgabefreigabe pro Dokumentfassung, Übergabevermerk und Aufbewahrungsprüfung. Portalsichtbarkeit ist kein Auswahlkriterium und ersetzt keine Herausgabefreigabe. Interne, private, GwG- und Personalunterlagen verlangen eine zusätzliche sensible Freigabe pro Fassung; Personalunterlagen zusätzlich PAYROLL_MANAGE. Offene Steuertermine, Bescheidkontrollen und Anforderungen werden angezeigt. Ein separater Abschluss bestätigt den weiterhin aktuellen Stand und setzt `mandateEndedAt`. Laufende Portal- und Magic-Link-Prüfungen lehnen den aktuellen Mandatsstatus ab; bestehende Tokens werden zusätzlich widerrufen.

Die ausdrückliche Archivierungsaktion speichert ein separates PDF-Prüfprotokoll und ZIP-Teile nach Schutzklasse. ZIPs verwenden exakt gebundene Originalfassungen, prüfen Größen und SHA-256 und enthalten ihr Inhalts-/Hash-/Freigabeverzeichnis. Grenzen: 200 Dokumente, insgesamt 100 MiB, je Fassung und ZIP-Quellenumfang 24 MiB. PDF-Protokoll und alle Teile des aktuellen Freigabestands müssen vor Abschluss vollständig abgelegt sein. Personalteile sowie entsprechende Protokolle bleiben payroll-geschützt; GwG-Kopien und GwG-enthaltende Protokolle folgen dem bestehenden GwG-Vernichtungspfad. Keine Ausgabe wird pauschal über das Portal geteilt. Ein Download ist weder Versand noch Herausgabenachweis.

`MandateArtifact` bindet Quellen-/Freigabehash, Generatorversion, Manifest und Ausgabefassung. `persistResumableDocumentUpload` schreibt über dasselbe Uploadjournal; Wiederholung setzt einen unvollständigen Intent fort. Downloads lesen gespeicherte Bytes und prüfen weiterhin Quellenverfügbarkeit, Zugriffsrechte und Schutzklasse. Restriktive Dokument-RLS hält diese Grenzen auch auf generischen Downloadwegen ein. FK-getriebene Nullsetzung nach tatsächlicher GwG-Vernichtung verhindert blockierte Vernichtungsabläufe; die Ausgabe wird anschließend nicht rekonstruiert. Ergänzende Migrationen: `20260831180000_mandate_artifacts`, `20260831200000_mandate_history_integrity`.

Der separate Abschluss bestätigt sowohl den unveränderten Aktenstand als auch den im Browser angezeigten Freigabehash. Ein zwischenzeitlich geänderter Empfänger, Vermerk oder eine neue Auswahl verlangt erneutes Laden und Prüfen. Strukturknoten und -kanten entstehen ausschließlich atomar mit ihrer Version; `20260831260100_structure_version_seal` verhindert spätere Ergänzungen in historische Versionen und Lesewege vergleichen den Quellenhash erneut.

Fristen bleiben offen, bis sie im zuständigen Fachmodul bearbeitet werden. Bestehende GwG-/DSGVO-Retention nutzt weiterhin das Mandatsende; Dokumentfristen werden nicht pauschal neu gestartet. Keine automatische Löschung, keine allgemeine Löschfreigabe und keine neue allgemeine Legal-Hold-Engine. Individuelle Ausnahmen gehören in den Prüfvermerk und in die organisatorische Wiedervorlage.

## VDB (`vdbPreparation`)

`VDB-PREPARATION-001`: Vorbereitungs- und externe Nachweiszustände sind vom technischen Vollmachtsstatus getrennt. Ein verlaufsweiser Datensatz enthält Revision, Nachweisdatum, Erläuterung, externe Referenz und für externe Zustände eine saubere Dokumentfassung desselben Mandanten. Erwartete Revision und Zeilensperre verhindern verlorene Aktualisierungen.

Es gibt keine implementierte autorisierte Importformatspezifikation und deshalb keinen XML-/CSV-Export, keine Übermittlung und keine automatische Behördenabfrage. Die Oberfläche nennt diese Grenze sichtbar. Weitere Schnittstellenarbeit benötigt eine konkrete zulässige Meldestrecke und belegte Spezifikation.

## Prüfung und Betrieb

Gezielte Tests: `apps/web/src/server/mandate-expansion/__tests__`. Sie prüfen Daten-/Zugriffsgrenzen, Zyklen, Revisionen, unabhängige VDB-Zustände, Kalenderdaten und echte PDF-Ausgabe. Die Migration und vorhandene PostgreSQL-Integritätsprüfungen müssen vor Freischaltung ausgeführt werden. Die Tabellen erweitern personenbezogene Arbeitssnapshots; automatische Löschung/Anonymisierung dieser zusätzlichen Nachweise ist nicht zugesagt und bedarf einer eigenen fachlichen Aufbewahrungsentscheidung. Keine Regel erhielt eine KI-generierte fachliche Freigabe.
