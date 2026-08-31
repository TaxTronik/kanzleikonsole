/// <reference lib="webworker" />
import { createWorker, OEM, PSM } from 'tesseract.js';
import { parseGermanIdentityText } from './identity-ocr';

// A short-lived parent worker makes cancellation effective during model loading too.
// Terminating it also terminates the dedicated child created by Tesseract.
self.onmessage = async (event: MessageEvent<{ image: Uint8Array; assets: string }>) => {
  let engine: Awaited<ReturnType<typeof createWorker>> | undefined;
  try {
    const assets = event.data.assets;
    engine = await createWorker(['deu', 'eng'], OEM.LSTM_ONLY, {
      workerPath: `${assets}/ocr-worker.js`,
      corePath: `${assets}/`,
      langPath: assets,
      workerBlobURL: false,
      cacheMethod: 'none',
      logger(message) {
        if (message.status === 'recognizing text') self.postMessage({ progress: message.progress });
      },
      errorHandler() {
        /* Never emit raw text or personal worker payloads. */
      },
    });
    await engine.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
    const { data } = await engine.recognize(
      new Blob([new Uint8Array(event.data.image)], { type: 'image/png' }),
      {},
      { text: true },
    );
    const result = parseGermanIdentityText(data.text);
    if (data.confidence < 75)
      result.warnings.unshift(
        'Geringe Erkennungssicherheit. Bitte alle Vorschläge sorgfältig vergleichen.',
      );
    self.postMessage({ result });
  } catch {
    self.postMessage({ error: true });
  } finally {
    await engine?.terminate();
  }
};
