export interface AccessibleDisplayOptions {
  fontSize: 'standard' | 'large' | 'extra-large';
  spacing: 'normal' | 'relaxed' | 'wide';
  contrast: 'standard' | 'strong';
  reduceMotion: boolean;
}

export const DEFAULT_DISPLAY_OPTIONS: Readonly<AccessibleDisplayOptions> = Object.freeze({
  fontSize: 'large',
  spacing: 'relaxed',
  contrast: 'strong',
  reduceMotion: true,
});

const CHOICES = {
  fontSize: ['standard', 'large', 'extra-large'],
  spacing: ['normal', 'relaxed', 'wide'],
  contrast: ['standard', 'strong'],
} as const;

export type DisplayOptionsPatch = Partial<AccessibleDisplayOptions>;

/** Only named display fields are writable; no IDs, CSS or arbitrary profile data. */
export function parseDisplayOptionsPatch(value: unknown): DisplayOptionsPatch | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (!entries.length || entries.length > 4) return null;
  const result: DisplayOptionsPatch = {};
  for (const [key, option] of entries) {
    if (key === 'reduceMotion') {
      if (typeof option !== 'boolean') return null;
      result.reduceMotion = option;
    } else if (key === 'fontSize' || key === 'spacing' || key === 'contrast') {
      if (typeof option !== 'string' || !(CHOICES[key] as readonly string[]).includes(option))
        return null;
      Object.assign(result, { [key]: option });
    } else return null;
  }
  return result;
}

export const DISPLAY_OPTIONS_SELECT = {
  accessibleDisplayFontSize: true,
  accessibleDisplaySpacing: true,
  accessibleDisplayContrast: true,
  accessibleDisplayReduceMotion: true,
} as const;

/** Defensive defaults also support accounts created before this additive migration. */
export function displayOptionsFromProfile(
  profile:
    | {
        accessibleDisplayFontSize?: unknown;
        accessibleDisplaySpacing?: unknown;
        accessibleDisplayContrast?: unknown;
        accessibleDisplayReduceMotion?: unknown;
      }
    | null
    | undefined,
): AccessibleDisplayOptions {
  return {
    ...DEFAULT_DISPLAY_OPTIONS,
    ...parseDisplayOptionsPatch({ fontSize: profile?.accessibleDisplayFontSize }),
    ...parseDisplayOptionsPatch({ spacing: profile?.accessibleDisplaySpacing }),
    ...parseDisplayOptionsPatch({ contrast: profile?.accessibleDisplayContrast }),
    ...parseDisplayOptionsPatch({ reduceMotion: profile?.accessibleDisplayReduceMotion }),
  };
}

/** Patch only requested columns: changing font size never overwrites another tab's contrast. */
export function displayOptionsToColumns(patch: DisplayOptionsPatch) {
  return {
    ...(patch.fontSize !== undefined ? { accessibleDisplayFontSize: patch.fontSize } : {}),
    ...(patch.spacing !== undefined ? { accessibleDisplaySpacing: patch.spacing } : {}),
    ...(patch.contrast !== undefined ? { accessibleDisplayContrast: patch.contrast } : {}),
    ...(patch.reduceMotion !== undefined
      ? { accessibleDisplayReduceMotion: patch.reduceMotion }
      : {}),
  };
}
