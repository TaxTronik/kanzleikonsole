# Security Policy

## Unterstützte Versionen

Nur die jeweils neueste veröffentlichte stabile Version wird mit
Sicherheits-Updates versorgt. Der `main`-Branch ist Entwicklungsstand und keine
unterstützte Produktversion. Ältere Releases werden nicht gepatcht — Anwender
müssen auf den aktuellen Release aktualisieren.

## Sicherheitslücke melden

Bitte **keine** Sicherheitslücken öffentlich als Issue melden.

Stattdessen per E-Mail an:

**security@taxtronik.de**

Transportverschlüsselung erfolgt über den empfangenden Mailserver. Einen
veröffentlichten PGP-Meldeschlüssel gibt es derzeit nicht; sensible Anhänge
bitte erst nach der Eingangsbestätigung und Kanalabstimmung senden.

### Was gehört in die Meldung?

- Betroffene Komponente (Web-App, Worker, n8n, Infra, …)
- Schritt-für-Schritt-Beschreibung zur Reproduktion
- Angenommene Auswirkung (Datenabfluss, Privilegien-Eskalation, …)
- Optional: Vorschlag zur Behebung

### Was passiert nach der Meldung?

1. Eingangsbestätigung innerhalb von **2 Werktagen**.
2. Triage und ggf. Rückfragen innerhalb von **5 Werktagen**.
3. Fix-Entwicklung; bei kritischen Lücken wird ein Hotfix-Release
   außerhalb des normalen Release-Zyklus erstellt.
4. Veröffentlichung eines Security Advisory mit CVE-Beantragung
   (sofern anwendbar), abgestimmt mit dem Melder.
5. Credit im Advisory, sofern vom Melder gewünscht.

### Scope

TaxTronik ist für den On-Premise-Betrieb pro Kanzlei ausgelegt. Der
Sicherheits-Scope umfasst:

- Die Anwendung selbst (Web-App, Worker, n8n-Workflows)
- Die Docker-Compose-Infrastruktur
- Die Dokumentation (keine sicherheitskritischen Fehlinformationen)
- Den Update-Mechanismus (Manifest-Signaturen, Registry-Images)

**Nicht** im Scope (liegen in Betreiberverantwortung):

- Die konkrete Server-Härtung des Betreibers
- Firewall- und Netzwerk-Konfiguration
- TLS-Zertifikate und Reverse-Proxy-Setup
- Physische Sicherheit des Servers

## Sicherheitsrelevante Konfiguration

TaxTronik setzt zwingend voraus:

- `AUTH_SECRET`: mindestens 32 Zeichen, zufällig generiert (siehe `./taxtronik bootstrap` bzw. `scripts/setup.sh`)
- `SECRET_BOX_KEY`: eigener, mindestens 32 Zeichen langer Schlüssel für
  gespeicherte Integrations-Secrets; bei Neuinstallationen automatisch erzeugt
  und getrennt vom `AUTH_SECRET` zu sichern
- `DATABASE_APP_URL`: separater, RLS-beschränkter DB-Nutzer — in Produktion **Pflicht**
- `N8N_HMAC_SECRET`: mindestens 32 Zeichen
- TLS via Reverse Proxy vor der App (Ports nur an localhost)

Siehe `.env.example` für alle sicherheitsrelevanten Umgebungsvariablen und
`docs/compliance/auth-secret-rotation.md` für das Rotationsverfahren bei
kompromittiertem `AUTH_SECRET`.

## Secure by Design

TaxTronik verfolgt eine Defence-in-Depth-Strategie. Die wichtigsten
Sicherheitsarchitekturen sind in den Architecture Decision Records dokumentiert:

- **ADR-0002**: Multi-Tenant via RLS + App-Level-Filter
- **ADR-0003**: Zwei Auth-Surfaces (Staff + Portal), getrennte Cookies
- **ADR-0004**: Manipulationsnachweis via Audit-Hash-Chain + RFC-3161
- **ADR-0005**: Storage: SeaweedFS + Object-Lock + ClamAV
- **ADR-0010**: Session-Strategie und Cookie-Scope

Details: `docs/architecture.md`
