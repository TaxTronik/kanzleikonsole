import {
  encode as defaultEncode,
  decode as defaultDecode,
  type JWT,
  type JWTDecodeParams,
  type JWTEncodeParams,
} from 'next-auth/jwt';

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function createStableSessionJwtOptions(stableSalt: string, decodeSalts: string[]) {
  const salts = unique([stableSalt, ...decodeSalts]);
  return {
    async encode(params: JWTEncodeParams): Promise<string> {
      return defaultEncode({ ...params, salt: stableSalt });
    },
    async decode(params: JWTDecodeParams): Promise<JWT | null> {
      for (const salt of unique([params.salt, ...salts])) {
        const token = await defaultDecode({ ...params, salt }).catch(() => null);
        if (token) return token;
      }
      return null;
    },
  };
}
