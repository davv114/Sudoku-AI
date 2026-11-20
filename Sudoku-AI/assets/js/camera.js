/**
 * Gestione della fotocamera (getUserMedia) e preparazione dell'immagine.
 * L'immagine viene ridimensionata lato client per ridurre latenza e costi API.
 */

const MAX_SIDE = 1600;

export class CameraError extends Error {
  constructor(message, code = 'CAMERA_ERROR') {
    super(message);
    this.name = 'CameraError';
    this.code = code;
  }
}

export class CameraController {
  constructor(videoElement) {
    this.video = videoElement;
    this.stream = null;
    this.facing = 'environment';
  }

  get supported() {
    return Boolean(navigator.mediaDevices?.getUserMedia);
  }

  async start(facing = this.facing) {
    if (!this.supported) {
      throw new CameraError(
        window.isSecureContext
          ? 'Questo browser non supporta la fotocamera. Carica un file immagine.'
          : 'La fotocamera richiede HTTPS o localhost. Apri l\'app con server.py o carica un file.',
        'UNSUPPORTED',
      );
    }

    this.stop();
    this.facing = facing;

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: facing },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      });
    } catch (error) {
      const name = error?.name ?? '';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        throw new CameraError(
          'Permesso fotocamera negato. Abilitalo dalle impostazioni del browser oppure carica un file.',
          'DENIED',
        );
      }
      if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        throw new CameraError(
          'Nessuna fotocamera trovata. Carica un file immagine dal dispositivo.',
          'NOT_FOUND',
        );
      }
      if (name === 'NotReadableError' || name === 'TrackStartError') {
        throw new CameraError(
          'La fotocamera è occupata da un\'altra applicazione. Chiudila e riprova.',
          'IN_USE',
        );
      }
      throw new CameraError(
        'Impossibile avviare la fotocamera. Carica un file immagine.',
        'START_FAILED',
      );
    }

    this.video.srcObject = this.stream;
    this.video.classList.toggle('is-mirrored', facing === 'user');
    try {
      await this.video.play();
    } catch {
      /* autoplay può richiedere un gesto: il flusso è comunque pronto */
    }
    return this.stream;
  }

  async switchCamera() {
    return this.start(this.facing === 'environment' ? 'user' : 'environment');
  }

  /** Cattura un frame ridimensionato e restituisce un dataURL JPEG. */
  capture() {
    const width = this.video.videoWidth;
    const height = this.video.videoHeight;
    if (!width || !height) {
      throw new CameraError('La fotocamera non è ancora pronta. Attendi un istante e riprova.', 'NOT_READY');
    }

    const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);

    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(this.video, 0, 0, canvas.width, canvas.height);

    return canvas.toDataURL('image/jpeg', 0.9);
  }

  stop() {
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    if (this.video) this.video.srcObject = null;
  }
}

/**
 * Ridimensiona un file immagine e restituisce un dataURL JPEG.
 * Utile prima dell'invio a Gemini (le foto da smartphone sono enormi).
 */
export function fileToDataUrl(file, maxSide = MAX_SIDE) {
  return new Promise((resolve, reject) => {
    if (!file) {
      reject(new Error('Nessun file selezionato.'));
      return;
    }
    if (!/^image\//.test(file.type)) {
      reject(new Error('Il file selezionato non è un\'immagine.'));
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      reject(new Error('Immagine troppo grande (massimo 25 MB).'));
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    const image = new Image();

    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));

      const context = canvas.getContext('2d');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);

      resolve({
        dataUrl: canvas.toDataURL('image/jpeg', 0.9),
        width: canvas.width,
        height: canvas.height,
        name: file.name,
      });
    };

    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Impossibile leggere l\'immagine. Prova con un altro file.'));
    };

    image.src = objectUrl;
  });
}
