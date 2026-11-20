/**
 * Test automatici del motore Sudoku e dell'overlay, eseguiti nel browser.
 * Apri http://localhost:8765/tests.html con server.py attivo.
 */

import {
  parseGrid,
  solveGrid,
  countSolutions,
  findHint,
  isComplete,
  validateGrid,
  findConflicts,
  isLegalMove,
  candidatesFor,
} from './sudoku.js';
import { SAMPLES } from './samples.js';
import { computeHomography, applyHomography } from './overlay.js';

const results = [];
const list = document.getElementById('results');
const summary = document.getElementById('summary');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function near(a, b, tolerance = 1e-6) {
  return Math.abs(a - b) <= tolerance;
}

function renderResult(result) {
  const item = document.createElement('li');
  item.className = `test ${result.ok ? 'test--pass' : 'test--fail'}`;

  const badge = document.createElement('span');
  badge.className = 'test-badge';
  badge.textContent = result.ok ? 'PASS' : 'FAIL';

  const body = document.createElement('div');
  const name = document.createElement('strong');
  name.textContent = result.name;
  body.append(name);

  if (!result.ok) {
    const error = document.createElement('p');
    error.textContent = result.error;
    body.append(error);
  } else {
    const time = document.createElement('p');
    time.textContent = `${result.ms.toFixed(1)} ms`;
    body.append(time);
  }

  item.append(badge, body);
  list.append(item);
}

async function test(name, fn) {
  const started = performance.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: performance.now() - started });
  } catch (error) {
    results.push({ name, ok: false, error: error.message, ms: performance.now() - started });
  }
  renderResult(results[results.length - 1]);
  updateSummary();
}

function updateSummary() {
  const passed = results.filter((result) => result.ok).length;
  const failed = results.length - passed;
  summary.textContent = `${passed} superati · ${failed} falliti · ${results.length} totali`;
  summary.className = failed === 0 ? 'summary summary--ok' : 'summary summary--fail';
}

const EASY_SOLUTION =
  '534678912672195348198342567859761423426853791713924856961537284287419635345286179';

async function run() {
  for (const sample of SAMPLES) {
    await test(`Esempio "${sample.label}": 81 cifre e soluzione unica`, () => {
      assert(sample.grid.length === 81, `La griglia ha ${sample.grid.length} caratteri invece di 81.`);
      const grid = parseGrid(sample.grid);
      assert(grid.filter(Boolean).length > 16, 'La griglia ha troppo pochi indizi.');
      assert(countSolutions(grid, 2) === 1, 'La griglia non ha esattamente una soluzione.');
      assert(solveGrid(grid) !== null, 'La griglia non è risolvibile.');
    });
  }

  await test('La soluzione dell\'esempio facile è quella attesa', () => {
    const solution = solveGrid(parseGrid(SAMPLES[0].grid));
    assert(solution, 'Nessuna soluzione.');
    assert(solution.join('') === EASY_SOLUTION, 'La soluzione non coincide con quella nota.');
  });

  await test('La validazione rileva un conflitto in riga', () => {
    const grid = parseGrid(SAMPLES[0].grid);
    const empty = grid.indexOf(0);
    const rowStart = Math.floor(empty / 9) * 9;
    let duplicateValue = 0;
    for (let i = rowStart; i < rowStart + 9; i += 1) {
      if (grid[i] && i !== empty) duplicateValue = grid[i];
    }
    assert(duplicateValue > 0, 'Impossibile preparare il test.');
    grid[empty] = duplicateValue;

    const validation = validateGrid(grid);
    assert(!validation.ok, 'La griglia doveva essere segnalata come non valida.');
    assert(findConflicts(grid).size >= 2, 'I conflitti non sono stati rilevati.');
  });

  await test('Una griglia con doppioni non produce soluzioni', () => {
    const grid = parseGrid(SAMPLES[0].grid);
    grid[1] = grid[0];
    assert(solveGrid(grid) === null, 'Il solutore doveva rifiutare la griglia.');
  });

  for (const sample of SAMPLES) {
    await test(`Il tutor risolve "${sample.label}" una mossa alla volta`, () => {
      const grid = parseGrid(sample.grid);
      const solution = solveGrid(grid);
      assert(solution, 'Nessuna soluzione.');

      let moves = 0;
      while (!isComplete(grid)) {
        const hint = findHint(grid, solution);
        assert(!hint.error, hint.error || 'Suggerimento non disponibile.');
        assert(grid[hint.index] === 0, 'Il suggerimento punta a una cella già piena.');
        assert(hint.value >= 1 && hint.value <= 9, 'Valore del suggerimento fuori range.');
        assert(
          hint.value === solution[hint.index],
          `Mossa errata in ${hint.index}: ${hint.value} invece di ${solution[hint.index]}.`,
        );
        grid[hint.index] = hint.value;
        moves += 1;
        assert(moves <= 81, 'Troppe mosse: possibile ciclo infinito.');
      }

      assert(isComplete(grid), 'La griglia non è stata completata.');
      assert(validateGrid(grid).ok, 'La griglia finale contiene conflitti.');
    });
  }

  await test('I candidati escludono riga, colonna e blocco', () => {
    const grid = parseGrid(SAMPLES[0].grid);
    const empty = grid.indexOf(0);
    const candidates = candidatesFor(grid, empty);
    assert(candidates.length > 0 && candidates.length <= 9, 'Numero di candidati non valido.');
    assert(new Set(candidates).size === candidates.length, 'Candidati duplicati.');
  });

  await test('isLegalMove accetta solo mosse coerenti con la soluzione', () => {
    const grid = parseGrid(SAMPLES[0].grid);
    const solution = solveGrid(grid);
    let empty = -1;
    for (let i = 0; i < 81; i += 1) {
      if (!grid[i]) {
        empty = i;
        break;
      }
    }
    const row = Math.floor(empty / 9);
    const col = empty % 9;
    assert(isLegalMove(grid, solution, row, col, solution[empty]), 'La mossa corretta è stata rifiutata.');
    const wrong = solution[empty] === 9 ? 8 : solution[empty] + 1;
    assert(!isLegalMove(grid, solution, row, col, wrong), 'La mossa errata è stata accettata.');
  });

  await test('Omografia: il quadrato unitario resta invariato', () => {
    const corners = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ];
    const homography = computeHomography(corners);
    assert(homography, 'Omografia non calcolata.');
    const center = applyHomography(homography, 0.5, 0.5);
    assert(center && near(center.x, 0.5) && near(center.y, 0.5), 'Il centro non è stato mappato correttamente.');
  });

  await test('Omografia: i quattro angoli sono mappati sui punti richiesti', () => {
    const corners = [
      { x: 0.1, y: 0.05 },
      { x: 0.92, y: 0.12 },
      { x: 0.86, y: 0.94 },
      { x: 0.04, y: 0.88 },
    ];
    const homography = computeHomography(corners);
    assert(homography, 'Omografia non calcolata.');

    const mapped = [
      applyHomography(homography, 0, 0),
      applyHomography(homography, 1, 0),
      applyHomography(homography, 1, 1),
      applyHomography(homography, 0, 1),
    ];
    mapped.forEach((point, index) => {
      assert(point, `Punto ${index} non mappato.`);
      assert(near(point.x, corners[index].x, 1e-5), `X dell'angolo ${index} errata.`);
      assert(near(point.y, corners[index].y, 1e-5), `Y dell'angolo ${index} errata.`);
    });
  });

  updateSummary();
  document.body.dataset.done = 'true';
}

run().catch((error) => {
  summary.textContent = `Errore durante l'esecuzione dei test: ${error.message}`;
  summary.className = 'summary summary--fail';
  console.error(error);
});
