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

Die Auth-Tests in `02-auth.spec.ts` laufen im CI mit `DEV_SKIP_TOTP=true` und
sind dort Pflichtbestandteil der Paranoid-Suite. Lokal ohne `DEV_SKIP_TOTP`
brauchen sie das **TOTP-Secret** des Admin-Users. Beim allerersten Login im UI
bekommst du dieses Secret unter dem QR-Code zu sehen — kopiere es und setze:

```powershell
$env:E2E_TOTP_SECRET = "JBSWY3DPEHPK3PXP"  # Beispiel
```

Wenn nicht gesetzt, muss lokal `DEV_SKIP_TOTP=true` aktiv sein.

## Konfiguration via ENV

| Variable             | Default                                               |
| -------------------- | ----------------------------------------------------- |
| `E2E_BASE_URL`       | `http://localhost:3000`                               |
| `E2E_ADMIN_EMAIL`    | `admin@taxtronik.local`                               |
| `E2E_ADMIN_PASSWORD` | `dev-password-123`                                    |
| `E2E_TOTP_SECRET`    | (leer, wenn `DEV_SKIP_TOTP=true`; sonst erforderlich) |

## CI-Guard

`scripts/check-paranoid-e2e.sh` erzwingt, dass jede `apps/e2e/tests/*.spec.ts`
im Forgejo-Workflow verdrahtet ist und dass die E2E-Suite keine
`test.only`/`test.skip`/`test.fixme`-Marker enthält. Neue E2E-Specs sind damit
automatisch CI-pflichtig.

## Reports

Nach einem Lauf:

```bash
pnpm --filter @taxtronik/e2e report
```

öffnet den HTML-Report im Browser.

## Barrierefreiheit

`tests/12-accessibility.spec.ts` prüft zentrale öffentliche und angemeldete
Oberflächen mit Axe gegen WCAG 2.0/2.1/2.2 Level A und AA. Zusätzlich werden
Skip-Link und mobile Navigation per Tastatur getestet. Der Axe-Bericht wird je
Seite als JSON an den Playwright-Testbericht angehängt.

`tests/13-accessible-display.spec.ts` ergänzt den persönlichen Anzeigemodus:
Tastaturaktivierung, Server-Rendering, geräteübergreifende Persistenz nach
Anmeldung, getrennte Mitarbeiter-/Portalpräferenzen, Logout sowie Light/Dark-
und 320px-Stichproben. Avatar-Zentrierung und das offene Konto-Menü werden
zusätzlich bei 320 × 240 Pixeln in Staff und Portal geprüft, einschließlich
Scrollen, Tab/Shift+Tab, Pfeiltasten, Escape und Axe. Die Suite stellt die
ursprünglichen Einstellungen der Dev-Seed-Profile anschließend wieder her.
`tests/14-dashboard-keyboard.spec.ts` prüft die alternativen Layout-Eingaben
von Dashboard und Portal-Layouteditor mit abgefangenen Speicherrequests;
`tests/15-search-notifications-a11y.spec.ts` prüft lange Such-/Benachrichtigungslisten,
Fokus und Toast-Lesezeiten mit lokalen GET-Fixtures. Der Profilmodus-Test
deckt zusätzlich individuelle Optionen, Rücksetzen und Fehler-Rollback ab.
`pnpm a11y:e2e` führt alle vier Suiten aus.

Diese automatisierten Prüfungen erkennen nur einen Teil möglicher Barrieren.
Sie ersetzen insbesondere keine manuelle Tastatur-, Screenreader-, Reflow- und
Kontrastprüfung.

Bei A11Y-Stichproben auf einem gemeinsam genutzten lokalen Dev-Stack kann
`E2E_PRESERVE_SHARED_SERVICES=true` gesetzt werden. Dann leeren die Login-Helfer
weder Redis (einschließlich Worker-/Signal-Warteschlangen) noch MailHog.
Authentisierung, Seitenprüfungen und Assertions werden nicht übersprungen;
Rate-Limits bleiben aktiv. Die Profiltests ändern weiterhin gezielt die
Seed-Profilpräferenzen und stellen sie anschließend wieder her. Für den
vollständigen CI-Lauf sind isolierte Services ohne diese Option vorgesehen.
Bei schnellen lokalen Nachläufen können die unveränderten Grenzen von einem
Magic-Link je Minute und fünf Anfragen je 15 Minuten greifen. Betroffene
Browserfälle erst nach Ablauf erneut starten; die Limits nicht für UI-Tests
abschalten. Der schonende Modus ist deshalb kein Ersatz für einen isolierten
CI-Lauf.

Lokal liest der Staff-Login zuerst explizite `E2E_ADMIN_*`-Variablen und sonst
die vom Dev-Seed erzeugte, gitignorierte
`packages/db/.admin-credentials.txt`. Das Passwort wird nicht in den
Testbericht geschrieben. In CI haben die gesetzten Umgebungsvariablen Vorrang.
