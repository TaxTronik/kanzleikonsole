# Fachkatalog

Der Fachkatalog macht steuerliche, rechtliche und kanzleifachliche Logik in
TaxTronik regelweise prüfbar. Er richtet sich zuerst an Berufsträger und
fachliche Verantwortliche; technische Nachweise stehen bewusst am Ende jeder
Regel.

> **Wichtig:** Der Katalog ist eine versionierte Prüf- und
> Verständigungshilfe. Er ersetzt weder die rechtliche Einzelfallprüfung noch
> die organisatorische Fristenkontrolle der Kanzlei. Der Status `approved`
> dokumentiert eine eingetragene fachliche Freigabe. Er authentifiziert die
> prüfende Person erst zusammen mit geschützten Branches und Berufsträger-
> CODEOWNERS oder einer gleichwertig signierten Attestation.

Die [Abdeckungsmatrix](SCOPE.md) grenzt die derzeit inventarisierte
Produktlogik von ausdrücklich nicht abgedeckten Rechts- und
Organisationsfragen ab. Die daraus erzeugten Regeln bilden den ermittelten
Programmstand ab, sind aber ausnahmslos noch **ungeprüfte Entwürfe**. Damit ist
nicht behauptet, dass ein Berufsträger die zugrunde liegende Rechtsauffassung
bereits bestätigt hat.

## In zehn Minuten fachlich prüfen

1. Im [Regelindex](INDEX.md) nach Fachbereich und Status filtern.
2. In der Regel zuerst **Kurzfassung**, **Entscheidungslogik**, **Ausnahmen**
   und **Beispiele** lesen.
3. Die **fachlichen Prüffragen** beantworten und Quellen gegen den für den
   Sachverhalt maßgeblichen Rechtsstand prüfen.
4. Abweichungen oder fehlende Fälle direkt in der Regel dokumentieren.
5. Die Freigabe nach dem [organisatorischen Fachreview-Ablauf](BEITRAGEN.md)
   eintragen. Autor und Freigebender müssen unterschiedliche Personen sein;
   ohne die unten beschriebene Repository-Governance erzwingt das Werkzeug
   diese Trennung technisch noch nicht. Eine KI oder ein rein technischer
   Review darf keine fachliche Freigabe erteilen.

## Zwei getrennte Wahrheitsachsen

| Achse                           | Bedeutung                                                                                |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| **Fachlicher Prüfstatus**       | Wurde die Regel inhaltlich durch einen Berufsträger geprüft und freigegeben?             |
| **Technischer Umsetzungsstand** | Entspricht die laufende Software dieser beschriebenen Regel und gibt es dafür Nachweise? |

### Fachlicher Prüfstatus

| Maschinenwert | Anzeige               | Aussage                                                                                              |
| ------------- | --------------------- | ---------------------------------------------------------------------------------------------------- |
| `unreviewed`  | Ungeprüfter Entwurf   | Noch keine fachliche Prüfung; keine Freigabe.                                                        |
| `in_review`   | In fachlicher Prüfung | Prüfung läuft; offene Fragen können bestehen.                                                        |
| `approved`    | Freigabe dokumentiert | Person, Prüfdatum, Quelle und Hash sind eingetragen; die Identität braucht einen separaten Nachweis. |
| `superseded`  | Abgelöst              | Historischer Eintrag; die Nachfolgeregel ist unter „Verwandte Regeln“ verknüpft.                     |

### Technischer Umsetzungsstand

| Maschinenwert     | Anzeige                | Aussage                                                               |
| ----------------- | ---------------------- | --------------------------------------------------------------------- |
| `not_assessed`    | Nicht erhoben          | Der Programmstand wurde noch nicht mit der Regel abgeglichen.         |
| `not_implemented` | Nicht umgesetzt        | Die Regel ist dokumentiert, aber im Produkt nicht vorhanden.          |
| `partial`         | Teilweise umgesetzt    | Ein abgegrenzter Teil fehlt; die Grenze steht sichtbar in der Regel.  |
| `implemented`     | Umgesetzt und getestet | Code- und Testnachweise sind vorhanden.                               |
| `deviates`        | Weicht ab              | Der Programmstand widerspricht der Regel; die Abweichung ist benannt. |
| `not_applicable`  | Nicht anwendbar        | Die Regel beschreibt keine Produktfunktion.                           |

„Umgesetzt und getestet“ ist keine Aussage über die fachliche Richtigkeit.
Diese entsteht ausschließlich über die andere Achse.

## Arten fachlicher Aussagen

- `statute`: gesetzliche Regel; Normtext und fachliche Auslegung bleiben zu
  unterscheiden.
- `administrative_guidance`: Verwaltungsanweisung oder amtliche
  Anwendungshilfe.
- `technical_standard`: externer technischer oder fachtechnischer Standard.
- `professional_interpretation`: dokumentierte fachliche Auslegung für den
  beschriebenen Anwendungsbereich.
- `office_policy`: organisatorische Entscheidung der Kanzlei.
- `product_rule`: bewusstes Verhalten von TaxTronik ohne Behauptung, dass es
  unmittelbar gesetzlich vorgegeben ist.

## Aufbau und Geltung

- Eine Markdown-Datei beschreibt genau eine entscheidbare Regel.
- [SCOPE.md](SCOPE.md) definiert die belastbare Vollständigkeitsgrenze des
  aktuellen Exports. „Vollständig“ bezieht sich ausschließlich auf die dort
  als in scope bezeichneten Produktentscheidungen, nicht auf ein Rechtsgebiet.
- Stabile IDs bleiben erhalten. Ändert sich der fachliche Gehalt für einen
  neuen Rechtsstand, wird eine Nachfolgeregel angelegt statt die Historie
  umzudeuten.
- `valid_from` und `valid_until` bezeichnen den fachlichen Geltungszeitraum,
  nicht das Git-Datum.
- Quellen werden mit Prüfdatum geführt. Die CI prüft Links nur syntaktisch;
  amtlich bezeichnete Quellen zusätzlich gegen eine enge Domain-Allowlist.
  Die inhaltliche Aktualität bestätigt weiterhin der fachliche Review.
- Das JSON-Schema unterstützt Editoren bei der Struktur. Maßgeblich ist der
  CI-Validator, weil Inhalts-Hash, Repository-Pfade und weitere
  Querschnittsinvarianten nicht vollständig als JSON-Schema ausdrückbar sind.
- Code-, Test- und Dokumentpfade müssen im Repository existieren.
- Technisch nachgewiesene Regeln brauchen in mindestens einer referenzierten
  Testdatei den Marker `Fachkatalog: <REGEL-ID>`. Dadurch bleibt die behauptete
  Testzuordnung reviewbar.
- Eine Freigabe ist mit `reviewed_content_hash` an den geprüften Regelinhalt
  gebunden. Jede nachträgliche Inhaltsänderung macht die CI rot, bis die Regel
  zurück in Prüfung gesetzt oder erneut durch einen Berufsträger freigegeben
  wurde.
- Der Hash authentifiziert **nicht** die eingetragene Person. Eine belastbare
  Freigabe setzt zusätzlich geschützte Branches und eine auf Berufsträger
  beschränkte Review-/CODEOWNERS-Regel oder eine gleichwertig signierte
  Attestation voraus. Ohne diese Repository-Governance ist `approved` nur eine
  dokumentierte, technisch nicht identitätsgeprüfte Behauptung.
- [fachkatalog.json](fachkatalog.json) ist der kompakte, deterministisch
  erzeugte Suchindex für KI-Werkzeuge; [fachkatalog-voll.json](fachkatalog-voll.json)
  enthält zusätzlich den vollständigen Markdown-Regeltext jeder Regel. Beide
  Exporte führen die aktiven und reservierten Scope-IDs, Sollzahlen und den
  SHA-256-Wert der zugrunde liegenden Abdeckungsmatrix mit; der Volltext-Export
  bettet zusätzlich die Matrix selbst ein. [INDEX.md](INDEX.md) ist der
  entsprechende menschliche Einstieg.

Der Fachkatalog ist nicht mit dem fachlich anderen Signal-Begriffs- und
Normgraph-Katalog unter `release/catalog/` zu verwechseln.

## Pflege und Prüfung

Neue Regeln entstehen aus der [Vorlage](VORLAGE.md). Metadaten und Indizes
werden mit folgenden Befehlen geprüft:

```bash
pnpm fachkatalog:generate
pnpm fachkatalog:check
```

Die CI führt `pnpm fachkatalog:check` bei Pull Requests und Pushes auf `main`
oder `develop` aus; wiederverwendbare Release-Läufe können denselben Workflow
zusätzlich aufrufen. Das Gate verhindert unter anderem doppelte IDs, ungültige
Statuswerte, fehlende Pflichtabschnitte, tote lokale Nachweise und veraltete
Indizes.
Ein zusätzliches Diff-Gate verlangt bei Änderungen an den erfassten Steuer-,
Bescheid-, Fristen-, Rechnungs-, GwG-, Datenschutz-, Aufbewahrungs-,
Vollmachts-, Zugriffs- und Nachweispfaden eine konkret über
`code_refs`/`test_refs` zugeordnete geänderte Regel oder einen neuen,
strukturierten Eintrag in [AENDERUNGEN.md](AENDERUNGEN.md). Ein beliebiger
Katalogtext schaltet fremde Fachpfade nicht frei. Historische Regel-IDs und
Regeldateien müssen erhalten und bei Ablösung als `superseded` fortgeführt
werden.

## Abdeckung und Ausbau

Der inventarisierte Produkt-Scope, reservierte Lücken und die Reihenfolge für
weitere Regeln stehen in [SCOPE.md](SCOPE.md). Neue Funktionen oder
Rechtsgebiete erweitern diese Grenze nur durch eine ausdrückliche Änderung der
Matrix. Auch eine vollständig exportierte Matrix bleibt ohne Berufsträgerreview
fachlich ungeprüft.
