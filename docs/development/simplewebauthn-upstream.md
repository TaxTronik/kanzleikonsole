# SimpleWebAuthn: Upstream-Vorschlag zur Ketten- und CRL-Härtung (T-02)

Bis T-02 trug `@simplewebauthn/server` 13.3.3 einen versionsgebundenen Patch
(69 KB, 14 Dateien je ESM und CommonJS), der `isCertRevoked` und
`validateCertificatePath` ersetzte. Die Härtung liegt jetzt im Repository
(`packages/crypto/src/certificate-path.ts`, `apps/web/src/server/auth/webauthn-attestation.ts`,
`apps/worker/src/jobs/fido-mds-verify.ts`); die Bibliothek erhält dafür keine
Wurzelzertifikate und prüft weder Ketten noch Sperrlisten selbst. Dieser
Abschnitt ist der Vorschlag an das Upstream-Projekt
(<https://github.com/MasterKale/SimpleWebAuthn>), formuliert zum direkten
Einreichen als Issue beziehungsweise PR-Beschreibung.

Vor dem Einreichen zu klären:

- Lizenz: TaxTronik steht unter AGPL-3.0, SimpleWebAuthn unter MIT. Code aus
  `certificate-path.ts` darf nur übernommen werden, wenn der Rechteinhaber ihn
  ausdrücklich unter MIT beiträgt; sonst nur Problem, API und Testfälle
  einreichen.
- Nach Annahme: Mit einem Hook (Variante A) übergibt TaxTronik seine Prüfung
  an die Bibliothek und entzieht ihr keine Wurzeln mehr; mit gehärteten
  Standardwerten (Variante B) kann der Repository-Code entfallen, sobald die
  Fälle aus `simplewebauthn-crl-hardening.test.ts` und
  `certificate-path.test.ts` gegen die neue Version grün sind. In beiden
  Fällen die Vertragstests `webauthn-library-contract.test.ts` und
  `fido-mds-library-contract.test.ts` anpassen.

---

## Proposal: fail-closed, chain-first certificate path and CRL validation

### Summary

`validateCertificatePath()` and `isCertRevoked()` (used by
`verifyAttestationWithMetadata()`, the `packed`/`tpm`/`android-key`/`apple`
attestation verifiers and `verifyMDSBlob()`) treat revocation checking as
best-effort and dereference certificate-controlled URLs before the chain is
trusted. For relying parties that require hardware attestation this is a
fail-open path. We propose either an injectable path validator (small,
non-breaking) or hardened defaults (behaviour change), plus `AbortSignal`
support.

### Problem (13.3.3)

1. **Fail-open revocation.** `helpers/isCertRevoked.js` returns `false`
   ("not revoked") when the CRL download fails, the endpoint answers with an
   error status, or the CRL cannot be parsed. An attacker who can block or
   corrupt the CRL request (plain HTTP is the norm for CRLs) suppresses
   revocation.
2. **CRL requests before the chain is trusted.** `validateCertificatePath()`
   calls `isCertRevoked()` for every `x5c` certificate and every trust anchor
   _before_ building the chain, so the CRL distribution point of an untrusted,
   attacker-supplied certificate is fetched (server-side request to an
   arbitrary host and port, redirects followed, no size limit, no timeout or
   abort).
3. **Unauthenticated CRLs.** The CRL signature, issuer name, AKI/SKI binding,
   the issuer's `cRLSign` key usage and `thisUpdate`/`nextUpdate` are not
   checked. A CRL without `nextUpdate` is cached forever; the cache is keyed by
   the authority key identifier only, so one fetched list can answer for other
   certificates of that key. Partitioned CRLs (several distribution points,
   `reasons`, `cRLIssuer`, relative names, delta CRLs, issuing distribution
   point, freshest CRL) are treated as complete.
4. **Weak path constraints.** The anchor is matched by subject name only, CA
   certificates are not required to carry critical `basicConstraints` with
   `cA=true` and `keyCertSign`, `pathLenConstraint` and unknown critical
   extensions are ignored, and the first exception aborts the loop
   ("Unexpected error while validating certificate path") instead of trying
   the next anchor.
5. **Optional AAGUID binding.** `helpers/validateExtFIDOGenCEAAGUID.js`
   accepts a leaf without `id-fido-gen-ce-aaguid` (1.3.6.1.4.1.45724.1.1.4)
   and does not reject a critical one, so a certificate under a root shared by
   several models can carry any AAGUID in `authenticatorData`.
6. **No cancellation.** `verifyRegistrationResponse()`, `verifyMDSBlob()` and
   `MetadataService` accept no `AbortSignal`; a hanging CRL request outlives
   the caller's deadline.

### Proposed API

**A. Injectable path validator (non-breaking).** Default keeps today's
behaviour.

```ts
type CertificatePathValidator = (input: {
  /** PEM, leaf first */
  certificates: string[];
  /** PEM trust anchors (metadata roots or SettingsService roots) */
  trustAnchors: string[];
  /** 'attestation' | 'mds' */
  purpose: string;
  signal?: AbortSignal;
}) => Promise<void>; // throws to reject

SettingsService.setCertificatePathValidator(validator);
// or per call:
verifyRegistrationResponse({ ..., certificatePathValidator, signal });
verifyMDSBlob(blob, { certificatePathValidator, signal });
```

The library would call the validator wherever it calls
`validateCertificatePath()` today (including the self-referencing shortcut in
`verifyAttestationWithMetadata()`, which should stay in the library).

**B. Hardened defaults (behaviour change, e.g. next major).**

- Build the path to exactly one trust anchor without network access (anchor
  compared by encoding, duplicates rejected, at most 5 path certificates and 64
  anchors), require critical `basicConstraints` `cA=true`, `keyCertSign` and
  `pathLenConstraint` for every issuer, reject unknown critical extensions and
  name/policy constraints that are not evaluated.
- Only then check each non-root certificate against a CRL of its actual issuer
  in that path: exactly one unpartitioned distribution point with one URI,
  `http`/`https` on default ports without credentials, `redirect: 'error'`,
  caller's `AbortSignal`, streaming size limit; CRL issuer, signature, AKI/SKI,
  `cRLSign`, `thisUpdate <= now < nextUpdate`; reject delta/IDP/freshest CRLs
  and unknown critical CRL extensions.
- Any download, HTTP, parse or verification error rejects (fail-closed);
  optionally `revocation: 'require' | 'best-effort' | 'off'` for deployments
  that need the old behaviour.
- Cache keyed by issuer fingerprint, serial and CRL URL, valid until the
  signed `nextUpdate`, bounded in size.
- `requireAAGUIDExtension` (or always when metadata is used): missing or
  critical extension rejects.
- `signal?: AbortSignal` on `verifyRegistrationResponse()`,
  `verifyAttestationWithMetadata()`, `verifyMDSBlob()` and
  `MetadataService.initialize()`, passed to every `fetch`.

### Test cases

All with real certificates and CRLs generated by `@peculiar/x509`, `fetch`
stubbed:

- valid leaf → root and leaf → intermediate → root; CRLs fetched in path order
  with `redirect: 'error'` and the caller's signal;
- leaf revoked by its issuer's CRL; intermediate revoked by the root's CRL;
- CRL network error, HTTP 503, unparsable body, body over the size limit
  (`Content-Length` and streamed), hanging request aborted by the signal: all
  reject;
- CRL signed by another key, other issuer name, expired, `thisUpdate` in the
  future, missing `nextUpdate`, AKI not matching the issuer SKI, issuer without
  `cRLSign`, delta CRL indicator, issuing distribution point, freshest CRL,
  unknown critical extension: all reject;
- CRL URL `file:`, with credentials, on a non-default port; several
  distribution points, several names, `reasons`, `cRLIssuer`, relative name,
  certificate-side freshest CRL: rejected before any request;
- untrusted leaf (other root, or same root name with another key): rejected
  without any request;
- issuer with non-critical `basicConstraints`, without `keyCertSign`, violated
  `pathLenConstraint`; leaf with unknown critical extension or
  `nameConstraints`; duplicate certificates; more than 5 certificates or 64
  anchors; expired or not yet valid leaf; only expired anchors: all reject;
- second anchor matches after an unrelated first anchor: accepted;
- revocation status cached until `nextUpdate` (one request for two checks);
- `packed` attestation with missing, critical or mismatching AAGUID extension:
  rejected before any request;
- `verifyRegistrationResponse()` and `verifyMDSBlob()` with a path validator
  that rejects: verification fails; with a validator that hangs: aborted by the
  signal.

---

TaxTronik-Nachweise zu diesen Fällen: `packages/crypto/src/__tests__/certificate-path.test.ts`,
`apps/web/src/server/auth/__tests__/simplewebauthn-crl-hardening.test.ts`,
`apps/web/src/server/auth/__tests__/webauthn-attestation.test.ts`,
`apps/web/src/server/auth/__tests__/webauthn-library-contract.test.ts` und
`apps/worker/src/jobs/__tests__/fido-mds-library-contract.test.ts`.
