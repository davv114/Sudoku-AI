/**
 * Motore Sudoku locale.
 * ------------------------------------------------------------------
 * Risolve la griglia con un algoritmo di backtracking + MRV (Minimum
 * Remaining Values) e genera suggerimenti didattici in italiano.
 *
 * Il motore è volutamente indipendente dall'API: viene usato per
 * verificare la griglia, risolvere il Sudoku e scegliere LA prossima
 * mossa più semplice. Gemini si occupa solo della spiegazione
 * testuale (approccio "solutore ibrido", funzionalità bonus).
 */

export const SIZE = 9;
export const CELL_COUNT = SIZE * SIZE;
const ALL_DIGITS = 0x1ff; // bit 0..8 => cifre 1..9

export const ROWS = [];
export const COLS = [];
export const BOXES = [];

for (let r = 0; r < SIZE; r += 1) {
  ROWS.push(Array.from({ length: SIZE }, (_, c) => r * SIZE + c));
}
for (let c = 0; c < SIZE; c += 1) {
  COLS.push(Array.from({ length: SIZE }, (_, r) => r * SIZE + c));
}
for (let br = 0; br < 3; br += 1) {
  for (let bc = 0; bc < 3; bc += 1) {
    const cells = [];
    for (let r = 0; r < 3; r += 1) {
      for (let c = 0; c < 3; c += 1) {
        cells.push((br * 3 + r) * SIZE + (bc * 3 + c));
      }
    }
    BOXES.push(cells);
  }
}

/** Unità di gioco: prima i blocchi (più facili da vedere), poi righe e colonne. */
export const UNITS = [
  ...BOXES.map((cells, index) => ({ type: 'box', index, cells })),
  ...ROWS.map((cells, index) => ({ type: 'row', index, cells })),
  ...COLS.map((cells, index) => ({ type: 'col', index, cells })),
];

export const BOX_NAMES = [
  'blocco superiore sinistro',
  'blocco superiore centrale',
  'blocco superiore destro',
  'blocco centrale sinistro',
  'blocco centrale',
  'blocco centrale destro',
  'blocco inferiore sinistro',
  'blocco inferiore centrale',
  'blocco inferiore destro',
];

export const UNIT_NAMES = { row: 'riga', col: 'colonna', box: 'blocco' };

export const DIFFICULTY_LABELS = ['', 'molto facile', 'facile', 'media', 'difficile', 'esperto'];

export function rowOf(index) {
  return Math.floor(index / SIZE);
}

export function colOf(index) {
  return index % SIZE;
}

export function boxOf(index) {
  return Math.floor(rowOf(index) / 3) * 3 + Math.floor(colOf(index) / 3);
}

export function cellName(index) {
  return `R${rowOf(index) + 1}C${colOf(index) + 1}`;
}

export function cellCoordinates(index) {
  return `riga ${rowOf(index) + 1}, colonna ${colOf(index) + 1}`;
}

/** Converte testo/matrice in un array di 81 interi (0 = vuota). */
export function parseGrid(input) {
  let values = [];
  if (Array.isArray(input)) {
    values = input.flat(Infinity);
  } else {
    values = String(input ?? '').replace(/[^0-9]/g, '').split('');
  }
  return Array.from({ length: CELL_COUNT }, (_, i) => {
    const n = Number(values[i]);
    return Number.isInteger(n) && n >= 1 && n <= 9 ? n : 0;
  });
}

export function toMatrix(grid) {
  return ROWS.map((row) => row.map((index) => grid[index]));
}

export function fromMatrix(matrix) {
  return parseGrid(matrix);
}

export function cloneGrid(grid) {
  return grid.slice();
}

/** Restituisce l'insieme degli indici che violano riga/colonna/blocco. */
export function findConflicts(grid) {
  const conflicts = new Set();
  for (const unit of UNITS) {
    const seen = new Map();
    for (const index of unit.cells) {
      const value = grid[index];
      if (!value) continue;
      if (seen.has(value)) {
        conflicts.add(index);
        conflicts.add(seen.get(value));
      } else {
        seen.set(value, index);
      }
    }
  }
  return conflicts;
}

export function countFilled(grid) {
  let filled = 0;
  for (const value of grid) if (value) filled += 1;
  return filled;
}

export function isComplete(grid) {
  return countFilled(grid) === CELL_COUNT;
}

/**
 * Validazione "leggera": controlla solo i conflitti evidenti.
 * Non verifica che la griglia ammetta una soluzione (lo fa solveGrid).
 */
export function validateGrid(grid) {
  const conflicts = findConflicts(grid);
  const conflictsArray = [...conflicts];
  const filled = countFilled(grid);
  if (conflicts.size > 0) {
    const names = conflictsArray.slice(0, 4).map(cellName).join(', ');
    return {
      ok: false,
      reason: 'conflict',
      conflicts,
      conflictsArray,
      filled,
      message:
        `Ci sono ${conflicts.size} celle in conflitto (${names}${conflicts.size > 4 ? ', …' : ''}). ` +
        'Un numero ripetuto nella stessa riga, colonna o blocco va corretto.',
    };
  }
  return { ok: true, conflicts, conflictsArray, filled, message: '' };
}

/** Candidati possibili per una cella vuota. */
export function candidatesFor(grid, index) {
  if (grid[index]) return [];
  const r = rowOf(index);
  const c = colOf(index);
  const b = boxOf(index);
  let used = 0;
  for (const i of ROWS[r]) if (grid[i]) used |= 1 << (grid[i] - 1);
  for (const i of COLS[c]) if (grid[i]) used |= 1 << (grid[i] - 1);
  for (const i of BOXES[b]) if (grid[i]) used |= 1 << (grid[i] - 1);
  const candidates = [];
  for (let v = 1; v <= 9; v += 1) {
    if (!(used & (1 << (v - 1)))) candidates.push(v);
  }
  return candidates;
}

/** Mappa dei candidati per tutte le celle (null per le celle piene). */
export function candidateMap(grid) {
  return grid.map((value, index) => (value ? null : candidatesFor(grid, index)));
}

function popcount(mask) {
  let count = 0;
  let m = mask;
  while (m) {
    m &= m - 1;
    count += 1;
  }
  return count;
}

/** Costruisce le maschere di riga/colonna/blocco. Restituisce null se ci sono duplicati. */
function buildMasks(grid) {
  const rows = new Array(SIZE).fill(0);
  const cols = new Array(SIZE).fill(0);
  const boxes = new Array(SIZE).fill(0);

  for (let index = 0; index < CELL_COUNT; index += 1) {
    const value = grid[index];
    if (!value) continue;
    const bit = 1 << (value - 1);
    const r = rowOf(index);
    const c = colOf(index);
    const b = boxOf(index);
    if (rows[r] & bit || cols[c] & bit || boxes[b] & bit) return null;
    rows[r] |= bit;
    cols[c] |= bit;
    boxes[b] |= bit;
  }
  return { rows, cols, boxes };
}

/** Ricerca esaustiva con MRV; raccoglie al massimo `limit` soluzioni. */
function searchSolutions(grid, masks, limit) {
  const work = grid.slice();
  const { rows, cols, boxes } = masks;
  const solutions = [];

  function search() {
    if (solutions.length >= limit) return;

    let bestIndex = -1;
    let bestMask = 0;
    let bestCount = 10;

    for (let index = 0; index < CELL_COUNT; index += 1) {
      if (work[index]) continue;
      const r = rowOf(index);
      const c = colOf(index);
      const b = boxOf(index);
      const mask = ALL_DIGITS & ~(rows[r] | cols[c] | boxes[b]);
      const count = popcount(mask);
      if (count === 0) return;
      if (count < bestCount) {
        bestCount = count;
        bestMask = mask;
        bestIndex = index;
        if (count === 1) break;
      }
    }

    if (bestIndex === -1) {
      solutions.push(work.slice());
      return;
    }

    const r = rowOf(bestIndex);
    const c = colOf(bestIndex);
    const b = boxOf(bestIndex);

    for (let v = 1; v <= 9; v += 1) {
      const bit = 1 << (v - 1);
      if (!(bestMask & bit)) continue;
      work[bestIndex] = v;
      rows[r] |= bit;
      cols[c] |= bit;
      boxes[b] |= bit;
      search();
      work[bestIndex] = 0;
      rows[r] &= ~bit;
      cols[c] &= ~bit;
      boxes[b] &= ~bit;
      if (solutions.length >= limit) return;
    }
  }

  search();
  return solutions;
}

/** Restituisce una soluzione completa oppure null. */
export function solveGrid(grid) {
  const masks = buildMasks(grid);
  if (!masks) return null;
  const solutions = searchSolutions(grid, masks, 1);
  return solutions[0] ?? null;
}

/** Conta le soluzioni (fino a `limit`) per stimare unicità/difficoltà. */
export function countSolutions(grid, limit = 2) {
  const masks = buildMasks(grid);
  if (!masks) return 0;
  return searchSolutions(grid, masks, limit).length;
}

export function isUniqueSolution(grid) {
  return countSolutions(grid, 2) === 1;
}

function makeHint({ index, value, technique, explanation, unit, candidates }) {
  return {
    index,
    row: rowOf(index),
    col: colOf(index),
    value,
    technique,
    explanation,
    candidates,
    unit: unit ? { type: unit.type, index: unit.index, cells: unit.cells } : null,
  };
}

/**
 * Trova LA prossima mossa più semplice.
 * Strategia: singolo nudo → singolo nascosto (blocco, riga, colonna) →
 * tecnica avanzata (valore verificato dal solutore locale).
 */
export function findHint(grid, precomputedSolution = null) {
  const validation = validateGrid(grid);
  if (!validation.ok) {
    return { error: 'Correggi prima i conflitti evidenziati nella griglia.' };
  }
  if (isComplete(grid)) {
    return { error: 'La griglia è già completa: non servono altre mosse.' };
  }

  const solution = precomputedSolution ?? solveGrid(grid);
  if (!solution) {
    return { error: 'Questa griglia non ha soluzioni: controlla i numeri inseriti.' };
  }

  const emptyCells = [];
  for (let index = 0; index < CELL_COUNT; index += 1) {
    if (!grid[index]) emptyCells.push(index);
  }

  // 1) Singolo nudo: la cella ha un solo candidato.
  for (const index of emptyCells) {
    const candidates = candidatesFor(grid, index);
    if (candidates.length === 1) {
      const value = candidates[0];
      const name = cellName(index);
      const box = BOX_NAMES[boxOf(index)];
      return makeHint({
        index,
        value,
        technique: 'Singolo nudo',
        explanation:
          `In ${name} tutte le altre cifre sono già presenti nella riga ${rowOf(index) + 1}, ` +
          `nella colonna ${colOf(index) + 1} o nel ${box}. L'unico candidato possibile è il ${value}.`,
        candidates,
      });
    }
  }

  // 2) Singolo nascosto: in un'unità una cifra ha una sola cella possibile.
  for (const unit of UNITS) {
    const used = new Set();
    for (const index of unit.cells) if (grid[index]) used.add(grid[index]);

    for (let value = 1; value <= 9; value += 1) {
      if (used.has(value)) continue;
      const spots = unit.cells.filter(
        (index) => !grid[index] && candidatesFor(grid, index).includes(value),
      );
      if (spots.length !== 1) continue;

      const index = spots[0];
      const candidates = candidatesFor(grid, index);
      let unitDescription;
      let explanation;

      if (unit.type === 'box') {
        unitDescription = `nel ${BOX_NAMES[unit.index]}`;
        explanation =
          `Nel ${BOX_NAMES[unit.index]}, il ${value} può stare solo in ${cellName(index)}. ` +
          'Le altre celle del blocco sono escluse dalle cifre già presenti nelle rispettive righe e colonne.';
      } else if (unit.type === 'row') {
        unitDescription = `nella riga ${unit.index + 1}`;
        explanation =
          `Nella riga ${unit.index + 1}, il ${value} può stare solo in ${cellName(index)}: ` +
          'tutte le altre celle della riga non possono contenerlo perché il numero è già presente nella loro colonna o nel loro blocco.';
      } else {
        unitDescription = `nella colonna ${unit.index + 1}`;
        explanation =
          `Nella colonna ${unit.index + 1}, il ${value} può stare solo in ${cellName(index)}: ` +
          'tutte le altre celle della colonna non possono contenerlo perché il numero è già presente nella loro riga o nel loro blocco.';
      }

      return makeHint({
        index,
        value,
        technique: `Singolo nascosto (${UNIT_NAMES[unit.type]})`,
        explanation,
        unit,
        candidates,
      });
    }
  }

  // 3) Nessuna tecnica semplice: il solutore locale fornisce la mossa corretta.
  const index = emptyCells.reduce((best, current) => {
    const bestCandidates = candidatesFor(grid, best).length;
    const currentCandidates = candidatesFor(grid, current).length;
    return currentCandidates < bestCandidates ? current : best;
  }, emptyCells[0]);

  return makeHint({
    index,
    value: solution[index],
    technique: 'Tecnica avanzata',
    explanation:
      `Qui serve una tecnica più avanzata (coppie, terzine o catene logiche). ` +
      `Il solutore locale ha verificato che in ${cellName(index)} la cifra corretta è il ${solution[index]}. ` +
      'Studia i candidati della cella e delle unità collegate: è un ottimo spunto per il prossimo passo.',
    candidates: candidatesFor(grid, index),
  });
}

/**
 * Applica una mossa (non muta l'input) e restituisce la nuova griglia.
 * Utile per i test automatici e per la modalità "solo Gemini".
 */
export function applyMove(grid, move) {
  const next = grid.slice();
  if (!move || move.index == null) return next;
  next[move.index] = move.value;
  return next;
}

/** Verifica che una mossa proposta da Gemini sia legale. */
export function isLegalMove(grid, solution, row, col, value) {
  if (!Number.isInteger(row) || !Number.isInteger(col)) return false;
  if (row < 0 || row > 8 || col < 0 || col > 8) return false;
  if (!Number.isInteger(value) || value < 1 || value > 9) return false;
  const index = row * SIZE + col;
  if (grid[index] !== 0) return false;
  if (!candidatesFor(grid, index).includes(value)) return false;
  if (solution && solution[index] !== value) return false;
  return true;
}

/** Stima molto grezza della difficoltà in base al numero di indizi. */
export function estimateDifficulty(grid) {
  const givens = countFilled(grid);
  if (givens >= 46) return 1;
  if (givens >= 38) return 2;
  if (givens >= 32) return 3;
  if (givens >= 26) return 4;
  return 5;
}
