# taxtronik — E2E-Tests (Playwright)

End-to-End-Tests gegen die laufende App.

## Wichtig: NICHT Teil von `pnpm test`

E2E ist bewusst aus dem Standard-`pnpm test` ausgeklammert:

1. **Browser-Download** (~250 MB Chromium beim Erst-Lauf) ist zu schwer für jeden
   CI-Test-Lauf.
2. **Externe Voraussetzungen** — die Tests setzen den voll laufenden Stack
   (App + Postgres + Redis + SeaweedFS + ClamAV) und einen geseedeten Tenant
   voraus. Das ist kein Unit-Test-Setup.

Das `test`-Skript in `apps/e2e/package.json` ist deshalb ein No-Op, der nur
einen Hinweis druckt. Echter Lauf via `pnpm e2e` (Root) oder
`pnpm --filter @taxtronik/e2e e2e`.

## Voraussetzungen

- Dev-Stack läuft auf <http://localhost:3000> (`pnpm dev` im Repo-Root)
- Postgres geseedet (`pnpm db:seed`)

## Setup

Browser-Install passiert automatisch beim ersten `pnpm e2e`-Aufruf
(`playwright install chromium --with-deps`). Manuell:

```bash
pnpm --filter @taxtronik/e2e install:browsers
```

## Tests ausführen

```bash
# Vom Repo-Root:
pnpm e2e            # Headless, alle Specs
pnpm e2e:ui         # Interaktiv (Playwright-UI)

# Oder direkt im Workspace:
pnpm --filter @taxtronik/e2e e2e
pnpm --filter @taxtronik/e2e e2e:ui
pnpm --filter @taxtronik/e2e e2e:headed
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
