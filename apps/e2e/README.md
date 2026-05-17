# taxtronik — E2E-Tests (Playwright)

End-to-End-Tests gegen die laufende App.

## Voraussetzungen

- Dev-Stack läuft auf <http://localhost:3000> (`pnpm dev` im Repo-Root)
- Postgres geseedet (`pnpm db:seed`)

## Setup

```bash
pnpm install
pnpm --filter @taxtronik/e2e install:browsers
```

## Tests ausführen

```bash
# Smoke-Tests (kein Login erforderlich)
pnpm --filter @taxtronik/e2e test

# Mit UI (interaktiv)
pnpm --filter @taxtronik/e2e test:ui

# Headed (Browser sichtbar)
pnpm --filter @taxtronik/e2e test:headed
```

## Auth-Tests

Die Auth-Tests in `02-auth.spec.ts` brauchen das **TOTP-Secret** des Admin-Users.
Beim allerersten Login im UI bekommst du dieses Secret unter dem QR-Code zu
sehen — kopiere es und setze:

```powershell
$env:E2E_TOTP_SECRET = "JBSWY3DPEHPK3PXP"  # Beispiel
```

Wenn nicht gesetzt, werden diese Tests übersprungen.

## Konfiguration via ENV

| Variable | Default |
|---|---|
| `E2E_BASE_URL` | `http://localhost:3000` |
| `E2E_ADMIN_EMAIL` | `admin@taxtronik.local` |
| `E2E_ADMIN_PASSWORD` | `dev-password-123` |
| `E2E_TOTP_SECRET` | (leer — Auth-Tests werden übersprungen) |

## Reports

Nach einem Lauf:

```bash
pnpm --filter @taxtronik/e2e report
```

öffnet den HTML-Report im Browser.
