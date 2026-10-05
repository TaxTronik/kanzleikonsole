# AUTH_SECRET-Rotation und bekannte Schlüssel-Abhängigkeiten

Stand: 2026-10-05

`AUTH_SECRET` ist die Schlüsselwurzel für Sessions und TOTP. Frische
Installationen erzeugen zusätzlich einen unabhängigen `SECRET_BOX_KEY` für
gespeicherte Tenant-/Integrations-Secrets. Bestehende Installationen ohne
`SECRET_BOX_KEY` nutzen aus Kompatibilitätsgründen weiterhin `AUTH_SECRET` als
Fallback. Diese Datei dokumentiert die Rotation. Für die Secret-Box gibt es ein
Re-Wrap-Kommando (`pnpm secret-box:rewrap`, siehe
[`../operations/secret-rotation.md`](../operations/secret-rotation.md#secret-box-schlüssel));
für TOTP-Secrets weiterhin nicht.

---

## Wo AUTH_SECRET verwendet wird

Die Pfade nutzen getrennte Ableitungen. Mit provisioniertem `SECRET_BOX_KEY`
kompromittiert ein Leak von `AUTH_SECRET` die Secret-box-Werte nicht mehr.

| Konsument                                            | Derivation                                                                                                                                                                         | Was wird geschützt                                                                                                                  |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Auth.js JWE-Verschlüsselung                          | Auth.js-interne HKDF-Ableitung; kompaktes JWE mit `alg=dir`, `enc=A256CBC-HS512`                                                                                                   | Vertraulichkeit und Integrität der Session-Claims (24 h TTL)                                                                        |
| `@taxtronik/crypto` v3 secret-box (S-08)             | `hkdfSync('sha256', <erster SECRET_BOX_KEYRING-Eintrag, sonst SECRET_BOX_KEY ?? AUTH_SECRET>, salt-v3, info='taxtronik-secret-box-v3', 32)`; AAD `<tenantId>\|<Ablageort>\|<Feld>` | Ablageorte aus `packages/crypto/src/secret-slots.ts` (SMTP-Passwörter, n8n-Secrets und -API-Keys, IBM-Token, Postfach-Zugangsdaten) |
| `@taxtronik/crypto` v2 secret-box (M-1), nur lesend  | `hkdfSync('sha256', SECRET_BOX_KEY ?? AUTH_SECRET, salt, info='taxtronik-secret-box-v2', 32)`                                                                                      | Bestandswerte bis zum Re-Wrap                                                                                                       |
| TOTP-Encryption (`apps/web/src/server/auth/totp.ts`) | `hkdfSync('sha256', AUTH_SECRET, salt=tenantId, info='taxtronik-totp-key', 32)`                                                                                                    | `staff_user.totp_secret_enc`                                                                                                        |

WebAuthn-Credential-IDs, öffentliche Schlüssel, Signaturzähler und Metadaten in
`staff_webauthn_credential` werden nicht aus `AUTH_SECRET` abgeleitet. Der
private Schlüssel verlässt den Authentikator nicht. Eine `AUTH_SECRET`-Rotation
invalidiert die JWE-Sitzung eines Hardware-only-Kontos, nicht dessen
registrierte Sicherheitsschlüssel.

## Was bei Leak passiert

1. **JWE-Fälschung und -Entschlüsselung**: Ein Angreifer kann Session-Claims
   lesen und beliebige neue Staff-/Portal-Tokens erzeugen. Die nominelle
   24-Stunden-TTL begrenzt einen bekannten Schlüssel **nicht**, weil fortlaufend
   neue Tokens mit jüngerem `iat` erzeugt werden können. Auch
   `revokeAllSessions` ist allein keine Eindämmung; wirksam wird erst die
   Rotation von `AUTH_SECRET`.
2. **Secret-Box-Decryption (nur Legacy-Fallback)**: Ohne separaten
   `SECRET_BOX_KEY` und ohne `SECRET_BOX_KEYRING` sind alle mit der Secret-Box
   verschlüsselten Werte lesbar.
3. **TOTP-Decryption**: Alle `totp_secret_enc` lesbar → Angreifer kennt
   die TOTP-Seeds und kann gültige Codes generieren. Backup-Codes-Hashes
   sind bcrypt-gehasht — nicht decrypt-bar, aber pro Code in vertretbarer
   Zeit knackbar mit hochwertigen GPUs.

Hardware-only schützt nicht gegen einen bekannten `AUTH_SECRET`: Ein Angreifer
mit dieser Schlüsselwurzel kann Staff-JWEs fälschen. Der Modus verhindert nur,
dass das gespeicherte Passwort, TOTP oder ein Backup-Code als regulärer Login-
Fallback für dieses Konto verwendet wird.

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

### Schritt 2 — Secret-Box-Werte von AUTH_SECRET lösen

Ist `SECRET_BOX_KEY` bereits gesetzt und meldet
`pnpm secret-box:rewrap --dry-run` keine `v1`-Werte mehr (diese leiten sich
immer aus `AUTH_SECRET` ab), entfällt dieser Schritt bei einer reinen
`AUTH_SECRET`-Rotation. Andernfalls vor dem Wechsel:

1. Einen neuen Datenschlüssel als ersten Eintrag von `SECRET_BOX_KEYRING`
   ausrollen (Runbook, Abschnitt „Rotation der Datenschlüssel ohne
   Ausfallzeit“).
2. `pnpm secret-box:rewrap` ausführen, bis `--dry-run` je Ablageort
   „aktuell“ = „gesamt“ meldet. Alle Werte sind dann `v3` mit dem neuen
   Datenschlüssel und hängen nicht mehr an `AUTH_SECRET`.

Bloßes Neuspeichern der Felder in der Admin-UI **vor** dem Schlüsselwechsel ist
kein Rewrap, wenn kein Schlüsselbund konfiguriert ist: Die Anwendung
verschlüsselt dann erneut mit der Wurzel `AUTH_SECRET`. Ohne `SECRET_BOX_KEY`
bleibt `AUTH_SECRET` außerdem Wurzel der Prüfsumme der Audit-Prüf-Checkpoints;
eine `AUTH_SECRET`-Rotation macht diese Checkpoints einmalig ungültig
(AUDIT-VERIFY-ALERT-001). Nach einem versehentlich ohne Re-Wrap durchgeführten
Wechsel bleiben `v1`/`v2`-Werte lesbar, wenn der alte Wert vorübergehend als
weiterer Eintrag in `SECRET_BOX_KEYRING` steht; anschließend Re-Wrap ausführen
und den Eintrag entfernen.

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
   CLI startet zugleich das TOTP-Onboarding neu und koppelt Reset,
   Schlüsselwiderruf sowie ein tenantgebundenes `SYSTEM`-Audit-Ereignis in
   derselben Transaktion. Einen globalen Web- oder Batch-Reset gibt es nicht.
   Beim nächsten Login richtet die betroffene Person TOTP neu ein; vorhandene
   Backupcodes werden ersetzt.
2. **Geplantes Offline-Rewrap:** Ein transaktionales Wartungswerkzeug muss je
   Datensatz erst Entschlüsselung mit Alt-Key, Authentizitätsprüfung und
   Verschlüsselung mit Neu-Key durchführen, anschließend Stichproben prüfen und
   erst danach den Dienst auf den neuen Schlüssel umschalten. Bis dieses Tool
   existiert, ist dieser Weg nicht als Operatorverfahren freigegeben.

Konten mit aktivem Hardware-only-Modus benötigen für das TOTP-Rewrap keinen
Hardware-Reset: Nach der globalen Session-Invalidierung können sie sich mit
ihren registrierten Schlüsseln neu anmelden, sofern die nichtleere AAGUID-
Allowlist wiederhergestellt ist und das aktuelle FIDO-MDS-Statement
fail-closed bestätigt wird. Die ADMIN-Recovery-CLI darf für solche Konten nur
als bewusster Break-glass-Pfad verwendet werden, weil sie den Modus deaktiviert,
alle Schlüssel sperrt und ein neues Passwort/TOTP-Onboarding erzwingt.

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

- **Secret-Box-Re-Wrap vorhanden**: `pnpm secret-box:rewrap` (Workspace
  `packages/db`) stellt alle Secret-Box-Werte idempotent und wiederaufnehmbar
  auf den aktiven Schlüssel um. Ein Skript für die Rotation von `AUTH_SECRET`
  selbst gibt es nicht.
- **Kein TOTP-Batch-Rewrap**: Die kryptografischen Primitiven existieren, aber
  transaktionales Batch-, Prüf- und Rollback-Tooling fehlt. Einzelnes
  Force-Re-Enroll über Rollen-Hierarchie beziehungsweise ADMIN-Recovery-CLI ist
  deshalb aktuell der einzige unterstützte Operatorweg.
- **Kein KMS-Backend**: Schlüssel liegen im `.env` der App-Container.
  Für höhere Anforderungen wäre eine Integration mit HashiCorp Vault /
  AWS KMS sinnvoll — nicht im MVP.
