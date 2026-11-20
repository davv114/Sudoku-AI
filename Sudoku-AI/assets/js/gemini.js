/**
 * Client Gemini (REST) con Structured Outputs.
 * ------------------------------------------------------------------
 * Due modalità di trasporto:
 *  - "proxy":    la richiesta passa dal server Python locale (server.py),
 *                che custodisce la API key nel file .env. Consigliata.
 *  - "direct":   la richiesta parte dal browser con la chiave salvata
 *                in locale (solo per demo / hosting statico).
 *
 * L'app usa Gemini per due compiti:
 *  1. OCR multimodale della foto  -> matrice 9x9 + angoli della griglia
 *  2. spiegazione in italiano della mossa scelta dal solutore locale
 *     (oppure suggerimento completo, in modalità "solo Gemini").
 */

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const PROXY_PATH = 'api/gemini';
const HEALTH_PATH = 'api/health';

export class GeminiError extends Error {
  constructor(message, code = 'GEMINI_ERROR', details = '') {
    super(message);
    this.name = 'GeminiError';
    this.code = code;
    this.details = details;
  }
}

const OCR_SCHEMA = {
  type: 'OBJECT',
  properties: {
    grid: {
      type: 'ARRAY',
      description: 'Matrice 9x9: 0 = cella vuota, 1-9 = cifra presente nella foto.',
      items: { type: 'ARRAY', items: { type: 'INTEGER' } },
    },
    corners: {
      type: 'ARRAY',
      description:
        'I quattro angoli esterni della griglia 9x9, in coordinate normalizzate 0-1, ' +
        'in ordine: alto-sinistra, alto-destra, basso-destra, basso-sinistra.',
      items: {
        type: 'OBJECT',
        properties: { x: { type: 'NUMBER' }, y: { type: 'NUMBER' } },
        required: ['x', 'y'],
      },
    },
    uncertain: {
      type: 'ARRAY',
      description: 'Celle in cui il riconoscimento è incerto (0-based).',
      items: {
        type: 'OBJECT',
        properties: { row: { type: 'INTEGER' }, col: { type: 'INTEGER' } },
        required: ['row', 'col'],
      },
    },
    notes: {
      type: 'STRING',
      description: 'Breve nota in italiano su qualità dell\'immagine o dubbi.',
    },
  },
  required: ['grid'],
};

const EXPLAIN_SCHEMA = {
  type: 'OBJECT',
  properties: {
    spiegazione: {
      type: 'STRING',
      description: 'Spiegazione logica in italiano, massimo 60 parole, senza markdown.',
    },
    tecnica: { type: 'STRING', description: 'Nome breve della tecnica usata, in italiano.' },
  },
  required: ['spiegazione'],
};

const MOVE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    row: { type: 'INTEGER', description: 'Riga 0-8.' },
    col: { type: 'INTEGER', description: 'Colonna 0-8.' },
    valore: { type: 'INTEGER', description: 'Cifra 1-9 da inserire.' },
    spiegazione: {
      type: 'STRING',
      description: 'Spiegazione logica in italiano, massimo 80 parole, senza markdown.',
    },
    tecnica: { type: 'STRING', description: 'Nome breve della tecnica usata, in italiano.' },
  },
  required: ['row', 'col', 'valore', 'spiegazione'],
};

export const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
export const MODEL_SUGGESTIONS = [
  'gemini-3.5-flash-lite',
  'gemini-3-flash-preview',
  'gemini-3.8-flash',
  'gemini-3.6-flash',
  'gemini-flash-latest',
];

function cleanString(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

function normalizeCorners(raw) {
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  const points = raw.map((point) => {
    if (!point || typeof point !== 'object') return null;
    let x = Number(point.x);
    let y = Number(point.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    // Alcuni modelli restituiscono percentuali 0-100.
    if (x > 1 || y > 1) {
      if (Math.max(x, y) <= 100) {
        x /= 100;
        y /= 100;
      } else {
        return null; // coordinate in pixel: non utilizzabili per l'overlay
      }
    }
    return {
      x: Math.min(1, Math.max(0, x)),
      y: Math.min(1, Math.max(0, y)),
    };
  });
  if (points.some((point) => !point)) return null;
  return points;
}

/** Estrae il testo dalla risposta Gemini ignorando le "thought parts". */
function extractText(response) {
  const candidate = response?.candidates?.[0];
  if (!candidate) {
    const block = response?.promptFeedback?.blockReason;
    if (block) {
      throw new GeminiError(
        `Gemini ha bloccato la richiesta (motivo: ${block}). Prova con un'altra immagine.`,
        'BLOCKED',
      );
    }
    throw new GeminiError('Gemini non ha restituito alcuna risposta. Riprova.', 'EMPTY_RESPONSE');
  }

  if (candidate.finishReason && !['STOP', 'MAX_TOKENS'].includes(candidate.finishReason)) {
    throw new GeminiError(
      `La risposta di Gemini è stata interrotta (${candidate.finishReason}). Riprova.`,
      'FINISH_REASON',
    );
  }

  const text = (candidate.content?.parts ?? [])
    .filter((part) => !part.thought)
    .map((part) => part.text ?? '')
    .join('')
    .trim();

  if (!text) throw new GeminiError('Risposta vuota da Gemini. Riprova.', 'EMPTY_RESPONSE');
  return text;
}

function parseJsonResponse(response) {
  const text = extractText(response);
  const cleaned = text
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        /* continua sotto */
      }
    }
    throw new GeminiError(
      'Gemini ha restituito un JSON non valido. Riprova o cambia modello.',
      'BAD_JSON',
      cleaned.slice(0, 300),
    );
  }
}

function normalizeOcrPayload(payload) {
  const matrix = payload?.grid;
  if (!Array.isArray(matrix) || matrix.length !== 9) {
    throw new GeminiError(
      'Gemini non ha restituito una matrice 9x9 valida. Riprova con una foto più nitida.',
      'BAD_OCR',
    );
  }

  const grid = new Array(81).fill(0);
  for (let r = 0; r < 9; r += 1) {
    const row = matrix[r];
    if (!Array.isArray(row) || row.length !== 9) {
      throw new GeminiError(
        'La matrice riconosciuta non è 9x9. Riprova con una foto più nitida.',
        'BAD_OCR',
      );
    }
    for (let c = 0; c < 9; c += 1) {
      const raw = row[c];
      const value = typeof raw === 'string' ? Number(raw.trim()) : Number(raw);
      grid[r * 9 + c] =
        Number.isInteger(value) && value >= 1 && value <= 9 ? value : 0;
    }
  }

  if (grid.every((value) => value === 0)) {
    throw new GeminiError(
      'Non ho riconosciuto nessun numero. Inquadra meglio la griglia, con buona luce e senza riflessi.',
      'EMPTY_GRID',
    );
  }

  const uncertain = [];
  if (Array.isArray(payload?.uncertain)) {
    for (const item of payload.uncertain) {
      const row = Number(item?.row);
      const col = Number(item?.col);
      if (Number.isInteger(row) && Number.isInteger(col) && row >= 0 && row < 9 && col >= 0 && col < 9) {
        uncertain.push(row * 9 + col);
      }
    }
  }

  return {
    grid,
    corners: normalizeCorners(payload?.corners),
    uncertain: [...new Set(uncertain)],
    notes: cleanString(payload?.notes),
  };
}

export class GeminiClient {
  constructor() {
    this.key = '';
    this.model = DEFAULT_MODEL;
    this.transport = 'none';
    this.proxyAvailable = false;
    this.proxyConfigured = false;
    this.serverModel = '';
    this.fallbackModels = [];
    this.activeModel = '';
    this.healthError = '';
  }

  setCredentials({ key, model } = {}) {
    if (typeof key === 'string') this.key = key.trim();
    if (typeof model === 'string' && model.trim()) this.model = model.trim();
    this.resolveTransport();
  }

  resolveTransport() {
    if (this.proxyConfigured) {
      this.transport = 'proxy';
    } else if (this.key) {
      this.transport = 'direct';
    } else {
      this.transport = 'none';
    }
    return this.transport;
  }

  get ready() {
    return this.transport !== 'none';
  }

  get modeLabel() {
    if (this.transport === 'proxy') return 'Proxy sicuro';
    if (this.transport === 'direct') return 'Chiave nel browser';
    return 'Non configurato';
  }

  /** Controlla se il server Python locale è disponibile e configurato. */
  async init() {
    this.proxyAvailable = false;
    this.proxyConfigured = false;
    this.healthError = '';
    try {
      const response = await fetch(HEALTH_PATH, {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      if (response.ok) {
        const info = await response.json();
        if (info && info.proxy) {
          this.proxyAvailable = true;
          this.proxyConfigured = Boolean(info.configured);
          this.serverModel = typeof info.model === 'string' ? info.model : '';
          this.fallbackModels = Array.isArray(info.fallbackModels) ? info.fallbackModels : [];
          if (!this.serverModel) this.serverModel = DEFAULT_MODEL;
        }
      } else {
        this.healthError = `Il server locale ha risposto ${response.status}.`;
      }
    } catch {
      this.healthError = 'Server locale non rilevato (pagina aperta come file o hosting statico).';
    }
    this.resolveTransport();
    return this.transport;
  }

  mapHttpError(status, data, rawText) {
    const apiMessage = cleanString(data?.error?.message);
    const lower = apiMessage.toLowerCase();

    if (status === 400) {
      if (lower.includes('api key') || lower.includes('api_key')) {
        return new GeminiError(
          'La chiave API non è valida. Controlla di averla copiata da Google AI Studio.',
          'INVALID_KEY',
          apiMessage,
        );
      }
      if (lower.includes('model') && lower.includes('not found')) {
        return new GeminiError(
          `Il modello "${this.model}" non è disponibile. Scegline un altro nelle impostazioni.`,
          'BAD_MODEL',
          apiMessage,
        );
      }
      return new GeminiError(
        'La richiesta è stata rifiutata da Gemini. Controlla immagine e impostazioni.',
        'BAD_REQUEST',
        apiMessage,
      );
    }
    if (status === 401 || status === 403) {
      return new GeminiError(
        'Chiave non autorizzata o permessi insufficienti. Verifica la API key su Google AI Studio.',
        'UNAUTHORIZED',
        apiMessage,
      );
    }
    if (status === 404) {
      return new GeminiError(
        `Modello non trovato ("${this.model}"). Scegli un modello valido nelle impostazioni.`,
        'MODEL_NOT_FOUND',
        apiMessage,
      );
    }
    if (status === 429) {
      return new GeminiError(
        'Troppe richieste: hai raggiunto il limite gratuito di Gemini. Attendi un minuto e riprova.',
        'RATE_LIMIT',
        apiMessage,
      );
    }
    if (status >= 500) {
      return new GeminiError(
        'Gemini è momentaneamente sovraccarico. Riprova tra qualche secondo.',
        'SERVER_ERROR',
        apiMessage,
      );
    }
    return new GeminiError(
      `Errore Gemini (HTTP ${status}).`,
      'HTTP_ERROR',
      apiMessage || rawText.slice(0, 300),
    );
  }

  async generate({ parts, schema = null, temperature = 0.2, timeoutMs = 90000, maxOutputTokens = 4096 }) {
    if (!this.ready) {
      throw new GeminiError(
        'Nessuna API key configurata. Apri le impostazioni e inserisci la chiave Gemini, oppure avvia server.py con il file .env.',
        'NO_KEY',
      );
    }

    const body = {
      contents: [{ role: 'user', parts }],
      generationConfig: {
        temperature,
        maxOutputTokens,
      },
    };
    if (schema) {
      body.generationConfig.responseMimeType = 'application/json';
      body.generationConfig.responseSchema = schema;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      let response;
      if (this.transport === 'proxy') {
        response = await fetch(PROXY_PATH, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ model: this.model, ...body }),
          signal: controller.signal,
        });
      } else {
        response = await fetch(`${API_BASE}/${encodeURIComponent(this.model)}:generateContent`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': this.key,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      }

      const rawText = await response.text();
      let data = null;
      try {
        data = rawText ? JSON.parse(rawText) : null;
      } catch {
        data = null;
      }

      if (!response.ok) {
        throw this.mapHttpError(response.status, data, rawText);
      }
      if (this.transport === 'proxy') {
        // Il proxy può aver usato un modello di fallback: allineiamo le
        // impostazioni solo se il modello scelto è stato ritirato da Google.
        // Per un semplice picco di sovraccarico il ripiego è temporaneo e la
        // preferenza dell'utente resta invariata.
        const used = response.headers.get('X-Gemini-Model');
        const retired = response.headers.get('X-Gemini-Retired') === '1';
        if (used && used !== this.model) {
          const previous = this.model;
          if (retired) this.model = used;
          this.activeModel = used;
          window.dispatchEvent(
            new CustomEvent('gemini:model-changed', {
              detail: { previous, model: used, permanent: retired },
            }),
          );
        } else if (used) {
          this.activeModel = used;
        }
      }
      if (!data) {
        throw new GeminiError('Risposta non leggibile da Gemini. Riprova.', 'BAD_RESPONSE');
      }
      return data;
    } catch (error) {
      if (error instanceof GeminiError) throw error;
      if (error?.name === 'AbortError') {
        throw new GeminiError(
          'La richiesta ha impiegato troppo tempo. Riprova con una foto più piccola o controlla la connessione.',
          'TIMEOUT',
        );
      }
      throw new GeminiError(
        'Impossibile contattare Gemini. Controlla la connessione a Internet e riprova.',
        'NETWORK',
        error?.message ?? '',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** OCR: foto -> matrice 9x9 (+ angoli della griglia per l'overlay). */
  async readSudoku(imageDataUrl) {
    const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(imageDataUrl ?? '');
    if (!match) {
      throw new GeminiError("Formato immagine non riconosciuto. Usa JPG, PNG o WEBP.", 'BAD_IMAGE');
    }

    const prompt = [
      'Sei un OCR specializzato in Sudoku. Analizza l\'immagine fornita.',
      'La foto può essere ruotata, inclinata o in prospettiva, con luce non uniforme.',
      'Estrai SOLO i numeri che l\'utente ha scritto nello schema 9x9: ignora appunti a margine,',
      'candidati segnati in piccolo, loghi e scritte.',
      'Le cifre scritte a mano vanno lette con attenzione (1, 7 e 4 sono spesso ambigui).',
      'Restituisci un oggetto JSON con:',
      '- "grid": matrice 9x9 di interi, dove 0 = cella vuota e 1-9 = cifra presente.',
      '- "corners": i 4 angoli ESTERNI della griglia 9x9 in coordinate normalizzate 0-1,',
      '  nell\'ordine alto-sinistra, alto-destra, basso-destra, basso-sinistra.',
      '- "uncertain": elenco delle celle (row, col, indici 0-8) di cui non sei sicuro.',
      '- "notes": una frase breve in italiano sulla qualità dell\'immagine.',
      'Non aggiungere markdown né testo fuori dal JSON.',
    ].join(' ');

    const response = await this.generate({
      parts: [
        { text: prompt },
        { inlineData: { mimeType: match[1], data: match[2] } },
      ],
      schema: OCR_SCHEMA,
      temperature: 0,
      timeoutMs: 120000,
      maxOutputTokens: 2500,
    });

    return normalizeOcrPayload(parseJsonResponse(response));
  }

  /** Spiegazione della mossa scelta localmente (solutore ibrido). */
  async explainMove({ grid, move, candidates = [] }) {
    const prompt = [
      'Sei un tutor di Sudoku per studenti italiani. Ti fornisco la griglia incompleta,',
      'la mossa scelta da un solutore locale (verificata e corretta) e la tecnica usata.',
      'Spiega in italiano, in massimo 60 parole, PERCHÉ quella cifra va in quella cella,',
      'citando riga, colonna e blocco e il ragionamento di esclusione.',
      'Non proporre altre mosse, non riscrivere la griglia, non usare markdown.',
      '',
      `Griglia (0 = vuota, righe separate da ;): ${grid.join('')}`,
      `Mossa: riga ${move.row + 1}, colonna ${move.col + 1}, valore ${move.value}.`,
      `Tecnica locale: ${move.technique}.`,
      candidates.length ? `Candidati della cella prima della mossa: ${candidates.join(', ')}.` : '',
    ].join('\n');

    const response = await this.generate({
      parts: [{ text: prompt }],
      schema: EXPLAIN_SCHEMA,
      temperature: 0.35,
      timeoutMs: 50000,
      maxOutputTokens: 800,
    });

    const data = parseJsonResponse(response);
    const explanation = cleanString(data?.spiegazione);
    if (!explanation) {
      throw new GeminiError('Gemini non ha prodotto una spiegazione valida.', 'BAD_EXPLANATION');
    }
    return {
      explanation,
      technique: cleanString(data?.tecnica, move.technique),
    };
  }

  /** Modalità "solo Gemini": il modello propone la prossima mossa. */
  async suggestMove(grid) {
    const prompt = [
      'Data la seguente matrice Sudoku 9x9 incompleta, trova LA PROSSIMA mossa più facile',
      'ed evidente da compiere (singolo nudo o singolo nascosto se possibile).',
      `Matrice (0 = cella vuota, righe separate da ;): ${grid.join('')}`,
      'Restituisci un JSON con: row (0-8), col (0-8), valore (1-9),',
      'spiegazione (in italiano, max 70 parole) e tecnica (nome breve in italiano).',
      'La mossa deve essere certa: non azzardare se non hai una deduzione logica.',
    ].join('\n');

    const response = await this.generate({
      parts: [{ text: prompt }],
      schema: MOVE_SCHEMA,
      temperature: 0.1,
      timeoutMs: 50000,
      maxOutputTokens: 800,
    });

    const data = parseJsonResponse(response);
    return {
      row: Number(data?.row),
      col: Number(data?.col),
      value: Number(data?.valore),
      explanation: cleanString(data?.spiegazione),
      technique: cleanString(data?.tecnica, 'Suggerimento Gemini'),
    };
  }

  /** Piccola chiamata di test per il pulsante "Verifica connessione". */
  async ping() {
    const response = await this.generate({
      parts: [{ text: 'Rispondi esattamente con la parola: OK' }],
      temperature: 0,
      timeoutMs: 40000,
    });
    return extractText(response);
  }
}
