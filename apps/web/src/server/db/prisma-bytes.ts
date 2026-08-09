// Keep this tiny adapter independent from pg-tools. Importing pg-tools into
// ordinary document routes also imports its ENV-configurable child process;
// Next's file tracer then has to conservatively treat the whole project as a
// possible executable location.
export function prismaBytes(value: Buffer | Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(value);
}
