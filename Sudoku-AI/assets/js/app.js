/**
 * Sudoku Vision · controller dell'applicazione
 * ------------------------------------------------------------------
 * Flusso: foto -> OCR Gemini -> verifica manuale -> suggerimento
 * spiegato oppure soluzione completa. Il motore locale resta sempre
 * la fonte di verità per le mosse; Gemini aggiunge la spiegazione.
 */

import {
  BOXES,
  cellName,
  countFilled,
  findHint,
  isComplete,
  isLegalMove,
  parseGrid,
  solveGrid,
  validateGrid,
  candidatesFor,
  boxOf,
} from './sudoku.js';
import { SAMPLES, getSample } from './samples.js';
import {
  GeminiClient,
  GeminiError,
  DEFAULT_MODEL,
  MODEL_SUGGESTIONS,
} from './gemini.js';
import { CameraController, fileToDataUrl } from './camera.js';
import { SpeechEngine } from './speech.js';
import { PhotoOverlay, DEFAULT_CORNERS } from './overlay.js';

const SETTINGS_KEY = 'sudoku-vision:settings:v1';
const STATE_KEY = 'sudoku-vision:state:v1';
const CELL_COUNT = 81;

const $ = (id) => document.getElementById(id);

const els = {
  modePill: $('mode-pill'),
  modeLabel: $('mode-label'),
  settingsButton: $('btn-settings'),
  steps: $('steps'),
  grid: $('grid'),
  gridScan: $('grid-scan'),
  gridStatus: $('grid-status'),
  statusDot: $('status-dot'),
  sourceBadge: $('source-badge'),
  conflictBadge: $('conflict-badge'),
  hintButton: $('btn-hint'),
  solveButton: $('btn-solve'),
  undoButton: $('btn-undo'),
  clearButton: $('btn-clear'),
  hintLevel: $('hint-level'),
  dropzone: $('dropzone'),
  fileInput: $('file-input'),
  cameraButton: $('btn-camera'),
  fileButton: $('btn-file'),
  photoPreview: $('photo-preview'),
  photoThumbButton: $('photo-thumb-btn'),
  photoThumb: $('photo-thumb'),
  photoName: $('photo-name'),
  photoState: $('photo-state'),
  reocrButton: $('btn-reocr'),
  changePhotoButton: $('btn-change-photo'),
  overlayButton: $('btn-overlay'),
  ocrProgress: $('ocr-progress'),
  ocrElapsed: $('ocr-elapsed'),
  ocrBar: $('ocr-bar'),
  ocrError: $('ocr-error'),
  ocrErrorTitle: $('ocr-error-title'),
  ocrErrorText: $('ocr-error-text'),
  ocrRetryButton: $('btn-ocr-retry'),
  ocrManualButton: $('btn-ocr-manual'),
  samples: $('samples'),
  avatar: $('avatar'),
  tutorTitle: $('tutor-title'),
  tutorText: $('tutor-text'),
  hintDetail: $('hint-detail'),
  hintTechnique: $('hint-technique'),
  hintCoord: $('hint-coord'),
  hintSource: $('hint-source'),
  hintExplanation: $('hint-explanation'),
  candidateRow: $('candidate-row'),
  candidateChips: $('candidate-chips'),
  speakButton: $('btn-speak'),
  nextLevelButton: $('btn-next-level'),
  cameraDialog: $('camera-dialog'),
  cameraVideo: $('camera-video'),
  cameraError: $('camera-error'),
  cameraSwitch: $('btn-camera-switch'),
  cameraFallback: $('btn-camera-fallback'),
  cameraShot: $('btn-camera-shot'),
  overlayDialog: $('overlay-dialog'),
  overlayCanvas: $('overlay-canvas'),
  overlayNote: $('overlay-note'),
  overlayOnlyAi: $('overlay-only-ai'),
  overlayEdit: $('btn-overlay-edit'),
  overlayReset: $('btn-overlay-reset'),
  overlayClose: $('btn-overlay-close'),
  overlayCloseX: $('btn-overlay-close-x'),
  settingsDialog: $('settings-dialog'),
  settingsKey: $('settings-key'),
  saveKeyButton: $('btn-save-key'),
  removeKeyButton: $('btn-remove-key'),
  testApiButton: $('btn-test-api'),
  settingsModel: $('settings-model'),
  modelOptions: $('model-options'),
  settingsEngine: $('settings-engine'),
  settingsSpeech: $('settings-speech'),
  apiStatus: $('api-status'),
  apiStatusTitle: $('api-status-title'),
  apiStatusText: $('api-status-text'),
  toastStack: $('toast-stack'),
  footerYear: $('footer-year'),
};

const state = {
  grid: new Array(CELL_COUNT).fill(0),
  givens: new Set(),
  ai: new Set(),
  uncertain: new Set(),
  conflicts: new Set(),
  hint: null,
  hintLevel: 3,
  history: [],
  photo: null,
  source: '',
  busy: false,
  ocrRunning: false,
  solving: false,
  toldLocal: false,
};

let settings = {
  key: '',
  model: '',
  modelPinned: false,
  engine: 'hybrid',
  speech: false,
};

let settingsWereSaved = false;

const cellEls = [];
const gemini = new GeminiClient();
const speech = new SpeechEngine();
const camera = new CameraController(els.cameraVideo);
let overlay = null;
let ocrTimer = null;
let ocrHideTimer = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ */
/* Persistenza                                                         */
/* ------------------------------------------------------------------ */

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    settings = {
      key: typeof parsed.key === 'string' ? parsed.key : '',
      model: typeof parsed.model === 'string' ? parsed.model : '',
      modelPinned: parsed.modelPinned === true,
      engine: ['hybrid', 'gemini', 'local'].includes(parsed.engine) ? parsed.engine : 'hybrid',
      speech: Boolean(parsed.speech),
    };
    // Migrazione una tantum: le versioni precedenti salvavano come preferenza
    // anche il modello usato per un ripiego temporaneo. Se l'utente non ha
    // scelto esplicitamente un modello, si torna al predefinito (il più veloce).
    if (!settings.modelPinned) {
      settings.model = DEFAULT_MODEL;
    }
    settingsWereSaved = true;
  } catch {
    /* localStorage non disponibile: si procede con i valori di default */
  }
}

function persistSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* ignora quota/privacy mode */
  }
}

function saveState() {
  try {
    localStorage.setItem(
      STATE_KEY,
      JSON.stringify({
        grid: state.grid,
        givens: [...state.givens],
        ai: [...state.ai],
        source: state.source,
      }),
    );
  } catch {
    /* ignora */
  }
}

function restoreState() {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    const grid = parseGrid(data.grid);
    if (!grid.some(Boolean)) return false;

    state.grid = grid;
    state.givens = new Set((Array.isArray(data.givens) ? data.givens : []).filter((i) => grid[i]));
    state.ai = new Set(
      (Array.isArray(data.ai) ? data.ai : []).filter((i) => grid[i] && !state.givens.has(i)),
    );

    // Ogni numero non classificato è considerato un indizio del puzzle.
    grid.forEach((value, index) => {
      if (value && !state.givens.has(index) && !state.ai.has(index)) state.givens.add(index);
    });
    state.source = typeof data.source === 'string' ? data.source : 'Griglia salvata';
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Rendering griglia                                                   */
/* ------------------------------------------------------------------ */

function buildGrid() {
  const fragment = document.createDocumentFragment();
  for (let index = 0; index < CELL_COUNT; index += 1) {
    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'numeric';
    input.autocomplete = 'off';
    input.maxLength = 1;
    input.spellcheck = false;
    input.className = 'cell';
    input.dataset.index = String(index);
    input.setAttribute('role', 'gridcell');

    const row = Math.floor(index / 9);
    const col = index % 9;
    if (col === 8) input.classList.add('edge-right');
    if (row === 8) input.classList.add('edge-bottom');
    if (col === 2 || col === 5) input.classList.add('b-right');
    if (row === 2 || row === 5) input.classList.add('b-bottom');

    input.addEventListener('input', onCellInput);
    input.addEventListener('keydown', onCellKeyDown);
    input.addEventListener('focus', onCellFocus);

    cellEls.push(input);
    fragment.append(input);
  }
  els.grid.append(fragment);
}

function onCellFocus(event) {
  event.target.select();
}

function onCellInput(event) {
  const input = event.target;
  const index = Number(input.dataset.index);
  const raw = input.value;

  if (raw === '') {
    handleUserInput(index, 0);
    return;
  }

  const digits = raw.replace(/[^0-9]/g, '');
  if (!digits) {
    input.value = state.grid[index] ? String(state.grid[index]) : '';
    return;
  }

  handleUserInput(index, Number(digits.slice(-1)));
  input.value = state.grid[index] ? String(state.grid[index]) : '';
}

function onCellKeyDown(event) {
  const index = Number(event.currentTarget.dataset.index);
  const row = Math.floor(index / 9);
  const col = index % 9;

  if (/^[1-9]$/.test(event.key)) {
    event.preventDefault();
    handleUserInput(index, Number(event.key));
    return;
  }
  if (event.key === '0' || event.key === 'Backspace' || event.key === 'Delete') {
    event.preventDefault();
    handleUserInput(index, 0);
    return;
  }

  const moves = {
    ArrowUp: [row - 1, col],
    ArrowDown: [row + 1, col],
    ArrowLeft: [row, col - 1],
    ArrowRight: [row, col + 1],
  };
  const target = moves[event.key];
  if (target) {
    event.preventDefault();
    const [nextRow, nextCol] = target;
    if (nextRow >= 0 && nextRow < 9 && nextCol >= 0 && nextCol < 9) {
      focusCell(nextRow * 9 + nextCol);
    }
  }
}

function focusCell(index) {
  const input = cellEls[index];
  if (!input) return;
  input.focus();
  input.select();
}

function renderCell(index) {
  const input = cellEls[index];
  if (!input) return;
  const value = state.grid[index];
  const row = Math.floor(index / 9);
  const col = index % 9;

  input.value = value ? String(value) : '';
  input.classList.toggle('is-given', Boolean(value) && state.givens.has(index));
  input.classList.toggle('is-ai', Boolean(value) && state.ai.has(index));
  input.classList.toggle(
    'is-user',
    Boolean(value) && !state.givens.has(index) && !state.ai.has(index),
  );
  input.classList.toggle('is-uncertain', state.uncertain.has(index));
  input.classList.toggle('is-conflict', state.conflicts.has(index));

  input.classList.remove('hint-box', 'hint-target', 'hint-reveal');
  if (state.hint) {
    const hint = state.hint;
    const targetIndex = hint.data.index;
    const boxCells = BOXES[boxOf(targetIndex)];
    if (boxCells.includes(index)) input.classList.add('hint-box');
    if (hint.level >= 2 && index === targetIndex) {
      input.classList.add(hint.applied ? 'hint-reveal' : 'hint-target');
    }
  }

  let label = `Riga ${row + 1}, colonna ${col + 1}`;
  if (value) {
    label += `, ${value}`;
    if (state.givens.has(index)) label += ' (indizio del puzzle)';
    if (state.ai.has(index)) label += ' (inserito dall\'AI)';
  } else {
    label += ', vuota';
  }
  input.setAttribute('aria-label', label);
}

function renderAll() {
  const validation = validateGrid(state.grid);
  state.conflicts = validation.conflicts;
  for (let index = 0; index < CELL_COUNT; index += 1) renderCell(index);
  updateStatus(validation);
  refreshControls();
}

function updateStatus(validation = validateGrid(state.grid)) {
  const filled = validation.filled;
  const complete = filled === CELL_COUNT && validation.ok;

  els.statusDot.classList.remove('is-ok', 'is-error');
  els.conflictBadge.hidden = validation.ok;

  if (!validation.ok) {
    els.statusDot.classList.add('is-error');
    els.gridStatus.textContent = `${validation.conflicts.size} celle in conflitto · correggile per continuare`;
  } else if (complete) {
    els.statusDot.classList.add('is-ok');
    els.gridStatus.textContent = state.ai.size
      ? 'Griglia completata · i numeri viola sono quelli aggiunti dall\'AI'
      : 'Griglia completa';
  } else {
    els.gridStatus.textContent = `${filled} numeri · ${CELL_COUNT - filled} celle vuote`;
  }

  els.sourceBadge.hidden = !state.source;
  if (state.source) els.sourceBadge.textContent = state.source;
}

function refreshControls() {
  const validation = validateGrid(state.grid);
  const filled = validation.filled;
  const locked = state.busy || state.ocrRunning || state.solving;

  els.hintButton.disabled =
    locked || filled === 0 || filled === CELL_COUNT || !validation.ok;
  els.solveButton.disabled =
    locked || filled === 0 || filled === CELL_COUNT || !validation.ok;
  els.undoButton.disabled = locked || state.history.length === 0;
  els.clearButton.disabled = state.solving || state.ocrRunning;

  for (const input of cellEls) input.readOnly = locked;
}

function refreshAll({ save = true } = {}) {
  renderAll();
  if (save) saveState();
}

/* ------------------------------------------------------------------ */
/* Modifiche alla griglia                                              */
/* ------------------------------------------------------------------ */

function snapshot() {
  return {
    grid: state.grid.slice(),
    givens: new Set(state.givens),
    ai: new Set(state.ai),
    source: state.source,
  };
}

function pushHistory() {
  state.history.push(snapshot());
  if (state.history.length > 80) state.history.shift();
}

function restoreSnapshot(saved) {
  state.grid = saved.grid.slice();
  state.givens = new Set(saved.givens);
  state.ai = new Set(saved.ai);
  state.source = saved.source;
  state.uncertain.clear();
  hideHint();
  refreshAll();
  setStep(countFilled(state.grid) > 0 ? 3 : state.photo ? 2 : 1);
}

function setCellValue(index, value, { ai = false } = {}) {
  state.grid[index] = value;
  state.uncertain.delete(index);

  if (!value) {
    state.givens.delete(index);
    state.ai.delete(index);
  } else if (ai) {
    state.ai.add(index);
    state.givens.delete(index);
  } else {
    state.ai.delete(index);
    state.givens.add(index);
  }
  renderCell(index);
}

function handleUserInput(index, value) {
  if (state.busy || state.ocrRunning || state.solving) return;
  if (state.grid[index] === value) return;

  pushHistory();
  const hadHint = Boolean(state.hint);
  hideHint();
  if (hadHint) {
    setTutor({
      mood: 'idle',
      title: 'Griglia aggiornata',
      text: 'Ho rimosso il suggerimento precedente. Chiedimi la prossima mossa quando vuoi.',
    });
  }

  setCellValue(index, value);
  setSampleActive(null);
  refreshAll();
  setStep(countFilled(state.grid) > 0 ? 3 : state.photo ? 2 : 1);
}

function undo() {
  if (!state.history.length || state.busy || state.solving) return;
  const saved = state.history.pop();
  restoreSnapshot(saved);
  setTutor({
    mood: 'idle',
    title: 'Modifica annullata',
    text: 'La griglia è tornata allo stato precedente. Puoi continuare quando vuoi.',
  });
  toast('Ultima modifica annullata.', 'info', 2600);
}

function clearBoard() {
  if (state.solving || state.ocrRunning) return;
  pushHistory();
  state.grid.fill(0);
  state.givens.clear();
  state.ai.clear();
  state.uncertain.clear();
  state.source = '';
  hideHint();
  refreshAll();
  setStep(state.photo ? 2 : 1);
  setSampleActive(null);
  setTutor({
    mood: 'idle',
    title: 'Griglia svuotata',
    text:
      'Puoi inserire i numeri a mano oppure caricare una nuova foto. Ogni numero digitato è trattato come indizio.',
  });
  toast('Griglia svuotata. Puoi annullare con il pulsante di undo.', 'info', 3200);
}

/* ------------------------------------------------------------------ */
/* Caricamento griglie                                                 */
/* ------------------------------------------------------------------ */

function applyGrid(gridValues, { source = '', uncertain = [] } = {}) {
  state.grid = parseGrid(gridValues);
  state.givens = new Set();
  state.ai = new Set();
  state.uncertain = new Set(uncertain);
  state.grid.forEach((value, index) => {
    if (value) state.givens.add(index);
  });
  state.hint = null;
  state.source = source;
  hideHintDetail();
  refreshAll();
}

function loadSample(id) {
  if (state.busy || state.solving) return;
  const sample = getSample(id);
  pushHistory();
  clearPhoto();
  hideOcrError();
  applyGrid(sample.grid, { source: `Esempio · ${sample.label}` });
  setSampleActive(id);
  setStep(3);
  setTutor({
    mood: 'happy',
    title: `Esempio ${sample.label.toLowerCase()} caricato`,
    text:
      'La griglia è pronta. Chiedimi una mossa (anche con aiuto graduale) oppure risolvi tutto il Sudoku.',
  });
  toast(`Caricato l'esempio ${sample.label.toLowerCase()}.`, 'success', 3000);
}

function setSampleActive(id) {
  for (const chip of els.samples.querySelectorAll('[data-sample]')) {
    chip.classList.toggle('is-active', chip.dataset.sample === id);
  }
}

/* ------------------------------------------------------------------ */
/* Steps, tutor, toast                                                 */
/* ------------------------------------------------------------------ */

function setStep(step) {
  for (const item of els.steps.querySelectorAll('.step')) {
    const value = Number(item.dataset.step);
    item.classList.toggle('is-active', value === step);
    item.classList.toggle('is-done', value < step);
  }
}

function setTutor({ mood = 'idle', title, text }) {
  els.avatar.dataset.mood = mood;
  if (typeof title === 'string') els.tutorTitle.textContent = title;
  if (typeof text === 'string') els.tutorText.textContent = text;
}

function toast(message, tone = 'info', duration = 4800) {
  const element = document.createElement('div');
  element.className = `toast toast--${tone}`;

  const paragraph = document.createElement('p');
  paragraph.textContent = message;

  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Chiudi notifica');

  element.append(paragraph, close);
  els.toastStack.append(element);

  let timer = window.setTimeout(dismiss, duration);

  function dismiss() {
    window.clearTimeout(timer);
    if (!element.isConnected || element.classList.contains('is-leaving')) return;
    element.classList.add('is-leaving');
    window.setTimeout(() => element.remove(), 220);
  }

  close.addEventListener('click', dismiss);
}

/* ------------------------------------------------------------------ */
/* Suggerimenti (tutor)                                                */
/* ------------------------------------------------------------------ */

function hideHintDetail() {
  els.hintDetail.hidden = true;
  els.candidateRow.hidden = true;
  els.nextLevelButton.hidden = true;
  els.speakButton.hidden = true;
}

function hideHint() {
  state.hint = null;
  hideHintDetail();
}

function updateHintPanel() {
  const hint = state.hint;
  if (!hint) {
    hideHintDetail();
    return;
  }

  const { data, level, applied, source, technique, explanation } = hint;
  els.hintDetail.hidden = false;

  if (applied) {
    els.hintTechnique.textContent = technique || 'Mossa verificata';
    els.hintTechnique.className = 'badge badge--soft';
    els.hintCoord.textContent = cellName(data.index);
    els.hintCoord.hidden = false;
    els.hintSource.hidden = false;
    els.hintSource.textContent = source === 'gemini' ? 'Spiegazione Gemini' : 'Solutore locale';
    els.hintExplanation.hidden = false;
    els.hintExplanation.textContent = explanation;
  } else {
    els.hintTechnique.textContent = `Aiuto ${level} di 3`;
    els.hintTechnique.className = 'badge';
    els.hintCoord.textContent = cellName(data.index);
    els.hintCoord.hidden = level < 2;
    els.hintSource.hidden = true;
    els.hintExplanation.hidden = level < 3;
    els.hintExplanation.textContent = explanation;
  }

  const showCandidates = level >= 2 && Array.isArray(data.candidates) && data.candidates.length > 0;
  els.candidateRow.hidden = !showCandidates;
  els.candidateChips.replaceChildren();
  if (showCandidates) {
    for (const candidate of data.candidates) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = String(candidate);
      els.candidateChips.append(chip);
    }
  }

  els.nextLevelButton.hidden = applied || level >= 3;
  els.nextLevelButton.textContent = level === 1 ? 'Mostra la cella' : 'Svela il numero';
  els.speakButton.hidden = !applied;
}

function presentHint(level) {
  const hint = state.hint;
  if (!hint) return;
  hint.level = Math.min(3, Math.max(1, level));

  if (hint.level >= 3 && !hint.applied) {
    pushHistory();
    setCellValue(hint.data.index, hint.data.value, { ai: true });
    hint.applied = true;
    refreshAll();
    setStep(4);

    if (isComplete(state.grid)) {
      setTutor({
        mood: 'celebrate',
        title: 'Griglia completata!',
        text: `Ultima mossa: ${hint.data.value} in ${cellName(hint.data.index)}. Ecco il ragionamento completo.`,
      });
    } else {
      setTutor({
        mood: 'happy',
        title: 'Ecco la mossa!',
        text: `Ho inserito ${hint.data.value} in ${cellName(hint.data.index)}. Trovi il ragionamento qui sotto.`,
      });
    }

    if (settings.speech) speech.speak(hint.explanation);
  } else if (hint.level === 1) {
    setTutor({
      mood: 'thinking',
      title: 'Aiuto 1 di 3 · il blocco',
      text: 'Ho individuato un blocco chiave: guarda le celle evidenziate e prova a dedurre la cifra.',
    });
  } else if (hint.level === 2) {
    setTutor({
      mood: 'thinking',
      title: 'Aiuto 2 di 3 · la cella',
      text: 'La cella giusta è evidenziata. Osserva riga, colonna e blocco: quale cifra può entrare?',
    });
  }

  updateHintPanel();
  renderAll();
}

function advanceHint() {
  if (!state.hint || state.hint.applied) return;
  presentHint(state.hint.level + 1);
}

async function generateHint() {
  if (state.busy || state.solving || state.ocrRunning) return;

  state.busy = true;
  refreshControls();
  setTutor({
    mood: 'thinking',
    title: 'Analizzo la griglia…',
    text: 'Cerco la mossa più semplice e la verifico con il solutore locale.',
  });

  try {
    const localHint = findHint(state.grid);
    if (localHint.error) {
      setTutor({ mood: 'alert', title: 'Non riesco a suggerire', text: localHint.error });
      toast(localHint.error, 'warning', 5200);
      return;
    }

    const engine = settings.engine;

    // "Solo Gemini": la mossa può differire da quella locale, quindi attendiamo
    // la risposta prima di mostrare il suggerimento (con validazione locale).
    if (engine === 'gemini' && gemini.ready) {
      const remote = await askGeminiMove(localHint);
      state.hint = { ...remote, level: state.hintLevel, applied: false };
      presentHint(state.hintLevel);
      return;
    }

    // Ibrido e locale: il solutore mostra subito la mossa corretta, poi Gemini
    // arricchisce la spiegazione in background senza far attendere l'utente.
    state.hint = {
      data: localHint,
      level: state.hintLevel,
      applied: false,
      source: 'local',
      technique: localHint.technique,
      explanation: localHint.explanation,
    };
    presentHint(state.hintLevel);

    if (engine === 'hybrid' && gemini.ready) {
      void enrichHintWithGemini(localHint, state.grid.slice());
    } else if (engine !== 'local' && !gemini.ready && !state.toldLocal) {
      state.toldLocal = true;
      toast(
        'Spiegazione locale attiva: configura la API key per far spiegare la mossa a Gemini.',
        'info',
        5200,
      );
    }
  } finally {
    state.busy = false;
    refreshControls();
  }
}

/** Modalità "Solo Gemini": chiede la mossa e la valida con il solutore locale. */
async function askGeminiMove(localHint) {
  try {
    const suggestion = await gemini.suggestMove(state.grid);
    const solution = solveGrid(state.grid);
    const legal =
      suggestion.explanation &&
      isLegalMove(state.grid, solution, suggestion.row, suggestion.col, suggestion.value);

    if (legal) {
      const index = suggestion.row * 9 + suggestion.col;
      const boxIndex = boxOf(index);
      const technique = suggestion.technique || 'Suggerimento Gemini';
      return {
        data: {
          index,
          row: suggestion.row,
          col: suggestion.col,
          value: suggestion.value,
          technique,
          explanation: suggestion.explanation,
          candidates: candidatesFor(state.grid, index),
          unit: { type: 'box', index: boxIndex, cells: BOXES[boxIndex] },
        },
        source: 'gemini',
        technique,
        explanation: suggestion.explanation,
      };
    }

    toast(
      'Gemini ha proposto una mossa non valida: uso il solutore locale, che garantisce la correttezza.',
      'warning',
      6200,
    );
  } catch (error) {
    reportGeminiFallback(error, 'Uso il solutore locale, che garantisce la correttezza.');
  }

  return {
    data: localHint,
    source: 'local',
    technique: localHint.technique,
    explanation: localHint.explanation,
  };
}

/** Aggiorna la spiegazione con quella di Gemini senza bloccare l'interfaccia. */
async function enrichHintWithGemini(localHint, gridSnapshot) {
  try {
    const explained = await gemini.explainMove({
      grid: gridSnapshot,
      move: localHint,
      candidates: localHint.candidates ?? [],
    });

    const hint = state.hint;
    if (!hint || hint.data.index !== localHint.index) return;
    if (!gridsEqual(gridSnapshot, state.grid)) return;

    hint.explanation = explained.explanation;
    hint.technique = explained.technique || localHint.technique;
    hint.source = 'gemini';
    updateHintPanel();
    if (hint.applied && settings.speech) speech.speak(hint.explanation);
  } catch (error) {
    reportGeminiFallback(error, 'Resta valida la spiegazione del solutore locale.');
  }
}

function reportGeminiFallback(error, suffix) {
  if (error?.code === 'NO_KEY') return;
  const message = error instanceof GeminiError ? error.message : 'Errore Gemini inatteso.';
  toast(`${message} ${suffix}`, 'warning', 6500);
}

function gridsEqual(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/* ------------------------------------------------------------------ */
/* Soluzione completa                                                  */
/* ------------------------------------------------------------------ */

async function solveAll() {
  if (state.busy || state.solving || state.ocrRunning) return;

  const validation = validateGrid(state.grid);
  if (!validation.ok) {
    toast(validation.message, 'error', 6000);
    setTutor({ mood: 'alert', title: 'Ci sono conflitti', text: validation.message });
    return;
  }
  if (validation.filled === 0) {
    toast('Inserisci almeno qualche numero prima di risolvere.', 'warning');
    return;
  }
  if (validation.filled === CELL_COUNT) {
    toast('La griglia è già completa.', 'info');
    return;
  }

  const solution = solveGrid(state.grid);
  if (!solution) {
    toast(
      'Questa griglia non ha soluzioni. Controlla i numeri inseriti: potrebbero esserci errori non evidenti.',
      'error',
      7000,
    );
    setTutor({
      mood: 'alert',
      title: 'Griglia senza soluzione',
      text: 'I numeri inseriti sono coerenti tra loro ma non portano a una soluzione. Ricontrolla gli indizi.',
    });
    return;
  }

  const emptyCells = [];
  for (let index = 0; index < CELL_COUNT; index += 1) if (!state.grid[index]) emptyCells.push(index);

  pushHistory();
  state.solving = true;
  hideHint();
  refreshControls();
  setStep(4);
  setTutor({
    mood: 'thinking',
    title: 'Risolvo la griglia…',
    text: 'Il solutore locale sta completando le celle vuote, una alla volta.',
  });

  for (const index of emptyCells) {
    setCellValue(index, solution[index], { ai: true });
    await sleep(20);
  }

  state.solving = false;
  refreshAll();
  setStep(4);
  const added = emptyCells.length;
  setTutor({
    mood: 'celebrate',
    title: 'Griglia completata!',
    text: `Ho aggiunto ${added} numeri con il solutore locale. Quelli viola sono calcolati dall'AI: puoi annullare e riprovare con i suggerimenti.`,
  });
  toast(`Sudoku risolto: ${added} numeri aggiunti dal solutore.`, 'success', 5200);
  if (settings.speech) speech.speak(`Sudoku completato. Ho inserito ${added} numeri.`);
  if (overlay) refreshOverlayGrid();
}

/* ------------------------------------------------------------------ */
/* Fotocamera e upload                                                 */
/* ------------------------------------------------------------------ */

function setPhoto(photo) {
  state.photo = photo;
  els.photoThumb.src = photo.dataUrl;
  els.photoName.textContent = photo.name || 'foto-sudoku.jpg';
  els.photoState.textContent = 'Foto pronta · avvio del riconoscimento…';
  els.photoPreview.hidden = false;
  els.dropzone.hidden = true;
  setStep(2);
  if (els.overlayDialog.open) els.overlayDialog.close();
}

function clearPhoto() {
  state.photo = null;
  els.photoThumb.removeAttribute('src');
  els.photoPreview.hidden = true;
  els.dropzone.hidden = false;
  if (els.overlayDialog.open) els.overlayDialog.close();
}

async function handleImageFile(file) {
  if (!file) return;
  if (state.busy || state.ocrRunning) return;

  try {
    const image = await fileToDataUrl(file);
    setPhoto({
      dataUrl: image.dataUrl,
      name: file.name || 'foto-sudoku.jpg',
      corners: null,
    });
    hideOcrError();
    setSampleActive(null);
    toast('Foto caricata. Avvio il riconoscimento con Gemini…', 'info', 3200);
    await runOcr();
  } catch (error) {
    toast(error?.message ?? 'Impossibile leggere l\'immagine.', 'error', 5200);
  }
}

async function openCamera() {
  if (state.ocrRunning) return;
  els.cameraError.hidden = true;
  els.cameraError.textContent = '';
  els.cameraShot.disabled = true;

  if (!els.cameraDialog.open) els.cameraDialog.showModal();

  try {
    await camera.start();
    els.cameraShot.disabled = false;
  } catch (error) {
    els.cameraError.textContent = error?.message ?? 'Fotocamera non disponibile.';
    els.cameraError.hidden = false;
    els.cameraShot.disabled = true;
  }
}

function closeCamera() {
  camera.stop();
  if (els.cameraDialog.open) els.cameraDialog.close();
}

async function capturePhoto() {
  try {
    const dataUrl = camera.capture();
    closeCamera();
    setPhoto({ dataUrl, name: 'foto-camera.jpg', corners: null });
    hideOcrError();
    setSampleActive(null);
    await runOcr();
  } catch (error) {
    els.cameraError.textContent = error?.message ?? 'Scatto non riuscito. Riprova.';
    els.cameraError.hidden = false;
  }
}

/* ------------------------------------------------------------------ */
/* OCR con Gemini                                                      */
/* ------------------------------------------------------------------ */

function showOcrError(title, message) {
  els.ocrErrorTitle.textContent = title;
  els.ocrErrorText.textContent = message;
  els.ocrError.hidden = false;
}

function hideOcrError() {
  els.ocrError.hidden = true;
}

function startOcrProgress() {
  const started = Date.now();
  let progress = 6;
  clearTimeout(ocrHideTimer);
  ocrHideTimer = null;
  els.ocrProgress.hidden = false;
  els.ocrBar.style.width = '6%';
  els.ocrElapsed.textContent = '0';
  clearInterval(ocrTimer);
  ocrTimer = window.setInterval(() => {
    const elapsed = Math.round((Date.now() - started) / 1000);
    els.ocrElapsed.textContent = String(elapsed);
    progress = Math.min(93, progress + Math.max(1, (93 - progress) * 0.08));
    els.ocrBar.style.width = `${progress}%`;
  }, 450);
}

function stopOcrProgress(success) {
  clearInterval(ocrTimer);
  ocrTimer = null;
  clearTimeout(ocrHideTimer);
  ocrHideTimer = null;

  if (success) {
    els.ocrBar.style.width = '100%';
    ocrHideTimer = window.setTimeout(() => {
      els.ocrProgress.hidden = true;
      els.ocrBar.style.width = '0';
      ocrHideTimer = null;
    }, 550);
  } else {
    els.ocrProgress.hidden = true;
    els.ocrBar.style.width = '0';
  }
}

async function runOcr() {
  if (!state.photo) {
    toast('Carica prima una foto dello schema.', 'warning');
    return;
  }
  if (state.ocrRunning || state.solving) return;

  hideOcrError();
  if (!gemini.ready) {
    const message =
      'Nessuna API key configurata. Inserisci la chiave Gemini nelle impostazioni oppure avvia server.py con il file .env. Nel frattempo puoi caricare un esempio o digitare la griglia a mano.';
    showOcrError('Gemini non è configurato', message);
    els.photoState.textContent = 'Configura Gemini per il riconoscimento';
    setTutor({
      mood: 'alert',
      title: 'Serve una API key',
      text: 'Apri le impostazioni per collegare Gemini, oppure usa gli esempi e la griglia manuale.',
    });
    toast(message, 'warning', 8000);
    openSettings();
    return;
  }

  state.ocrRunning = true;
  setStep(2);
  refreshControls();
  els.gridScan.hidden = false;
  els.ocrProgress.hidden = false;
  els.photoState.textContent = 'Riconoscimento in corso…';
  startOcrProgress();
  setTutor({
    mood: 'thinking',
    title: 'Sto leggendo la griglia…',
    text: 'Invio la foto a Gemini, che restituisce una matrice 9×9 in JSON. Può richiedere qualche secondo.',
  });

  try {
    const result = await gemini.readSudoku(state.photo.dataUrl);
    if (result.corners) state.photo.corners = result.corners;

    const recognized = result.grid.filter(Boolean).length;
    pushHistory();
    applyGrid(result.grid, { source: 'Foto · Gemini', uncertain: result.uncertain });
    setStep(3);
    setSampleActive(null);
    els.photoState.textContent = 'Riconosciuta da Gemini';
    stopOcrProgress(true);

    const note = result.notes ? ` Nota del modello: ${result.notes}` : '';
    setTutor({
      mood: 'happy',
      title: `Ho riconosciuto ${recognized} numeri`,
      text:
        'Controlla la griglia e correggi eventuali errori. Le celle evidenziate in ambra erano incerte.' +
        note,
    });
    toast(
      `OCR completato: ${recognized} numeri riconosciuti. Verifica la griglia prima di procedere.`,
      'success',
      5400,
    );
  } catch (error) {
    const message =
      error instanceof GeminiError
        ? error.message
        : error?.message ?? 'Errore inatteso durante il riconoscimento.';
    els.photoState.textContent = 'Riconoscimento non riuscito';
    stopOcrProgress(false);
    showOcrError('Riconoscimento non riuscito', message);
    setTutor({
      mood: 'alert',
      title: 'Non sono riuscito a leggere lo schema',
      text: message,
    });
    toast(message, 'error', 7500);

    if (error?.code === 'NO_KEY' || error?.code === 'INVALID_KEY' || error?.code === 'UNAUTHORIZED') {
      openSettings();
    }
  } finally {
    state.ocrRunning = false;
    els.gridScan.hidden = true;
    refreshAll();
  }
}

/* ------------------------------------------------------------------ */
/* Overlay fotografico                                                 */
/* ------------------------------------------------------------------ */

function refreshOverlayGrid() {
  if (!overlay) return;
  overlay.setGrid(state.grid, state.givens);
}

async function openOverlay() {
  if (!state.photo) {
    toast('Carica prima una foto dello schema.', 'warning');
    return;
  }

  if (!overlay) {
    overlay = new PhotoOverlay(els.overlayCanvas);
    overlay.onCornersChange = (corners) => {
      if (state.photo) state.photo.corners = corners;
    };
  }

  if (!els.overlayDialog.open) els.overlayDialog.showModal();

  try {
    await overlay.setImage(state.photo.dataUrl);
    overlay.setCorners(state.photo.corners ?? DEFAULT_CORNERS);
    overlay.setOnlyAi(els.overlayOnlyAi.checked);
    overlay.setEditing(false);
    els.overlayEdit.textContent = 'Regola angoli';
    refreshOverlayGrid();

    const filled = countFilled(state.grid);
    els.overlayNote.textContent =
      filled === 0
        ? 'Lo schema è vuoto: inserisci i numeri o riconosci la foto per vedere l\'overlay.'
        : filled < CELL_COUNT
          ? 'Trascina gli angoli per allineare la griglia. Completa il Sudoku per vedere anche i numeri mancanti.'
          : 'Trascina gli angoli per allineare la griglia alla foto.';
  } catch (error) {
    toast(error?.message ?? 'Impossibile preparare l\'overlay.', 'error');
    els.overlayDialog.close();
  }
}

/* ------------------------------------------------------------------ */
/* Impostazioni                                                        */
/* ------------------------------------------------------------------ */

function populateModels() {
  els.modelOptions.replaceChildren();
  for (const model of MODEL_SUGGESTIONS) {
    const option = document.createElement('option');
    option.value = model;
    els.modelOptions.append(option);
  }
}

function applySettings() {
  if (!settings.model) settings.model = gemini.serverModel || DEFAULT_MODEL;
  gemini.setCredentials({ key: settings.key, model: settings.model });
  speech.setEnabled(settings.speech && speech.supported);
  state.toldLocal = false;
  persistSettings();
  updateModePill();
  updateApiStatus();
}

/** Il proxy ha ripiegato su un altro modello. */
function handleModelChange(event) {
  const { model, permanent } = event?.detail ?? {};
  if (!model) return;

  if (!permanent) {
    // Picco di sovraccarico: il ripiego vale solo per questa richiesta, la
    // preferenza salvata resta quella scelta (di solito il modello più veloce).
    toast(`Gemini sta usando temporaneamente ${model} per un picco di richieste.`, 'info', 5000);
    return;
  }

  if (model === settings.model) return;
  settings.model = model;
  settings.modelPinned = true;
  persistSettings();
  if (els.settingsModel) els.settingsModel.value = model;
  updateModePill();
  updateApiStatus();
  toast(`Il modello precedente non è più disponibile: uso ${model}.`, 'info', 6500);
}

function updateModePill() {
  els.modePill.classList.remove('is-ok', 'is-warn', 'is-off');
  if (gemini.transport === 'proxy') {
    els.modePill.classList.add('is-ok');
    els.modeLabel.textContent = 'Proxy sicuro';
    els.modePill.title = `Gemini tramite server locale · modello ${gemini.model}`;
  } else if (gemini.transport === 'direct') {
    els.modePill.classList.add('is-warn');
    els.modeLabel.textContent = 'Chiave browser';
    els.modePill.title = `Chiamata diretta a Gemini · modello ${gemini.model}. Modalità demo.`;
  } else {
    els.modePill.classList.add('is-off');
    els.modeLabel.textContent = 'API non configurata';
    els.modePill.title = 'Configura la API key Gemini per abilitare OCR e tutor AI.';
  }
}

function updateApiStatus() {
  els.apiStatus.classList.remove('is-ok', 'is-warn', 'is-off');
  let title = 'Verifica in corso…';
  let text = 'Controllo del collegamento con Gemini.';

  if (gemini.proxyConfigured) {
    els.apiStatus.classList.add('is-ok');
    title = 'Proxy locale attivo';
    text = `La chiave Gemini resta nel file .env. Modello predefinito: ${gemini.serverModel || gemini.model}.`;
  } else if (settings.key) {
    els.apiStatus.classList.add('is-warn');
    title = 'Chiave salvata nel browser';
    text =
      'Modalità demo: la chiave è memorizzata in localStorage. Per un progetto pubblico usa il proxy Python.';
  } else if (gemini.proxyAvailable) {
    els.apiStatus.classList.add('is-warn');
    title = 'Server locale senza chiave';
    text = 'Aggiungi GEMINI_API_KEY nel file .env e riavvia server.py, oppure inserisci una chiave qui sotto.';
  } else {
    els.apiStatus.classList.add('is-off');
    title = 'Nessuna connessione configurata';
    text = 'Avvia server.py con il file .env oppure inserisci una chiave API qui sotto.';
  }

  els.apiStatusTitle.textContent = title;
  els.apiStatusText.textContent = text;
  els.apiStatus.querySelector('.dot').style.background = '';
}

function openSettings() {
  els.settingsKey.value = settings.key;
  els.settingsModel.value = settings.model || gemini.model || DEFAULT_MODEL;
  els.settingsEngine.value = settings.engine;
  els.settingsSpeech.checked = settings.speech;
  els.settingsSpeech.disabled = !speech.supported;
  updateApiStatus();
  if (!els.settingsDialog.open) els.settingsDialog.showModal();
}

function saveKey() {
  const key = els.settingsKey.value.trim();
  settings.key = key;
  applySettings();
  if (key) {
    toast('Chiave API salvata nel browser. Verifica la connessione per essere sicuro che funzioni.', 'success', 4800);
  } else {
    toast('Chiave API rimossa.', 'info');
  }
}

async function testApi() {
  const key = els.settingsKey.value.trim();
  if (key !== settings.key) {
    settings.key = key;
    applySettings();
  }
  if (!gemini.ready) {
    toast('Inserisci una API key oppure configura il file .env del server.', 'warning');
    return;
  }

  const original = els.testApiButton.textContent;
  els.testApiButton.disabled = true;
  els.testApiButton.textContent = 'Verifico…';
  try {
    await gemini.ping();
    updateApiStatus();
    toast('Connessione a Gemini verificata con successo.', 'success', 4200);
  } catch (error) {
    toast(
      error instanceof GeminiError ? error.message : 'Verifica non riuscita.',
      'error',
      7600,
    );
  } finally {
    els.testApiButton.disabled = false;
    els.testApiButton.textContent = original;
  }
}

/* ------------------------------------------------------------------ */
/* Eventi                                                              */
/* ------------------------------------------------------------------ */

function bindEvents() {
  els.settingsButton.addEventListener('click', openSettings);
  els.modePill.addEventListener('click', openSettings);
  window.addEventListener('gemini:model-changed', handleModelChange);

  /* Dropzone */
  els.dropzone.addEventListener('click', (event) => {
    if (event.target.closest('button')) return;
    els.fileInput.click();
  });
  els.dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      els.fileInput.click();
    }
  });
  els.fileButton.addEventListener('click', (event) => {
    event.stopPropagation();
    els.fileInput.click();
  });
  els.cameraButton.addEventListener('click', (event) => {
    event.stopPropagation();
    openCamera();
  });
  els.fileInput.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) await handleImageFile(file);
  });

  for (const type of ['dragenter', 'dragover']) {
    els.dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      els.dropzone.classList.add('is-dragover');
    });
  }
  for (const type of ['dragleave', 'dragend']) {
    els.dropzone.addEventListener(type, () => els.dropzone.classList.remove('is-dragover'));
  }
  els.dropzone.addEventListener('drop', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    els.dropzone.classList.remove('is-dragover');
    const file = event.dataTransfer?.files?.[0];
    if (file) await handleImageFile(file);
  });

  document.addEventListener('dragover', (event) => {
    if ([...(event.dataTransfer?.types ?? [])].includes('Files')) event.preventDefault();
  });
  document.addEventListener('drop', async (event) => {
    event.preventDefault();
    if (event.target instanceof Element && event.target.closest('#dropzone')) return;
    const file = event.dataTransfer?.files?.[0];
    if (file) await handleImageFile(file);
  });

  document.addEventListener('paste', async (event) => {
    const items = [...(event.clipboardData?.items ?? [])];
    const imageItem = items.find((item) => item.type.startsWith('image/'));
    if (!imageItem) return;
    const file = imageItem.getAsFile();
    if (!file) return;
    event.preventDefault();
    await handleImageFile(file);
  });

  /* Griglia */
  els.grid.addEventListener('paste', (event) => {
    const text = event.clipboardData?.getData('text') ?? '';
    const digits = text.replace(/[^0-9]/g, '');
    if (digits.length < 81) return;
    event.preventDefault();
    if (state.busy || state.solving || state.ocrRunning) return;
    pushHistory();
    applyGrid(digits.slice(0, 81), { source: 'Inserimento manuale' });
    setStep(3);
    setSampleActive(null);
    setTutor({
      mood: 'happy',
      title: 'Griglia incollata',
      text: 'Ho letto 81 cifre dagli appunti. Controlla la griglia e poi scegli come farti aiutare.',
    });
    toast('Griglia di 81 cifre incollata.', 'success', 3200);
  });

  /* Azioni principali */
  els.hintButton.addEventListener('click', () => {
    if (state.hint && !state.hint.applied) advanceHint();
    else generateHint();
  });
  els.solveButton.addEventListener('click', solveAll);
  els.undoButton.addEventListener('click', undo);
  els.clearButton.addEventListener('click', clearBoard);
  els.nextLevelButton.addEventListener('click', advanceHint);

  els.hintLevel.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-level]');
    if (!button) return;
    state.hintLevel = Number(button.dataset.level);
    for (const item of els.hintLevel.querySelectorAll('button')) {
      item.classList.toggle('is-active', item === button);
    }
    if (state.hint && !state.hint.applied && state.hintLevel > state.hint.level) {
      presentHint(state.hintLevel);
    }
  });

  els.speakButton.addEventListener('click', () => {
    if (!state.hint) return;
    if (!speech.supported) {
      toast('Questo browser non supporta la sintesi vocale.', 'warning');
      return;
    }
    speech.speak(state.hint.explanation, true);
  });

  /* Foto */
  els.reocrButton.addEventListener('click', runOcr);
  els.changePhotoButton.addEventListener('click', () => els.fileInput.click());
  els.overlayButton.addEventListener('click', openOverlay);
  els.photoThumbButton.addEventListener('click', openOverlay);
  els.ocrRetryButton.addEventListener('click', runOcr);
  els.ocrManualButton.addEventListener('click', () => {
    hideOcrError();
    setTutor({
      mood: 'idle',
      title: 'Inserimento manuale',
      text: 'Digita i numeri direttamente nella griglia: ogni cifra inserita diventa un indizio.',
    });
    setStep(3);
    focusCell(0);
  });

  els.samples.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-sample]');
    if (chip) loadSample(chip.dataset.sample);
  });

  /* Fotocamera */
  els.cameraSwitch.addEventListener('click', async () => {
    try {
      await camera.switchCamera();
      els.cameraShot.disabled = false;
      els.cameraError.hidden = true;
    } catch (error) {
      els.cameraError.textContent = error?.message ?? 'Impossibile cambiare fotocamera.';
      els.cameraError.hidden = false;
    }
  });
  els.cameraShot.addEventListener('click', capturePhoto);
  els.cameraFallback.addEventListener('click', () => {
    closeCamera();
    els.fileInput.click();
  });
  els.cameraDialog.addEventListener('close', () => camera.stop());

  /* Overlay */
  els.overlayOnlyAi.addEventListener('change', () => {
    overlay?.setOnlyAi(els.overlayOnlyAi.checked);
  });
  els.overlayEdit.addEventListener('click', () => {
    if (!overlay) return;
    const editing = !overlay.editing;
    overlay.setEditing(editing);
    els.overlayEdit.textContent = editing ? 'Fine regolazione' : 'Regola angoli';
    els.overlayNote.textContent = editing
      ? 'Trascina i quattro cerchi per allineare gli angoli esterni della griglia.'
      : 'Trascina gli angoli per allineare la griglia alla foto.';
  });
  els.overlayReset.addEventListener('click', () => {
    if (!overlay) return;
    overlay.resetCorners();
    if (state.photo) state.photo.corners = overlay.getCorners();
    toast('Angoli riportati alla posizione automatica.', 'info', 2600);
  });
  const closeOverlay = () => {
    if (els.overlayDialog.open) els.overlayDialog.close();
  };
  els.overlayClose.addEventListener('click', closeOverlay);
  els.overlayCloseX.addEventListener('click', closeOverlay);

  /* Impostazioni */
  els.saveKeyButton.addEventListener('click', saveKey);
  els.removeKeyButton.addEventListener('click', () => {
    els.settingsKey.value = '';
    settings.key = '';
    applySettings();
    toast('Chiave API rimossa.', 'info');
  });
  els.testApiButton.addEventListener('click', testApi);
  els.settingsKey.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      saveKey();
    }
  });
  els.settingsModel.addEventListener('change', () => {
    settings.model = els.settingsModel.value.trim() || DEFAULT_MODEL;
    settings.modelPinned = true;
    applySettings();
  });
  els.settingsEngine.addEventListener('change', () => {
    settings.engine = els.settingsEngine.value;
    persistSettings();
  });
  els.settingsSpeech.addEventListener('change', () => {
    settings.speech = els.settingsSpeech.checked;
    applySettings();
    if (settings.speech && !speech.supported) {
      toast('Questo browser non supporta la sintesi vocale.', 'warning');
    }
  });
  els.settingsDialog.addEventListener('close', persistSettings);

  /* Chiusura generica dei dialog */
  for (const button of document.querySelectorAll('[data-close-dialog]')) {
    button.addEventListener('click', () => {
      const dialog = document.getElementById(button.dataset.closeDialog);
      dialog?.close();
    });
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') speech.stop();
  });

  window.addEventListener('beforeunload', saveState);
}

/* ------------------------------------------------------------------ */
/* Inizializzazione                                                    */
/* ------------------------------------------------------------------ */

async function init() {
  els.footerYear.textContent = String(new Date().getFullYear());
  buildGrid();
  loadSettings();
  populateModels();
  bindEvents();
  speech.setEnabled(settings.speech && speech.supported);

  const restored = restoreState();
  applySettings();
  renderAll();

  await gemini.init();

  if (!settingsWereSaved || !settings.model) {
    settings.model = gemini.serverModel || DEFAULT_MODEL;
    persistSettings();
  }
  applySettings();

  if (restored) {
    setStep(3);
    setTutor({
      mood: 'idle',
      title: 'Bentornato!',
      text: 'Ho ripristinato l\'ultima griglia salvata. Puoi continuare da dove avevi lasciato.',
    });
  } else {
    setStep(1);
  }
}

init().catch((error) => {
  console.error(error);
  toast('Errore di avvio dell\'applicazione. Ricarica la pagina.', 'error', 8000);
});
