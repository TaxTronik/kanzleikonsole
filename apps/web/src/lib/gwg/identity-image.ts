import type { IdentityViewport } from './identity-viewport';
import type { IdentityOcrResult } from './identity-ocr';

const ASSETS = '/identity-assets';
const MAX_PIXELS = 12_000_000;

export interface IdentityImage {
  pages: number;
  render(page: number): Promise<HTMLCanvasElement>;
  dispose(): void;
}

export async function loadIdentityImage(blob: Blob): Promise<IdentityImage> {
  if (blob.size > 25 * 1024 * 1024) throw new Error('Die Datei ist für die Ausweishilfe zu groß.');
  if (blob.type === 'application/pdf') {
    const pdfjs = await import('pdfjs-dist');
    pdfjs.GlobalWorkerOptions.workerSrc = `${ASSETS}/pdf.worker.min.mjs`;
    const loading = pdfjs.getDocument({
      data: new Uint8Array(await blob.arrayBuffer()),
      cMapUrl: `${ASSETS}/cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${ASSETS}/standard_fonts/`,
      wasmUrl: `${ASSETS}/wasm/`,
      enableXfa: false,
      stopAtErrors: true,
    });
    const pdf = await loading.promise;
    if (pdf.numPages > 100) {
      await loading.destroy();
      throw new Error('Bitte eine PDF mit höchstens 100 Seiten verwenden.');
    }
    return {
      pages: pdf.numPages,
      async render(pageNumber) {
        const page = await pdf.getPage(pageNumber);
        const natural = page.getViewport({ scale: 1 });
        const scale = Math.min(2.5, Math.sqrt(MAX_PIXELS / (natural.width * natural.height)));
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        await page.render({ canvas, viewport }).promise;
        page.cleanup();
        return canvas;
      },
      dispose() {
        void loading.destroy();
      },
    };
  }
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(blob.type)) {
    throw new Error(
      'Die Ausweishilfe unterstützt JPG, PNG und PDF. Diese Datei bitte manuell erfassen.',
    );
  }
  const bitmap = await createImageBitmap(blob);
  return {
    pages: 1,
    async render() {
      const scale = Math.min(1, Math.sqrt(MAX_PIXELS / (bitmap.width * bitmap.height)));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return canvas;
    },
    dispose() {
      bitmap.close();
    },
  };
}

export function cropIdentityImage(
  source: HTMLCanvasElement,
  view: IdentityViewport,
): HTMLCanvasElement {
  const width = Math.max(1, Math.round(source.width * view.width));
  const height = Math.max(1, Math.round(source.height * view.height));
  const canvas = document.createElement('canvas');
  const sideways = view.rotation === 90 || view.rotation === 270;
  canvas.width = sideways ? height : width;
  canvas.height = sideways ? width : height;
  const context = canvas.getContext('2d')!;
  context.translate(canvas.width / 2, canvas.height / 2);
  context.rotate((view.rotation * Math.PI) / 180);
  context.drawImage(
    source,
    source.width * view.x,
    source.height * view.y,
    width,
    height,
    -width / 2,
    -height / 2,
    width,
    height,
  );
  return canvas;
}

/**
 * Vergrößerungsfaktor für die OCR: kleine Aufnahmen (z. B. ~1000 px breit) auf
 * etwa 2000 px, höchstens doppelt; große Aufnahmen bleiben, MAX_PIXELS gilt.
 */
export function ocrScale(width: number, height: number): number {
  const target = Math.min(2, Math.max(1, 2000 / Math.max(width, height, 1)));
  return Math.min(target, Math.sqrt(MAX_PIXELS / Math.max(1, width * height)));
}

/** Luminanz nach ITU-R BT.601; Farbhintergründe (Guillochen) stören die OCR weniger. */
export function grayscaleInPlace(data: Uint8ClampedArray): void {
  for (let index = 0; index < data.length; index += 4) {
    const luma = Math.round(
      0.299 * data[index]! + 0.587 * data[index + 1]! + 0.114 * data[index + 2]!,
    );
    data[index] = luma;
    data[index + 1] = luma;
    data[index + 2] = luma;
  }
}

/**
 * Kontrast auf das 1.–99. Perzentil der Graustufen strecken (nach
 * grayscaleInPlace). Mit dem Muster des Bundes las Tesseract danach die
 * Namenszeile der maschinenlesbaren Zone sauber.
 */
export function stretchContrastInPlace(data: Uint8ClampedArray): void {
  const histogram = new Array<number>(256).fill(0);
  for (let index = 0; index < data.length; index += 4) histogram[data[index]!]!++;
  const clip = (data.length / 4) * 0.01;
  let low = 0;
  for (let sum = 0; low < 255 && (sum += histogram[low]!) < clip; ) low++;
  let high = 255;
  for (let sum = 0; high > 0 && (sum += histogram[high]!) < clip; ) high--;
  if (high <= low) return;
  const factor = 255 / (high - low);
  for (let index = 0; index < data.length; index += 4) {
    const value = Math.max(0, Math.min(255, Math.round((data[index]! - low) * factor)));
    data[index] = value;
    data[index + 1] = value;
    data[index + 2] = value;
  }
}

/** Nur für die Erkennung: das Original und der gespeicherte Ausschnitt bleiben unverändert. */
function prepareForOcr(source: HTMLCanvasElement): HTMLCanvasElement {
  const scale = ocrScale(source.width, source.height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(source.width * scale));
  canvas.height = Math.max(1, Math.round(source.height * scale));
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  grayscaleInPlace(pixels.data);
  stretchContrastInPlace(pixels.data);
  context.putImageData(pixels, 0, 0);
  return canvas;
}

export async function recognizeIdentityImage(
  source: HTMLCanvasElement,
  signal: AbortSignal,
  onProgress: (progress: number) => void,
): Promise<IdentityOcrResult> {
  signal.throwIfAborted();
  const canvas = prepareForOcr(source);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (value) => (value ? resolve(value) : reject(new Error('Bild nicht lesbar.'))),
      'image/png',
    ),
  );
  const image = new Uint8Array(await blob.arrayBuffer());
  signal.throwIfAborted();
  const worker = new Worker(new URL('./identity-ocr-worker.ts', import.meta.url), {
    type: 'module',
  });
  let abort: (() => void) | undefined;
  try {
    return await new Promise<IdentityOcrResult>((resolve, reject) => {
      abort = () => reject(new DOMException('Abgebrochen', 'AbortError'));
      signal.addEventListener('abort', abort, { once: true });
      worker.onerror = () => reject(new Error('Lokale Erkennung nicht verfügbar.'));
      worker.onmessage = (
        event: MessageEvent<{ progress?: number; result?: IdentityOcrResult; error?: boolean }>,
      ) => {
        if (event.data.result) resolve(event.data.result);
        else if (event.data.error) reject(new Error('Lokale Erkennung fehlgeschlagen.'));
        else if (typeof event.data.progress === 'number') onProgress(event.data.progress);
      };
      worker.postMessage({ image, assets: new URL(ASSETS, location.origin).href }, [image.buffer]);
    });
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
    worker.terminate();
  }
}
