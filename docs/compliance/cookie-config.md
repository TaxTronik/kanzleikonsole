# Cookie-Konfiguration der Auth-Surfaces

Stand: 2026-09-03

Übersicht aller von taxtronik gesetzten Cookies — für Datenschutz-Auditoren
und Pen-Tester. Jeder Cookie ist mit Flags, Lebenszeit und Inhalt
dokumentiert.

---

## Session-Cookies (Authentifizierung)

| Name                                            | Surface                               | HttpOnly | Secure       | SameSite | Path | Domain                                                | Max-Age    | Inhalt                                        |
| ----------------------------------------------- | ------------------------------------- | -------- | ------------ | -------- | ---- | ----------------------------------------------------- | ---------- | --------------------------------------------- |
| `__Host-`/`__Secure-taxtronik_staff_session` ¹  | Staff (`/staff/*`, `/api/staff/*`)    | ✓        | Production ¹ | `lax`    | `/`  | optional `STAFF_COOKIE_DOMAIN` (sonst implizit Host)  | 24 h (W-1) | verschlüsseltes JWE mit Staff-Session-Claims  |
| `__Host-`/`__Secure-taxtronik_portal_session` ¹ | Portal (`/portal/*`, `/api/portal/*`) | ✓        | Production ¹ | `lax`    | `/`  | optional `PORTAL_COOKIE_DOMAIN` (sonst implizit Host) | 24 h (W-1) | verschlüsseltes JWE mit Portal-Session-Claims |

¹ **Cookie-Präfix-Logik** (`apps/web/src/server/auth/session-cookie.ts`): In
Production ohne konfigurierte Cookie-Domain (Default, host-only) heißen die
Cookies `__Host-taxtronik_*_session` — Browser erzwingen damit Secure +
`Path=/` + **kein** Domain-Attribut, das Cookie kann also nicht von Subdomains
oder unsicheren Kontexten überschrieben werden. Ist `STAFF_COOKIE_DOMAIN` /
`PORTAL_COOKIE_DOMAIN` gesetzt (Subdomain-Trennung), lauten die Namen
`__Secure-taxtronik_*_session` (`__Host-` wäre mit Domain-Attribut ungültig).
Nur im Dev (HTTP, Browser lehnen Präfix-Cookies ab) bleibt der unpräfixte
Name `__taxtronik_*_session`.

**Surface-Trennung**: Wenn `STAFF_COOKIE_DOMAIN`/`PORTAL_COOKIE_DOMAIN`
explizit gesetzt sind (z. B. Subdomain-Setup `staff.kanzlei.de` /
`portal.kanzlei.de`), bekommen beide Cookies unterschiedliche Domain-Scopes
und werden vom Browser nicht an die jeweils andere Subdomain gesendet. Im
Single-Host-Default werden **beide** Cookies technisch an alle Pfade des Hosts
gesendet, weil beide `Path=/` tragen. Die Auth-Surfaces bleiben durch getrennte
Cookie-Namen, getrennte Auth.js-Konfigurationen und surface-spezifische
Sessionprüfung isoliert; eine Path-Isolation besteht ausdrücklich nicht.

**Sessionformat**: Auth.js erzeugt standardmäßig ein verschlüsseltes JWE, kein
nur signiertes HS256-JWT. Die gepinnte Version verwendet direkte
Schlüsselableitung (`alg=dir`) und `enc=A256CBC-HS512`; Schlüsselwurzel ist
`AUTH_SECRET` (siehe
[auth-secret-rotation.md](./auth-secret-rotation.md)). Die Anwendung delegiert
Encode/Decode unverändert an Auth.js und ergänzt nur die Session-Claims.

**Session-Revocation**: Server-side via Redis-Key
`revoke:{surface}:{userId}` mit Timestamp. Wegen der Sekundengenauigkeit des
JWT-Claims wird die gesamte Sekunde des Widerrufs einschließlich aller Tokens
mit älterem `iat` vom Session-Callback abgelehnt — sofortiger Logout möglich,
ohne auf JWT-Expiry warten zu müssen. Widerrufsschreibvorgänge und das Lesen des
Widerrufszeitpunkts sind fail-closed: Ist Redis nicht verfügbar, wird eine
betroffene Session nicht akzeptiert und die Sicherheitsaktion nicht als Erfolg
gemeldet. Das schützt nur, solange `AUTH_SECRET` nicht kompromittiert ist: Mit
dem Schlüssel könnte ein Angreifer ein neues JWE mit jüngerem `iat` erzeugen.
In diesem Fall ist die Secret-Rotation die entscheidende Eindämmungsmaßnahme.

## Auth.js-Helper-Cookies

Auth.js setzt während eines OAuth-Flows weitere Cookies (`__Host-next-auth.*`).
taxtronik nutzt aber ausschließlich Credentials-Provider: Passwort + TOTP oder
physischer Sicherheitsschlüssel für Staff, Magic-Link für Portal. Diese
OAuth-Helper-Cookies werden in der Praxis nicht gesetzt. WebAuthn-Challenges
liegen kurzlebig und einmalig in Redis, nicht in einem zusätzlichen
Browser-Cookie.

## Sonstige Cookies

taxtronik setzt **keine** Tracking-, Analytics- oder Werbe-Cookies.

- Kein Google Analytics, Matomo o. ä.
- Kein A/B-Test-Framework.
- Keine Drittanbieter-Embeds (alle Assets stammen vom eigenen Host).

Ein Einwilligungsbanner ist für diese technisch erforderlichen Cookies nicht
erforderlich (§ 25 Abs. 2 Nr. 2 TDDDG). Ob weitere, außerhalb von TaxTronik
ergänzte Dienste eine Einwilligung verlangen, bleibt gesondert zu prüfen.

## Header-Konfiguration

Das nginx-Beispiel und das optionale Traefik-Deployment reichen
`Set-Cookie` unverändert durch. Die Anwendung setzt `Secure` anhand des
Production-Modus selbst; nur der explizit dreifach gegatete lokale
HTTP-E2E-Modus ist davon ausgenommen. Ein direkter Production-Bind ohne TLS
würde daher Secure-Cookies ausstellen, die der Browser über HTTP zu Recht
nicht zurücksendet; Produktion benötigt HTTPS-Termination.

## Verifikation

```bash
# Staff-Login-Response inspizieren (Set-Cookie-Header)
curl -i -X POST https://kanzlei.example.com/api/auth/staff/callback/credentials \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "email=admin@kanzlei.de&password=...&totpCode=..."

# Erwartet (ohne STAFF_COOKIE_DOMAIN; mit gesetzter Domain stattdessen __Secure-…):
# Set-Cookie: __Host-taxtronik_staff_session=<compact-JWE>; Path=/; HttpOnly; Secure; SameSite=Lax
```

Der Befehl prüft den Standardmodus. Der Hardware-only-Flow benötigt die
WebAuthn-API eines Browsers, einen attestiert registrierten Schlüssel, eine
nichtleere AAGUID-Allowlist und ein aktuell vertrauenswürdiges FIDO-MDS-
Statement; nach erfolgreicher Assertion gelten dieselben Session-Cookie-Flags.
Allowlist-/MDS-/Netzfehler lehnen die Assertion fail-closed ab. Ein
Hardware-only-Konto muss den obigen Passwort/TOTP-Callback weiterhin ablehnen.

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
- [ ] Hardware-only erzeugt dasselbe Staff-Cookie, akzeptiert aber keine
      Passwort-/TOTP-/Backup-Code-Session und bleibt vom Portal-Cookie getrennt.
