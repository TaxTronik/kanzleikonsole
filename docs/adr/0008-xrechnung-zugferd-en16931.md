# ADR 0008 — XRechnung 3.0.2 + ZUGFeRD/Factur-X (EN 16931)

**Status**: Akzeptiert (Iteration 5b)
**Datum**: 2026-05-10
**Kontext**: Ab 2025 sind elektronische Rechnungen im B2B-Bereich in
Deutschland Pflicht. Empfänger müssen sie verarbeiten können, Sender
sollten sie ausstellen können. Pure-PDFs ohne strukturierte Daten sind
keine konformen E-Rechnungen mehr.

## Entscheidung

Zwei Export-Formate, beide aus denselben Daten:

1. **XRechnung 3.0.2** (CII-XML pur)
   - Profil-ID: `urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0`
   - Endpoint: `/api/staff/invoices/[id]/xrechnung`
   - Verwendung: B2G (öffentliche Auftraggeber), Maschine-zu-Maschine
2. **ZUGFeRD/Factur-X** (Hybrid-PDF + eingebettete CII-XML; derzeit ohne
   Zusage einer strikt validierten PDF/A-3-Datei)
   - Profil: EN 16931
   - Endpoint: `/api/staff/invoices/[id]/zugferd`
   - Generator: pdf-lib mit
     `doc.attach(...factur-x.xml..., AFRelationship.Alternative)`
   - Verwendung: B2B-Standardfall, weil PDF auch human-readable ist

Verkäufer-Stammdaten (Name, Adresse, USt-ID, IBAN/BIC, Bank) liegen in
`tenant_setting.invoicing.seller` (JSON). UI: `/staff/admin/settings`.
Empfänger-Stammdaten in `client` (Migration `20260520`).

## Konsequenzen

**Vorteile**

- Beide Formate nutzen dieselbe fachliche Datenbasis und gemeinsame
  CII-Generierungslogik; die getrennten Archivfassungen müssen aus demselben
  fachlichen Snapshot erzeugt werden
- Server-side, kein User-Eingriff: Bei DRAFT sind Direktdownloads flüchtige,
  nicht archivierte Kontrollfassungen. Die maßgebliche Archivfassung wird beim
  Versand aus einem gemeinsamen PDF-/XML-Snapshot einmalig erzeugt; bei
  bereits ausgestellten Altbeständen ganz ohne Archiv geschieht dies
  ersatzweise beim ersten Direktdownload aus den dann verfügbaren Rechnungs-
  und Stammdaten. Danach streamen Downloads die byte-stabil archivierte
  Fassung. Existiert bei einem Altbestand schon die archivierte Hybrid-PDF,
  aber noch keine separate XML, wird `factur-x.xml` aus genau dieser PDF
  extrahiert statt aus heutigen Stammdaten neu erzeugt.
- Einheitencodes laut UN/CEFACT (unter anderem
  HUR/DAY/MON/KGM/MTR/LTR/LS/C62)
- EN-16931-Steuerkategorien `S` (positive Sätze einschließlich 19 %/7 %),
  `Z` (Nullsatz), `E` (steuerbefreit mit Befreiungsgrund) und `AE`
  (Reverse Charge) werden je Steuergruppe erzeugt

**Nachteile**

- ZUGFeRD-PDF ist nicht streng PDF/A-3-validiert (würde Ghostscript-
  Postprocessing brauchen). Für die meisten Empfänger dennoch akzeptabel,
  weil die XML korrekt eingebettet ist und die XMP-Metadaten Factur-X
  deklarieren.
- Pflichtfeld-Validierung vor Vorschau- und Archiv-Erzeugung (422 in der
  Downloadroute beziehungsweise Versandabbruch bei unvollständigen Daten) —
  nicht bereits beim Speichern der Rechnung, damit unvollständige Entwürfe
  möglich bleiben.

## Alternativen verworfen

- Nur XRechnung-XML (B2B will PDF zum Lesen)
- Externes SaaS (z. B. Mosaicon) — Datenflüsse personenbezogener Daten zu
  Externen, DSGVO-Aufwand zu hoch
- ZUGFeRD 1.0 (BASIC) — veraltet, wird ab 2027 nicht mehr akzeptiert
