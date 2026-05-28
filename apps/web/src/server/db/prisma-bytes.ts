export function prismaBytes(value: Buffer | Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(value);
}
