# Cookie-Konfiguration der Auth-Surfaces

Stand: 2026-05-14 (Round 13)

Übersicht aller von taxtronik gesetzten Cookies — für Datenschutz-Auditoren
und Pen-Tester. Jeder Cookie ist mit Flags, Lebenszeit und Inhalt
dokumentiert.

---

## Session-Cookies (Authentifizierung)

| Name | Surface | HttpOnly | Secure | SameSite | Path | Domain | Max-Age | Inhalt |
|---|---|---|---|---|---|---|---|---|
| `__taxtronik_staff_session` | Staff (`/staff/*`, `/api/staff/*`) | ✓ | nur in Production | `lax` | `/` | optional `STAFF_COOKIE_DOMAIN` (sonst implizit Host) | 24 h (W-1) | JWT mit `staffId`, `tenantId`, `fullName`, `roles[]`, `iat` |
| `__taxtronik_portal_session` | Portal (`/portal/*`, `/api/portal/*`) | ✓ | nur in Production | `lax` | `/` | optional `PORTAL_COOKIE_DOMAIN` (sonst implizit Host) | 24 h (W-1) | JWT mit `contactId`, `tenantId`, `clientId`, `fullName`, `iat` |

**Cookie-Domain-Trennung**: Wenn `STAFF_COOKIE_DOMAIN`/`PORTAL_COOKIE_DOMAIN`
explizit gesetzt sind (z. B. Subdomain-Setup `staff.kanzlei.de` /
`portal.kanzlei.de`), bekommen beide Cookies unterschiedliche Domain-Scopes
und können nicht aneinander vorbeigeschickt werden. Default (Single-Host)
isoliert die Cookies über den **Path** — beide auf `/`, aber unterschiedliche
Cookie-Namen.

**JWT-Signing**: `AUTH_SECRET` (HKDF-derived, siehe
[auth-secret-rotation.md](./auth-secret-rotation.md)). Default-Algorithmus:
HS256 (NextAuth-default).

**Session-Revocation (S11)**: Server-side via Redis-Key
`revoke:{surface}:{userId}` mit Timestamp. JWTs mit `iat` vor dem Revocation-
Timestamp werden vom Session-Callback abgelehnt — sofortiger Logout möglich,
ohne auf JWT-Expiry warten zu müssen.

## Auth.js-Helper-Cookies

Auth.js setzt während des OAuth-Flow weitere Cookies (`__Host-next-auth.*`).
taxtronik nutzt aber AUSSCHLIESSLICH den Credentials-Provider (Passwort + TOTP
für Staff, Magic-Link für Portal). Diese Helper-Cookies werden in der Praxis
nicht gesetzt.

## Sonstige Cookies

taxtronik setzt **keine** Tracking-, Analytics- oder Werbe-Cookies.
- Kein Google Analytics, Matomo o. ä.
- Kein A/B-Test-Framework.
- Keine Drittanbieter-Embeds (alle Assets stammen vom eigenen Host).

Cookie-Banner ist daher nicht erforderlich (nur funktional notwendige
Cookies nach ePrivacy-Richtlinie / § 25 TTDSG).

## Header-Konfiguration

Set-Cookie-Header laufen durch `infra/nginx/taxtronik.conf.example`
(Reverse-Proxy-Setup). Bei direktem Container-Bind ohne Proxy würden die
Cookies trotzdem korrekt vom Node-Server gesetzt, aber `Secure` triggert
nicht, weil Next.js die Production-Erkennung an Connection-Encryption
hängt — siehe `env.NODE_ENV === 'production'` in den Cookie-Optionen.

## Verifikation

```bash
# Staff-Login-Response inspizieren (Set-Cookie-Header)
curl -i -X POST https://kanzlei.example.com/api/auth/staff/callback/credentials \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "email=admin@kanzlei.de&password=...&totpCode=..."

# Erwartet:
# Set-Cookie: __taxtronik_staff_session=eyJ...; Path=/; HttpOnly; Secure; SameSite=Lax
```

In Browser-DevTools → Application → Cookies sollten **nur** die zwei
Session-Cookies sichtbar sein, beide mit den oben dokumentierten Flags.

## Pen-Test-Schwerpunkte

- [ ] Cookies haben `HttpOnly` (kein `document.cookie`-Zugriff aus JS).
- [ ] In Production: `Secure`-Flag gesetzt (kein Plain-HTTP-Leak).
- [ ] `SameSite=Lax` blockt klassische CSRF-Vektoren (POST-Cross-Origin).
- [ ] Cookie-Domain-Scope passt zum Surface-Modell (Staff != Portal).
- [ ] Max-Age 24 h durchgesetzt (W-1).
- [ ] Logout invalidiert via Server-Revocation (S11), nicht nur via
      `Set-Cookie: ...; Max-Age=0`.
