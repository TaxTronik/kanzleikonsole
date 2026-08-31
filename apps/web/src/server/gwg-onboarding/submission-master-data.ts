export interface OnboardingMasterDataInput {
  companyName: string;
  street: string;
  postalCode: string;
  city: string;
  countryIso: string;
  vatId?: string;
}

export interface CurrentOnboardingClientMasterData {
  name: string;
  street: string | null;
  postalCode: string | null;
  city: string | null;
  countryIso: string | null;
  vatId?: string | null;
}

export interface OnboardingClientMasterSnapshot {
  name: string;
  street: string;
  postalCode: string;
  city: string;
  countryIso: string;
}

export interface OnboardingClientMasterChange {
  before: CurrentOnboardingClientMasterData;
  after: OnboardingClientMasterSnapshot;
  changedFields: Array<keyof OnboardingClientMasterSnapshot>;
}

/** Builds the normalized client snapshot and the exact field-level audit diff. */
export function buildOnboardingClientMasterChange(
  current: CurrentOnboardingClientMasterData,
  submitted: OnboardingMasterDataInput,
): OnboardingClientMasterChange {
  const before = {
    name: current.name,
    street: current.street,
    postalCode: current.postalCode,
    city: current.city,
    countryIso: current.countryIso,
  };
  const after = {
    name: submitted.companyName.trim(),
    street: submitted.street.trim(),
    postalCode: submitted.postalCode.trim(),
    city: submitted.city.trim(),
    countryIso: submitted.countryIso.trim(),
  };
  const changedFields: Array<keyof OnboardingClientMasterSnapshot> = [];
  for (const field of ['name', 'street', 'postalCode', 'city', 'countryIso'] as const) {
    if (before[field] !== after[field]) changedFields.push(field);
  }
  return { before, after, changedFields };
}
