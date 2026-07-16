export const POA_CREATE_RETURN_CONTEXTS = ['onboarding'] as const;

export type PoaCreateReturnContext = (typeof POA_CREATE_RETURN_CONTEXTS)[number];

export function parsePoaCreateReturnContext(value: unknown): PoaCreateReturnContext | undefined {
  return value === 'onboarding' ? value : undefined;
}

export function poaCreateSuccessHref({
  clientId,
  poaId,
  returnContext,
}: {
  clientId: string;
  poaId: string;
  returnContext?: PoaCreateReturnContext;
}): string {
  if (returnContext === 'onboarding') {
    return `/staff/clients/onboarding/${encodeURIComponent(clientId)}?step=poa`;
  }
  return `/staff/poa/${encodeURIComponent(poaId)}`;
}

export function poaCreateResumeHref({
  clientId,
  pendingDocumentId,
  returnContext,
}: {
  clientId: string;
  pendingDocumentId: string;
  returnContext?: PoaCreateReturnContext;
}): string {
  const params = new URLSearchParams({ clientId, pendingDocumentId });
  if (returnContext) params.set('from', returnContext);
  return `/staff/poa/new?${params.toString()}`;
}
