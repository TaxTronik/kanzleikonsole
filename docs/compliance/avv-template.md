# AVV-Vorlage (Auftragsverarbeitungsvertrag nach Art. 28 DSGVO)

Stand: 2026-05-14

Diese Vorlage hilft der Kanzlei beim Abschluss von Auftragsverarbeitungs-
verträgen mit Anbietern, die im Auftrag der Kanzlei personenbezogene Daten
ihrer Mandanten verarbeiten. Sie ist kein Rechtsbeistand — vor Verwendung
durch einen Rechtsanwalt prüfen lassen.

---

## Wer braucht einen AVV?

Jeder externe Dienstleister, der **personenbezogene Daten** der Kanzlei (oder
ihrer Mandanten) im Auftrag verarbeitet. Typische Fälle:

| Dienstleister                                     | Typischer Prüfpunkt                          | Hinweise für die Einzelfallprüfung                                                                        |
| ------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Hosting-Provider (Hetzner, IONOS, AWS, …)         | regelmäßig Art. 28 prüfen                    | Speichert oder administriert DB und Object-Store                                                          |
| Backup-Off-Site-Provider (Wasabi, Borg-Repo, …)   | regelmäßig Art. 28 prüfen                    | Auch verschlüsselte Backups bleiben für die Kanzlei personenbezogene Daten                                |
| SMTP-Provider (Sendgrid, Postmark, IONOS-Mail, …) | regelmäßig Art. 28 prüfen                    | Verarbeitet Empfängeradressen und gegebenenfalls Mail-Inhalte                                             |
| TSA-Provider (D-Trust, SwissSign, …)              | Rolle und übermittelte Daten prüfen          | Hashwerte allein schließen einen Personenbezug im konkreten Kontext nicht automatisch aus                 |
| externer QES-/Signatur-Provider, falls eingesetzt | regelmäßig Art. 28 und weitere Rollen prüfen | Kann Identitäts- und Signaturnachweise verarbeiten; TaxTronik selbst integriert derzeit keinen QES-Dienst |
| n8n (lokaler Container im Compose-Stack)          | kein eigener externer Anbieter               | Externe Administration oder externes Hosting gesondert bewerten                                           |
| n8n.cloud / externer n8n-Server                   | regelmäßig Art. 28 prüfen                    | Workflow-Daten können personenbezogene Inhalte enthalten                                                  |
| DATEV, Addison oder externe Buchhaltung           | Rolle vertragsspezifisch prüfen              | Keine pauschale Einordnung; Leistung, Weisungsbindung und Eigenverantwortung sind entscheidend            |
| externes Pen-Test-Unternehmen                     | Zugriff und Rolle prüfen                     | Möglichst Testdaten verwenden; Live-Datenzugriff, Weisungen und Geheimnisschutz vertraglich regeln        |

Die Tabelle ist keine abschließende rechtliche Einordnung. Entscheidend sind
die konkrete Leistung, die tatsächlichen Datenzugriffe und die Rollen der
Beteiligten; neben der DSGVO sind insbesondere die berufsrechtlichen
Verschwiegenheitspflichten zu berücksichtigen.

## Pflichtelemente eines AVV (Art. 28 Abs. 3 DSGVO)

Jeder AVV MUSS folgende Punkte enthalten:

1. **Gegenstand, Dauer, Art und Zweck** der Verarbeitung
2. **Art der personenbezogenen Daten** und Kategorien betroffener Personen
3. **Weisungsgebundenheit** (Art. 28 Abs. 3 lit. a)
4. **Vertraulichkeitspflicht** der Mitarbeiter (Art. 28 Abs. 3 lit. b)
5. **Technische und organisatorische Maßnahmen** (Art. 32 DSGVO)
6. **Subauftragsverarbeiter** — Genehmigung + Information bei Wechsel
7. **Unterstützung bei Betroffenenrechten** (Art. 12–22 DSGVO)
8. **Unterstützung bei Datenschutz-Pflichten** (Art. 32–36 DSGVO)
9. **Löschung/Rückgabe** der Daten am Vertragsende
10. **Nachweis-/Audit-Rechte** des Verantwortlichen
11. **Information bei Datenschutzverletzungen** (Art. 33 DSGVO)

## Minimum-AVV-Skelett

> ⚠ Anwaltliche Prüfung vor Unterschrift erforderlich. Dieses Skelett ist
> ein Startpunkt, keine fertige Vertragsversion.

```
Auftragsverarbeitungsvertrag (AVV)
nach Art. 28 DSGVO

zwischen

[Kanzlei-Name]
[Kanzlei-Adresse]
— nachfolgend „Auftraggeber" oder „Verantwortlicher" —

und

[Anbieter-Name]
[Anbieter-Adresse]
— nachfolgend „Auftragnehmer" oder „Auftragsverarbeiter" —

§ 1 Gegenstand und Dauer
(1) Der Auftragnehmer erbringt für den Auftraggeber folgende Leistung:
    [konkrete Beschreibung, z. B. „Hosting eines taxtronik-Produktiv-Stacks
    in Docker-Compose, inklusive Postgres-Datenbank, SeaweedFS-Storage und
    Redis-Cache"].
(2) Dauer: ab [Datum], laufzeitgleich mit dem Haupt-Dienstvertrag.

§ 2 Art und Zweck der Verarbeitung; betroffene Personen
(1) Art der Verarbeitung: Speichern, Erheben, Organisieren, Abrufen.
(2) Zweck: Bereitstellung der technischen Infrastruktur für die
    Steuerberatungs-Software „taxtronik".
(3) Betroffene Personen:
    - Mitarbeiter der Kanzlei
    - Mandanten der Kanzlei (natürliche Personen, einzelne und vertretende
      Personen juristischer Personen)
    - Kontakt­personen bei Mandanten
(4) Art personenbezogener Daten:
    - Stammdaten (Name, Anschrift, Geburtsdatum, USt-ID)
    - GwG-Identifizierungsdaten (Ausweisbilder, wirtschaftlich Berechtigte)
    - Steuer-/Buchhaltungsdaten (Belege, Bescheide, Vollmachten)
    - Kommunikations-Metadaten (Login-IPs, Audit-Trails)

§ 3 Weisungsgebundenheit
Der Auftragnehmer verarbeitet die Daten ausschließlich auf dokumentierte
Weisung des Auftraggebers. Weisungen sind in Textform zu erteilen.

§ 4 Technische und organisatorische Maßnahmen
Der Auftragnehmer trifft die in Anlage 1 beschriebenen Maßnahmen
(Art. 32 DSGVO).

§ 5 Vertraulichkeit, Verschwiegenheit
Der Auftragnehmer verpflichtet sein mit der Verarbeitung beauftragtes
Personal schriftlich auf die Vertraulichkeit, soweit es nicht bereits einer
gesetzlichen Verschwiegenheitspflicht unterliegt.

§ 6 Subauftragsverarbeiter
(1) Die in Anlage 2 gelisteten Subauftragsverarbeiter sind genehmigt.
(2) Vor jedem Wechsel/Hinzufügen informiert der Auftragnehmer den
    Auftraggeber mind. 30 Tage im Voraus.

§ 7 Mitwirkung bei Betroffenenrechten
Der Auftragnehmer unterstützt den Auftraggeber bei der Beantwortung von
Anfragen nach Art. 15–22 DSGVO innerhalb von 5 Werktagen.

§ 8 Meldung von Datenschutzverletzungen
Der Auftragnehmer informiert den Auftraggeber unverzüglich, spätestens
24 Stunden nach Bekanntwerden einer Verletzung des Schutzes
personenbezogener Daten.

§ 9 Löschung / Rückgabe nach Vertragsende
Nach Vertragsende werden alle Daten:
[ ] vollständig gelöscht (Default)
[ ] auf Datenträger zurückgegeben (auf Anforderung)
Protokollierte Vernichtung mit schriftlichem Nachweis.

§ 10 Nachweis- und Audit-Rechte
(1) Der Auftraggeber hat das Recht, die Einhaltung dieses Vertrags durch
    Inspektion vor Ort oder durch beauftragte Prüfer zu kontrollieren.
(2) Der Auftragnehmer kann sich auf ein aktuelles Zertifikat (ISO 27001,
    BSI C5) oder einen anerkannten Verhaltenskodex berufen.

Ort, Datum                              Ort, Datum
__________________                      __________________
Auftraggeber                            Auftragnehmer
```

## Anlagen

- **Anlage 1**: TOM (Technische und organisatorische Maßnahmen) des
  Auftragnehmers. Sollte enthalten:
  - Zugangs-/Zutritts-/Zugriffs-Kontrolle
  - Verschlüsselung at-rest und in-transit
  - Pseudonymisierung soweit möglich
  - Auftragskontrolle, Verfügbarkeitskontrolle, Trennungs­kontrolle
  - Regelmäßige Überprüfung
- **Anlage 2**: Liste der genehmigten Sub-Auftragsverarbeiter
  (z. B. AWS für S3-Backups, Cloudflare für DNS).

## Hosting-Provider-Spezialfall

Wenn der Hosting-Provider AUSSCHLIESSLICH Infrastruktur (VM, Network,
Storage) bereitstellt und keinen Anwendungs-Zugriff hat (verschlüsselte
Volumes, eigenes Schlüssel-Management beim Kunden), liegt theoretisch
„technisch-organisatorische Verfügbarkeit, keine AV" vor (BSI / DSK-
Auslegung). Praxis: trotzdem AVV abschließen, weil:

- Hosting-Mitarbeiter könnten in Notfällen Zugriff bekommen.
- Restore aus Hosting-Backup ist eine Auftragsverarbeitung.
- AVV ist günstig zu haben und beseitigt Streitpunkt im DSGVO-Audit.

## Off-Site-Backup-Spezialfall

Falls verschlüsselte Backups mit kundenseitiger Schlüssel-Verwaltung
(borg/restic/duplicity) zu einem reinen Storage-Provider (Wasabi, S3
Glacier) gehen, ist die Rollen- und Vertragsprüfung nicht allein wegen der
Verschlüsselung entbehrlich. Der Provider speichert die Daten im Auftrag; die
Verschlüsselung ist dabei eine wichtige technische Schutzmaßnahme. Ob und in
welcher Form Art. 28 DSGVO greift, ist für den konkreten Dienst zu prüfen.
