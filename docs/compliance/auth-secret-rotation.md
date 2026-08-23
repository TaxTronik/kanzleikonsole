# AUTH_SECRET-Rotation und bekannte Schlüssel-Abhängigkeiten

Stand: 2026-08-23

`AUTH_SECRET` ist die Schlüsselwurzel für Sessions und TOTP. Frische
Installationen erzeugen zusätzlich einen unabhängigen `SECRET_BOX_KEY` für
gespeicherte Tenant-/Integrations-Secrets. Bestehende Installationen ohne
`SECRET_BOX_KEY` nutzen aus Kompatibilitätsgründen weiterhin `AUTH_SECRET` als
Fallback. Diese Datei dokumentiert die Rotation, solange kein dediziertes
Re-Wrap-Tooling existiert.

---

## Wo AUTH_SECRET verwendet wird

Die Pfade nutzen getrennte Ableitungen. Mit provisioniertem `SECRET_BOX_KEY`
kompromittiert ein Leak von `AUTH_SECRET` die Secret-box-Werte nicht mehr.

| Konsument                                            | Derivation                                                                                    | Was wird geschützt                                                              |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Auth.js JWE-Verschlüsselung                          | Auth.js-interne HKDF-Ableitung; kompaktes JWE mit `alg=dir`, `enc=A256CBC-HS512`              | Vertraulichkeit und Integrität der Session-Claims (24 h TTL)                    |
| `@taxtronik/crypto` v2 secret-box (M-1)              | `hkdfSync('sha256', SECRET_BOX_KEY ?? AUTH_SECRET, salt, info='taxtronik-secret-box-v2', 32)` | `tenant_setting.value`-Felder (SMTP-Passwörter, n8n-HMAC-Secrets, n8n-API-Keys) |
| TOTP-Encryption (`apps/web/src/server/auth/totp.ts`) | `hkdfSync('sha256', AUTH_SECRET, salt=tenantId, info='taxtronik-totp-key', 32)`               | `staff_user.totp_secret_enc`                                                    |

## Was bei Leak passiert

1. **JWE-Fälschung und -Entschlüsselung**: Ein Angreifer kann Session-Claims
   lesen und beliebige neue Staff-/Portal-Tokens erzeugen. Die nominelle
   24-Stunden-TTL begrenzt einen bekannten Schlüssel **nicht**, weil fortlaufend
   neue Tokens mit jüngerem `iat` erzeugt werden können. Auch
   `revokeAllSessions` ist allein keine Eindämmung; wirksam wird erst die
   Rotation von `AUTH_SECRET`.
2. **Secret-Box-Decryption (nur Legacy-Fallback)**: Ohne separaten
   `SECRET_BOX_KEY` sind alle in `tenant_setting` verschlüsselten Werte lesbar.
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

### Schritt 2 — Legacy-Fallback ist ohne Rewrap-Tool ein Blocker

Ist `SECRET_BOX_KEY` bereits gesetzt, entfällt dieser Schritt bei einer reinen
`AUTH_SECRET`-Rotation. Andernfalls ist die Rotation mit dem heutigen Tooling
nicht sicher ausführbar. Ein Offline-Migrationswerkzeug müsste:

1. Mit altem `AUTH_SECRET` alle `tenant_setting.value`-Felder dechiffrieren.
2. Mit einem neu generierten `SECRET_BOX_KEY` neu verschlüsseln.
3. alle Chiffretexte atomisch ersetzen und erst danach den Dienst auf die neue
   Schlüsselkombination umschalten.

Bloßes Neuspeichern der Felder in der Admin-UI **vor** dem Schlüsselwechsel ist
kein Rewrap: Die Anwendung verschlüsselt dabei erneut mit dem alten
`AUTH_SECRET`. Bis das Offline-Rewrap-Tool existiert, dürfen
`AUTH_SECRET`-Rotation und erstmaliges Setzen von `SECRET_BOX_KEY` bei einer
solchen Legacy-Installation nicht durchgeführt werden, sofern die gespeicherten
Secrets erhalten bleiben müssen.

### Schritt 3 — TOTP-Secrets rewrappen oder zurücksetzen

TOTP-Secrets können technisch ohne Benutzerinteraktion neu verschlüsselt
werden: mit dem alten `AUTH_SECRET` entschlüsseln und mit dem neuen
`AUTH_SECRET` wieder verschlüsseln. Die dafür nötigen AES-GCM-Primitiven sind
in `apps/web/src/server/auth/totp.ts` vorhanden. Es gibt derzeit jedoch **kein
unterstütztes Batch-/Rollback-Tool**, daher darf dies nicht als improvisierte
SQL-Migration durchgeführt werden. Zwei belastbare Betriebswege:

1. **Force re-enroll (einzeln unterstützt):** Berechtigte ADMIN-/PARTNER-
   Benutzer setzen untergeordnete Nicht-ADMIN-Konten einzeln über die
   Benutzerverwaltung zurück. ADMIN-Konten werden mit der
   `reset-admin-password`-CLI im Workspace `@taxtronik/db` zurückgesetzt;
   `ADMIN_EMAIL` und `TENANT_SLUG` identifizieren dabei genau ein Konto. Die
   CLI startet zugleich das TOTP-Onboarding neu. Einen globalen Web- oder
   Batch-Reset gibt es nicht. Beim nächsten Login richtet die betroffene Person
   TOTP neu ein; vorhandene Backupcodes werden ersetzt.
2. **Geplantes Offline-Rewrap:** Ein transaktionales Wartungswerkzeug muss je
   Datensatz erst Entschlüsselung mit Alt-Key, Authentizitätsprüfung und
   Verschlüsselung mit Neu-Key durchführen, anschließend Stichproben prüfen und
   erst danach den Dienst auf den neuen Schlüssel umschalten. Bis dieses Tool
   existiert, ist dieser Weg nicht als Operatorverfahren freigegeben.

### Schritt 4 — Session-Auswirkung einplanen

Es gibt keine globale Admin-UI und keinen freigegebenen Operatorbefehl „Alle
Sessions ausloggen". Einzelne Sicherheitsaktionen verwenden intern einen
benutzerbezogenen Redis-Widerruf; das ist kein Ersatz für die Rotation eines
bekannten `AUTH_SECRET`. Der nachfolgende Schlüsselwechsel entwertet sämtliche
bereits ausgestellten Staff- und Portal-JWE-Sessions kryptografisch. Bis zum
Switch bleibt ein bekannter alter Schlüssel wirksam; deshalb App-Zugriff im
Wartungsfenster unterbrechen und unmittelbar umschalten.

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
  müssen weiter funktionieren, wenn der separate `SECRET_BOX_KEY` unverändert
  blieb.

## Bekannte Limitierungen / Roadmap

- **Kein Rotations-Skript**: Schritt 2 ist heute ein Blocker. Roadmap:
  ein `pnpm rotate:auth-secret <old> <new>`-Skript im `packages/db`-
  Workspace, das die secret-box-Migration atomisch macht.
- **Kein TOTP-Batch-Rewrap**: Die kryptografischen Primitiven existieren, aber
  transaktionales Batch-, Prüf- und Rollback-Tooling fehlt. Einzelnes
  Force-Re-Enroll über Rollen-Hierarchie beziehungsweise ADMIN-Recovery-CLI ist
  deshalb aktuell der einzige unterstützte Operatorweg.
- **Kein KMS-Backend**: Schlüssel liegen im `.env` der App-Container.
  Für höhere Anforderungen wäre eine Integration mit HashiCorp Vault /
  AWS KMS sinnvoll — nicht im MVP.
