# AUTH_SECRET-Rotation und bekannte Schlüssel-Abhängigkeiten

Stand: 2026-05-14

`AUTH_SECRET` ist die zentrale 32-Byte-Geheimnis-Wurzel der taxtronik-
Installation. Diese Datei dokumentiert, **wo** der Wert hingeleitet wird,
und **wie** eine Rotation operativ aussieht — solange kein dediziertes
Rotations-Tooling existiert.

---

## Wo AUTH_SECRET verwendet wird

Alle drei Pfade nutzen HKDF mit unterschiedlichem `info`-Label
(Domain-Trennung) — ein Leak von AUTH_SECRET kompromittiert aber alle
gleichzeitig.

| Konsument | Derivation | Was wird geschützt |
|---|---|---|
| Auth.js JWT-Signing | `Auth.js intern, info=NextAuth-Generated-Encryption-Key` | Session-Token (24 h TTL nach W-1) |
| `@taxtronik/crypto` v2 secret-box (M-1) | `hkdfSync('sha256', secret, salt, info='taxtronik-secret-box-v2', 32)` | `tenant_setting.value`-Felder (SMTP-Passwörter, n8n-HMAC-Secrets, n8n-API-Keys) |
| TOTP-Encryption (`apps/web/src/server/auth/totp.ts`) | `hkdfSync('sha256', secret, salt=tenantId, info='taxtronik-totp', 32)` | `staff_user.totp_secret_enc` |

## Was bei Leak passiert

1. **JWT-Forgery**: Angreifer kann beliebige Session-Tokens signieren →
   vollständige Account-Übernahme jedes Staff/Portal-Users (max. 24 h
   bis zur natürlichen TTL-Expiry, oder sofort über `revokeAllSessions`
   wenn Operator den Vorfall bemerkt).
2. **Secret-Box-Decryption**: Alle in `tenant_setting` verschlüsselten
   Werte (SMTP-Passwörter, n8n-HMAC, …) lesbar.
3. **TOTP-Decryption**: Alle `totp_secret_enc` lesbar → Angreifer kennt
   die TOTP-Seeds und kann gültige Codes generieren. Backup-Codes-Hashes
   sind bcrypt-gehasht — nicht decrypt-bar, aber pro Code in vertretbarer
   Zeit knackbar mit hochwertigen GPUs.

## Rotation — manuelles Verfahren

> Aktuell **kein** dediziertes Rotations-Tooling vorhanden. Folgendes
> Verfahren ist manuell und erfordert kurzzeitige Service-Unterbrechung.

### Schritt 0 — Vorbereitung

```bash
# Aktuellen Wert sichern (offline, verschlüsselt, separater Container).
grep '^AUTH_SECRET=' .env > /secure-backup/auth-secret-pre-rotation.txt
```

### Schritt 1 — Neuen Wert generieren

```bash
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
```

### Schritt 2 — Re-Encrypt aller secret-box-Werte (vor dem Switch!)

Ein Migrations-Skript (TODO, noch nicht implementiert) müsste:

1. Mit altem `AUTH_SECRET` alle `tenant_setting.value`-Felder dechiffrieren.
2. Mit neuem `AUTH_SECRET` neu verschlüsseln.
3. Beide Werte in einer Transaktion atomisch ersetzen.

Bis das Tooling existiert: Operator muss jedes secret-box-Feld manuell
über die Admin-UI neu setzen, **bevor** AUTH_SECRET getauscht wird.

### Schritt 3 — TOTP-Secrets unbrauchbar machen

TOTP-Secrets können nicht ohne Mitwirkung des Users re-encryptet werden
(neu generieren + per Authenticator-App scannen). Optionen:

1. **Force re-enroll**: alle `staff_user.totp_enrolled_at = NULL,
   totp_secret_enc = NULL`. Beim nächsten Login muss der User das TOTP
   neu einrichten. Bestehende Backup-Codes funktionieren in dem Fall NICHT
   (sind gegen einen jetzt unbrauchbaren TOTP-Secret-Hash gebunden).
2. **Maintenance-Login-Modus**: Tooling-TODO — User loggt sich mit
   Passwort+altem-TOTP ein, App re-encrypted das Secret im Flug auf den
   neuen Key.

### Schritt 4 — Sessions revoken

```bash
# Alle aktiven Staff- und Portal-Sessions invalidieren.
# Über Admin-UI: „Alle Sessions ausloggen" oder direkt via
# revokeAllSessions('staff', userId) / revokeAllSessions('portal', userId)
```

### Schritt 5 — Switch

```bash
# .env austauschen, Docker-Stack neu starten.
docker compose --env-file .env -f infra/compose/docker-compose.yml \
                -f infra/compose/docker-compose.app.yml up -d --force-recreate app worker
```

### Schritt 6 — Verifikation

- Login mit einem Test-Account.
- `pnpm verify:chain` läuft durch.
- Admin-UI > Settings: alle Tenant-Settings (SMTP, n8n) prüfen — Werte
  sollten weiter funktionieren (wenn Schritt 2 sauber lief).

## Bekannte Limitierungen / Roadmap

- **Kein Rotations-Skript**: Schritt 2 ist heute manuell. Roadmap:
  ein `pnpm rotate:auth-secret <old> <new>`-Skript im `packages/db`-
  Workspace, das die secret-box-Migration atomisch macht.
- **Kein Maintenance-Login-Modus**: TOTP-Re-Encrypt im Flug fehlt;
  aktuell ist Force-Re-Enroll der einzige saubere Weg.
- **Kein KMS-Backend**: Schlüssel liegen im `.env` der App-Container.
  Für höhere Anforderungen wäre eine Integration mit HashiCorp Vault /
  AWS KMS sinnvoll — nicht im MVP.
