// Hilfen der Client-Tests: lokaler HTTP-Server auf 127.0.0.1, der rohe
// Anfragen festhält, und frisch erzeugte Schlüssel/Token (nichts im Repo).
import { generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { bodySha256, pruefeAkteur, type PruefErgebnis } from '@taxtronik/tcms-contract';
import type { TcmsClientOptionen } from '../client';

export interface Empfangen {
  methode: string;
  /** Rohes Request-Target wie auf der Leitung. */
  target: string;
  headers: IncomingMessage['headers'];
  body: Buffer;
}

export type Antworter = (anfrage: Empfangen, res: ServerResponse) => void | Promise<void>;

export interface TestServer {
  url: string;
  empfangen: Empfangen[];
  setze(antworter: Antworter): void;
  schliessen(): Promise<void>;
}

/** Liest den Body vollständig, außer der Antworter will ihn nicht (`ohneBody`). */
export async function starteServer(
  antworter: Antworter,
  opts: { ohneBody?: boolean } = {},
): Promise<TestServer> {
  let aktuell = antworter;
  const empfangen: Empfangen[] = [];
  const server: Server = createServer((req, res) => {
    const fertig = (body: Buffer) => {
      const anfrage: Empfangen = {
        methode: req.method ?? '',
        target: req.url ?? '',
        headers: req.headers,
        body,
      };
      empfangen.push(anfrage);
      Promise.resolve(aktuell(anfrage, res)).catch(() => res.destroy());
    };
    if (opts.ohneBody) {
      fertig(Buffer.alloc(0));
      return;
    }
    const teile: Buffer[] = [];
    req.on('data', (teil: Buffer) => teile.push(teil));
    req.on('end', () => fertig(Buffer.concat(teile)));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    empfangen,
    setze(neu) {
      aktuell = neu;
    },
    async schliessen() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export function json(res: ServerResponse, status: number, body: unknown, zusatz = {}): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-request-id': '11111111-2222-4333-8444-555555555555',
    ...zusatz,
  });
  res.end(JSON.stringify(body));
}

export interface Schluessel {
  kid: string;
  privat: KeyObject;
  oeffentlich: KeyObject;
  token: string;
}

export function neueSchluessel(kid = 'kk-test'): Schluessel {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    kid,
    privat: privateKey,
    oeffentlich: publicKey,
    token: randomBytes(32).toString('base64url'),
  };
}

export function clientOptionen(
  url: string,
  s: Schluessel,
  zusatz: Partial<TcmsClientOptionen> = {},
): TcmsClientOptionen {
  return {
    config: { url, serviceToken: s.token, actorKeyId: s.kid, actorPrivateKey: s.privat },
    wiederholung: { retries: 2, baseDelayMs: 0 },
    ...zusatz,
  };
}

/** Prüft die empfangene Bestätigung mit dem Code des Dienstes gegen die rohe Anfrage. */
export function pruefeEmpfangen(
  anfrage: Empfangen,
  s: Schluessel,
  jetzt = new Date(),
): PruefErgebnis {
  return pruefeAkteur(String(anfrage.headers['x-tcms-akteur'] ?? ''), {
    schluessel: new Map([[s.kid, s.oeffentlich]]),
    jetzt,
    anfrage: {
      methode: anfrage.methode,
      pfad: anfrage.target,
      bodySha256: bodySha256(anfrage.body),
    },
  });
}

export function payload(anfrage: Empfangen): Record<string, unknown> {
  const token = String(anfrage.headers['x-tcms-akteur'] ?? '');
  return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
}

/** URL eines gerade freigegebenen Ports: Verbindungen werden abgelehnt (ECONNREFUSED). */
export async function geschlossenerPort(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}
