import type { TenantContext } from '@taxtronik/db';
import type { N8nConfig } from '@/server/settings/n8n';
import { defaultN8nCallbackBase } from '@/server/settings/n8n';
import {
  grantN8nCallbackScopes,
  rotateN8nCallbackCredential,
} from '@/server/n8n/callback-credentials';
import { N8nApiClient, type N8nCredentialBinding } from '@/server/n8n/client';

export interface N8nCallbackCredentialDisplay {
  keyId: string;
  token: string;
  baseUrl: string;
  scopes: string[];
}

export interface N8nCallbackImportSetup {
  binding: N8nCredentialBinding | null;
  configured: boolean;
  credential?: N8nCallbackCredentialDisplay;
  warning?: string;
}

export function managedCallbackCredentialName(callbackKeyId: string): string {
  return `TaxTronik Rückkanal ${callbackKeyId}`;
}

function callbackBaseUrl(cfg: N8nConfig): string {
  return `${(cfg.callbackBaseUrl || defaultN8nCallbackBase(cfg.kind)).replace(/\/$/, '')}/api/integrations/n8n/v1`;
}

async function findManagedCredential(
  client: N8nApiClient,
  callbackKeyId: string,
): Promise<N8nCredentialBinding | null> {
  const name = managedCallbackCredentialName(callbackKeyId);
  const found = (await client.listCredentials()).find(
    (credential) => credential.name === name && credential.type === 'httpHeaderAuth',
  );
  return found ? { id: found.id, name: found.name, type: found.type } : null;
}

/**
 * Richtet den TaxTronik-Rückkanal beim Import möglichst vollständig ein.
 * Fehlt dem n8n-API-Key `credential:create`, bleibt der Import erlaubt und der
 * Klartext wird einmalig für die manuelle Header-Auth-Anlage zurückgegeben.
 */
export async function prepareN8nCallbackImport(
  ctx: TenantContext,
  cfg: N8nConfig,
  client: N8nApiClient,
  requiredScopes: string[],
): Promise<N8nCallbackImportSetup> {
  if (requiredScopes.length === 0) return { binding: null, configured: cfg.callbackConfigured };
  const scopes = [...new Set([...cfg.callbackScopes, ...requiredScopes])].sort();

  if (cfg.callbackConfigured) {
    if (scopes.some((scope) => !cfg.callbackScopes.includes(scope))) {
      await grantN8nCallbackScopes(ctx, scopes);
    }
    try {
      const binding = await findManagedCredential(client, cfg.callbackKeyId);
      return {
        binding,
        configured: true,
        warning: binding
          ? undefined
          : 'Das bestehende Callback-Credential konnte nicht automatisch zugeordnet werden. Bitte in n8n an den importierten HTTP-Request-Nodes auswählen.',
      };
    } catch {
      return {
        binding: null,
        configured: true,
        warning:
          'Der API-Key darf n8n-Credentials nicht auflisten. Die Vorlagen wurden ohne automatische Credential-Zuordnung importiert.',
      };
    }
  }

  const rotated = await rotateN8nCallbackCredential(ctx, scopes);
  const name = managedCallbackCredentialName(rotated.connection.callbackKeyId);
  try {
    const binding = await client.createCredential({
      name,
      type: 'httpHeaderAuth',
      data: {
        name: 'Authorization',
        value: `Bearer ${rotated.connection.callbackKeyId}.${rotated.token}`,
      },
    });
    return { binding, configured: true };
  } catch {
    return {
      binding: null,
      configured: true,
      credential: {
        keyId: rotated.connection.callbackKeyId,
        token: rotated.token,
        baseUrl: callbackBaseUrl(cfg),
        scopes,
      },
      warning:
        'Der n8n-API-Key besitzt kein credential:create-Recht oder n8n lehnte die Credential-Anlage ab. Das Callback-Token wird deshalb einmalig zur manuellen Anlage angezeigt.',
    };
  }
}
