# Lizenzschlüssel-Verifikation

taxtronik prüft beim Start (und alle 60 Minuten) einen optionalen
Lizenzschlüssel. Verhalten:

| Status | Bedeutung | Auswirkung |
|---|---|---|
| `VALID` | Token gültig, nicht abgelaufen | grünes Banner im Admin-Bereich |
| `EXPIRED` | Signatur ok, aber `exp` < jetzt | gelbes Warn-Banner, App läuft weiter |
| `INVALID` | Signatur falsch / Token kaputt | rotes Banner |
| `UNCONFIGURED` | Kein Token oder Public-Key konfiguriert | grauer Hinweis |

> **Kein Hard-Stop bei abgelaufener Lizenz.** Eine On-Premise-Software, die
> sich selbst abschaltet, wenn die Lizenz abläuft, ist ein Albtraum für den
> Kunden. Stattdessen prominent sichtbar im Admin-Bereich.

## Token-Format

Signiertes JWT mit Algorithmus `EdDSA` (Ed25519). Custom-Claims:

```json
{
  "sub": "tenant-slug",
  "kanzleiName": "Steuerkanzlei Müller GmbH",
  "plan": "STANDARD",
  "maxStaff": 50,
  "maxClients": 500,
  "iat": 1747000000,
  "exp": 1778536000
}
```

`maxStaff` und `maxClients` sind aktuell nur informativ (keine harte
Durchsetzung) — werden im Admin-Bereich angezeigt.

## Setup

### Variante 1: Eigene Lizenz für eine einzelne Installation

```bash
pnpm tsx scripts/license-keygen.ts \
  --kanzlei "Steuerkanzlei Müller GmbH" \
  --slug muller \
  --plan STANDARD \
  --days 365
```

Ausgabe enthält:

- `LICENSE_PUBLIC_KEY` — in die `.env` der Kunden-Installation
- `LICENSE_PRIVATE_KEY` — sicher beim Lizenzgeber verwahren
- `LICENSE_KEY` — das JWT, ebenfalls in die `.env` der Kunden-Installation

### Variante 2: Zentraler Lizenz-Server (für Anbieter mit mehreren Kunden)

1. Einmal `pnpm tsx scripts/license-keygen.ts ...` für Public/Private-Pair
2. Public-Key in alle Releases einbauen (z. B. via Build-Time-Env `LICENSE_PUBLIC_KEY`)
3. Eigenen Lizenz-Server bauen, der pro Kunde mit dem Private-Key signiert
4. Tokens an Kunden ausliefern, die sie in ihre `.env` als `LICENSE_KEY` eintragen

## .env-Beispiel

```env
LICENSE_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA...\n-----END PUBLIC KEY-----"
LICENSE_KEY="eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJzdWI..."
```

(`\n` als Literal — `process.env` löst die Escape-Sequenzen auf.)

## Cache + Reload

Der Lizenz-Status wird im Web-Prozess gecacht (60 min). Nach Update des
`LICENSE_KEY` muss der Web-Prozess neu gestartet werden, damit der neue
Status greift — alternativ Cache-Invalidierung per Code-Aufruf
`invalidateLicenseCache()`.

## Sicherheitshinweise

- **Public-Key** im Image einbetten (z. B. via Docker-Build-Arg). Wenn der
  Public-Key per ENV überschreibbar ist, kann ein Angreifer mit Root-Zugriff
  auf den Server seinen eigenen Schlüssel setzen und beliebige Tokens
  ausstellen — was im Single-Server-On-Premise-Modell aber egal ist (er
  hat ohnehin Vollzugriff).
- **Private-Key** niemals neben einer Anbieter-Installation, niemals in
  Git, niemals unverschlüsselt auf einem Web-Server.
- **Token-Replay** ist nicht relevant, da der Token statisch ist und
  beim Kunden liegt — die Verifikation prüft nur die Signatur.
