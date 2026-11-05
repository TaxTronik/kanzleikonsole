// Fachkatalog: MAIL-INBOX-001
//
// Vertrag gegen die echte MSAL-Bibliothek: Nur der Netzwerk-Client ist ersetzt,
// `microsoftClient` samt Cache-Plugin läuft unverändert. Der gespeicherte Cache
// hat exakt die Form, die MSAL Node 5.6.0 geschrieben hat. Bricht sie, müssten
// alle verbundenen Microsoft-365-Postfächer neu verbunden werden. Die reale
// Microsoft-365-Abnahme ersetzt dieser Test nicht.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboundMailbox } from '@prisma/client';
import type { Configuration, NetworkRequestOptions } from '@azure/msal-node';

const TENANT = '11111111-1111-4111-8111-111111111111';
const CLIENT = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const HOME_ACCOUNT = `${USER}.${TENANT}`;
const AUTHORITY = `https://login.microsoftonline.com/${TENANT}`;
const REDIRECT_URI = 'https://kanzlei.example.test/api/staff/mailbox/oauth';
const USERNAME = 'kanzlei@example.test';
const FAR_FUTURE = 4102444800;

const m = vi.hoisted(() => ({
  stored: null as string | null,
  posts: [] as Array<{ url: string; body: URLSearchParams }>,
  tokenResponse: {} as Record<string, unknown>,
}));

vi.mock('@taxtronik/db', () => ({
  withSystemContext: async (_tenant: string, fn: (tx: unknown) => unknown) =>
    fn({
      inboundMailbox: {
        findUnique: async () => ({ oauthCacheEnc: m.stored }),
        update: async ({ data }: { data: { oauthCacheEnc: string } }) => {
          m.stored = data.oauthCacheEnc;
        },
      },
    }),
}));
vi.mock('@taxtronik/crypto', async () => ({
  ...(await import('@taxtronik/crypto/secret-slots')),
  encryptSecret: (value: string) => value,
  decryptSecret: (value: string) => value,
}));
vi.mock('@taxtronik/storage', () => ({
  scanBytes: vi.fn(),
  putObjectBytes: vi.fn(),
  getBucketForTier: vi.fn(),
  MAX_UPLOAD_BYTES: 25 * 1024 * 1024,
  detectMimeFromMagicBytes: vi.fn(),
}));
vi.mock('@azure/msal-node', async (importOriginal) => {
  const real = await importOriginal<typeof import('@azure/msal-node')>();
  class WithStubbedNetwork extends real.ConfidentialClientApplication {
    constructor(config: Configuration) {
      super({
        ...config,
        system: {
          ...config.system,
          networkClient: {
            sendGetRequestAsync: async () => {
              throw new Error('Unerwarteter GET-Aufruf: Authority-Metadaten sind fest hinterlegt.');
            },
            sendPostRequestAsync: async <T>(url: string, options?: NetworkRequestOptions) => {
              m.posts.push({ url, body: new URLSearchParams(options?.body) });
              return { status: 200, headers: {}, body: m.tokenResponse as T };
            },
          },
        },
      });
    }
  }
  return { ...real, ConfidentialClientApplication: WithStubbedNetwork };
});

import { IMAP_SCOPES, microsoftClient } from '../imap';

const base64Url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const CLIENT_INFO = base64Url({ uid: USER, utid: TENANT });
// Unsigniertes Fixture zur Laufzeit: MSAL liest nur die Claims des ID-Tokens.
const ID_TOKEN = [
  base64Url({ alg: 'none' }),
  base64Url({
    tid: TENANT,
    oid: USER,
    sub: 'fixture',
    preferred_username: USERNAME,
    name: 'Kanzlei',
    iss: `${AUTHORITY}/v2.0`,
    aud: CLIENT,
    exp: FAR_FUTURE,
    iat: 1,
  }),
  'fixture',
].join('.');

/** Struktur und Schlüssel wie von MSAL Node 5.6.0 serialisiert. */
function cacheWrittenByMsal5(accessTokenExpiresOn: number): string {
  const target = 'https://outlook.office.com/IMAP.AccessAsUser.All openid profile';
  const scope = { home_account_id: HOME_ACCOUNT, environment: 'login.windows.net' };
  const credential = { ...scope, client_id: CLIENT };
  return JSON.stringify({
    Account: {
      [`${HOME_ACCOUNT}-login.windows.net-${TENANT}`]: {
        ...scope,
        realm: TENANT,
        local_account_id: USER,
        username: USERNAME,
        authority_type: 'MSSTS',
        name: 'Kanzlei',
        client_info: CLIENT_INFO,
        tenantProfiles: [
          JSON.stringify({
            tenantId: TENANT,
            localAccountId: USER,
            name: 'Kanzlei',
            username: USERNAME,
            isHomeTenant: true,
          }),
        ],
      },
    },
    IdToken: {
      [`${HOME_ACCOUNT}-login.windows.net-idtoken-${CLIENT}-${TENANT}--`]: {
        ...credential,
        credential_type: 'IdToken',
        secret: ID_TOKEN,
        realm: TENANT,
      },
    },
    AccessToken: {
      [`${HOME_ACCOUNT}-login.windows.net-accesstoken-${CLIENT}-${TENANT}-${target.toLowerCase()}-`]:
        {
          ...credential,
          credential_type: 'AccessToken',
          secret: 'fixture-imap-grant',
          realm: TENANT,
          target,
          cached_at: '1',
          expires_on: String(accessTokenExpiresOn),
          extended_expires_on: String(accessTokenExpiresOn),
          token_type: 'Bearer',
        },
    },
    RefreshToken: {
      [`${HOME_ACCOUNT}-login.windows.net-refreshtoken-${CLIENT}---`]: {
        ...credential,
        credential_type: 'RefreshToken',
        secret: 'fixture-renewal-grant',
      },
    },
    AppMetadata: {},
  });
}

const account = {
  id: 'mailbox',
  tenantId: 'tenant',
  entraTenantId: TENANT,
  entraClientId: CLIENT,
  secretEnc: 'fixture-client-credential',
} as InboundMailbox;

beforeEach(() => {
  m.stored = null;
  m.posts = [];
  m.tokenResponse = {
    token_type: 'Bearer',
    scope: 'https://outlook.office.com/IMAP.AccessAsUser.All openid profile',
    expires_in: 3600,
    ext_expires_in: 3600,
    access_token: 'issued-imap-grant',
    refresh_token: 'issued-renewal-grant',
    id_token: ID_TOKEN,
    client_info: CLIENT_INFO,
  };
});

describe('MSAL library contract of the Microsoft 365 mailbox', () => {
  it('keeps mailboxes connected: a cache written by MSAL 5 still yields its account and token', async () => {
    m.stored = cacheWrittenByMsal5(FAR_FUTURE);
    const client = microsoftClient(account);

    const profiles = await client.getTokenCache().getAllAccounts();
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({
      homeAccountId: HOME_ACCOUNT,
      tenantId: TENANT,
      username: USERNAME,
    });

    const token = await client.acquireTokenSilent({ account: profiles[0]!, scopes: IMAP_SCOPES });
    expect(token?.accessToken).toBe('fixture-imap-grant');
    expect(m.posts).toEqual([]);
  });

  it('renews an expired token from the stored refresh token and persists the result', async () => {
    m.stored = cacheWrittenByMsal5(1);
    const client = microsoftClient(account);

    const [profile] = await client.getTokenCache().getAllAccounts();
    const token = await client.acquireTokenSilent({ account: profile!, scopes: IMAP_SCOPES });

    expect(token?.accessToken).toBe('issued-imap-grant');
    expect(m.posts).toHaveLength(1);
    expect(m.posts[0]!.url.startsWith(`${AUTHORITY}/oauth2/v2.0/token`)).toBe(true);
    expect(m.posts[0]!.body.get('grant_type')).toBe('refresh_token');
    expect(m.posts[0]!.body.get('refresh_token')).toBe('fixture-renewal-grant');
    expect(m.stored).toContain('issued-imap-grant');
    expect(m.stored).toContain('issued-renewal-grant');
  });

  it('still answers on the GET callback and exchanges the code with PKCE', async () => {
    let persisted: string | undefined;
    const client = microsoftClient(account, async (encrypted) => {
      persisted = encrypted;
    });

    const authorize = new URL(
      await client.getAuthCodeUrl({
        scopes: IMAP_SCOPES,
        redirectUri: REDIRECT_URI,
        state: 'fixture-state',
        codeChallenge: 'fixture-challenge',
        codeChallengeMethod: 'S256',
        prompt: 'select_account',
      }),
    );
    expect(authorize.origin + authorize.pathname).toBe(`${AUTHORITY}/oauth2/v2.0/authorize`);
    // Die OAuth-Route ist ein GET-Handler und liest code/state aus der Query.
    expect(authorize.searchParams.get('response_mode')).toBe('query');
    expect(authorize.searchParams.get('state')).toBe('fixture-state');
    expect(authorize.searchParams.get('code_challenge')).toBe('fixture-challenge');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('prompt')).toBe('select_account');
    expect(authorize.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);

    const result = await client.acquireTokenByCode({
      code: 'fixture-code',
      codeVerifier: 'fixture-verifier',
      scopes: IMAP_SCOPES,
      redirectUri: REDIRECT_URI,
    });
    expect(result.accessToken).toBe('issued-imap-grant');
    expect(m.posts).toHaveLength(1);
    expect(m.posts[0]!.url.startsWith(`${AUTHORITY}/oauth2/v2.0/token`)).toBe(true);
    expect(m.posts[0]!.body.get('grant_type')).toBe('authorization_code');
    expect(m.posts[0]!.body.get('code')).toBe('fixture-code');
    expect(m.posts[0]!.body.get('code_verifier')).toBe('fixture-verifier');
    expect(m.posts[0]!.body.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(m.posts[0]!.body.get('client_secret')).toBe('fixture-client-credential');

    // Der vom Callback persistierte Cache muss dem Worker-Abruf genügen.
    expect(persisted).toBeDefined();
    m.stored = persisted!;
    const profiles = await microsoftClient(account).getTokenCache().getAllAccounts();
    expect(profiles.map((profile) => profile.homeAccountId)).toEqual([HOME_ACCOUNT]);
  });
});
