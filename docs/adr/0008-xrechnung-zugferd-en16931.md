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
2. **ZUGFeRD/Factur-X** (Hybrid PDF/A-3 + eingebettete CII-XML)
   - Profil: EN 16931
   - Endpoint: `/api/staff/invoices/[id]/zugferd`
   - Generator: pdf-lib mit `doc.attach(...factur-x.xml..., AFRelationship.Source)`
   - Verwendung: B2B-Standardfall, weil PDF auch human-readable ist

Verkäufer-Stammdaten (Name, Adresse, USt-ID, IBAN/BIC, Bank) liegen in
`tenant_setting.invoicing.seller` (JSON). UI: `/staff/admin/settings`.
Empfänger-Stammdaten in `client` (Migration `20260520`).

## Konsequenzen

**Vorteile**

- Beide Formate aus einer Datenquelle (keine Drift möglich)
- Server-side, kein User-Eingriff (Datei wird beim Klick generiert)
- Tax-Codes laut UN/CEFACT (HUR/DAY/MON/KGM/MTR/LS/C62)

**Nachteile**

- ZUGFeRD-PDF ist nicht streng PDF/A-3-validiert (würde Ghostscript-
  Postprocessing brauchen). Für die meisten Empfänger dennoch akzeptabel,
  weil die XML korrekt eingebettet ist und die XMP-Metadaten Factur-X
  deklarieren.
- Aktuell nur Standardsteuersatz (CategoryCode `S`) — `Z`/`E`/`K` für
  steuerbefreite oder innergemeinschaftliche Lieferungen folgt bei Bedarf
- Pflichtfeld-Validierung beim Download (422 bei unvollständiger Adresse) —
  alternative: Validation beim Speichern der Rechnung. Aktuell weicher,
  damit Entwürfe ohne Adresse möglich sind.

## Alternativen verworfen

- Nur XRechnung-XML (B2B will PDF zum Lesen)
- Externes SaaS (z. B. Mosaicon) — Datenflüsse personenbezogener Daten zu
  Externen, DSGVO-Aufwand zu hoch
- ZUGFeRD 1.0 (BASIC) — veraltet, wird ab 2027 nicht mehr akzeptiert
