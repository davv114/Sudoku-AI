/**
 * Overlay fotografico (bonus "AR lite").
 * ------------------------------------------------------------------
 * Disegna i numeri risolti direttamente sopra la foto dello schema,
 * usando una trasformazione prospettica (omografia) calcolata dai
 * quattro angoli della griglia restituiti da Gemini.
 *
 * L'utente può trascinare gli angoli per correggere l'allineamento:
 * l'overlay resta così preciso anche con foto oblique.
 */

export const DEFAULT_CORNERS = [
  { x: 0.06, y: 0.06 },
  { x: 0.94, y: 0.06 },
  { x: 0.94, y: 0.94 },
  { x: 0.06, y: 0.94 },
];

/** Risolve un sistema lineare con eliminazione di Gauss (pivot parziale). */
function solveLinear(matrix, vector) {
  const n = matrix.length;
  const m = matrix.map((row, i) => [...row, vector[i]]);

  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
    }
    if (Math.abs(m[pivot][col]) < 1e-10) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];

    const divisor = m[col][col];
    for (let j = col; j <= n; j += 1) m[col][j] /= divisor;

    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const factor = m[row][col];
      if (!factor) continue;
      for (let j = col; j <= n; j += 1) m[row][j] -= factor * m[col][j];
    }
  }
  return m.map((row) => row[n]);
}

/**
 * Calcola l'omografia che mappa il quadrato unitario [0,1]x[0,1]
 * sui quattro angoli forniti (TL, TR, BR, BL).
 * Restituisce { a,b,c,d,e,f,g,h } oppure null.
 */
export function computeHomography(corners) {
  if (!Array.isArray(corners) || corners.length !== 4) return null;
  const [tl, tr, br, bl] = corners;
  const points = [
    [0, 0, tl],
    [1, 0, tr],
    [1, 1, br],
    [0, 1, bl],
  ];
  const A = [];
  const B = [];

  for (const [u, v, point] of points) {
    if (!point) return null;
    A.push([u, v, 1, 0, 0, 0, -u * point.x, -v * point.x]);
    B.push(point.x);
    A.push([0, 0, 0, u, v, 1, -u * point.y, -v * point.y]);
    B.push(point.y);
  }

  const h = solveLinear(A, B);
  if (!h || h.some((value) => !Number.isFinite(value))) return null;
  return { a: h[0], b: h[1], c: h[2], d: h[3], e: h[4], f: h[5], g: h[6], h: h[7] };
}

export function applyHomography(homography, u, v) {
  if (!homography) return null;
  const { a, b, c, d, e, f, g, h } = homography;
  const w = g * u + h * v + 1;
  if (Math.abs(w) < 1e-9) return null;
  return {
    x: (a * u + b * v + c) / w,
    y: (d * u + e * v + f) / w,
  };
}

function distance(p1, p2) {
  return Math.hypot(p1.x - p2.x, p1.y - p2.y);
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

export class PhotoOverlay {
  constructor(canvas) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d');
    this.image = null;
    this.corners = DEFAULT_CORNERS.map((point) => ({ ...point }));
    this.grid = null;
    this.givens = new Set();
    this.onlyAi = true;
    this.editing = false;
    this.activeCorner = -1;
    this.onCornersChange = null;
    this.pointerId = null;

    this.handlePointerDown = this.handlePointerDown.bind(this);
    this.handlePointerMove = this.handlePointerMove.bind(this);
    this.handlePointerUp = this.handlePointerUp.bind(this);

    canvas.addEventListener('pointerdown', this.handlePointerDown);
    canvas.addEventListener('pointermove', this.handlePointerMove);
    canvas.addEventListener('pointerup', this.handlePointerUp);
    canvas.addEventListener('pointercancel', this.handlePointerUp);
  }

  async setImage(dataUrl) {
    const image = new Image();
    image.decoding = 'async';
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('Impossibile caricare la foto per l\'overlay.'));
      image.src = dataUrl;
    });
    this.image = image;
    this.canvas.width = image.naturalWidth;
    this.canvas.height = image.naturalHeight;
    return this.render();
  }

  setGrid(grid, givens = new Set()) {
    this.grid = grid ? grid.slice() : null;
    this.givens = new Set(givens);
    this.render();
  }

  setCorners(corners) {
    if (Array.isArray(corners) && corners.length === 4) {
      this.corners = corners.map((point) => ({
        x: clamp01(Number(point.x)),
        y: clamp01(Number(point.y)),
      }));
    } else {
      this.resetCorners();
    }
    this.render();
  }

  resetCorners() {
    this.corners = DEFAULT_CORNERS.map((point) => ({ ...point }));
    this.render();
  }

  getCorners() {
    return this.corners.map((point) => ({ ...point }));
  }

  setOnlyAi(value) {
    this.onlyAi = Boolean(value);
    this.render();
  }

  setEditing(value) {
    this.editing = Boolean(value);
    if (this.editing) {
      this.canvas.classList.add('is-editing');
    } else {
      this.canvas.classList.remove('is-editing');
      this.activeCorner = -1;
    }
    this.render();
  }

  toCanvasPoint(event) {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;
    return {
      x: (event.clientX - rect.left) * scaleX,
      y: (event.clientY - rect.top) * scaleY,
    };
  }

  findCorner(point) {
    const scale = Math.min(this.canvas.width, this.canvas.height);
    const radius = Math.max(scale * 0.035, 14);
    for (let i = 0; i < 4; i += 1) {
      const corner = {
        x: this.corners[i].x * this.canvas.width,
        y: this.corners[i].y * this.canvas.height,
      };
      if (distance(point, corner) <= radius) return i;
    }
    return -1;
  }

  handlePointerDown(event) {
    if (!this.editing || !this.image) return;
    const point = this.toCanvasPoint(event);
    const corner = this.findCorner(point);
    if (corner < 0) return;
    this.activeCorner = corner;
    this.pointerId = event.pointerId;
    this.canvas.setPointerCapture?.(event.pointerId);
    this.canvas.classList.add('is-dragging');
    this.render();
  }

  handlePointerMove(event) {
    if (!this.editing || this.activeCorner < 0) return;
    const point = this.toCanvasPoint(event);
    this.corners[this.activeCorner] = {
      x: clamp01(point.x / this.canvas.width),
      y: clamp01(point.y / this.canvas.height),
    };
    this.render();
  }

  handlePointerUp(event) {
    if (this.activeCorner < 0) return;
    this.activeCorner = -1;
    this.canvas.classList.remove('is-dragging');
    if (event?.pointerId != null) {
      this.canvas.releasePointerCapture?.(event.pointerId);
    }
    this.onCornersChange?.(this.getCorners());
  }

  render() {
    const ctx = this.context;
    const { width, height } = this.canvas;
    if (!width || !height) return;

    ctx.clearRect(0, 0, width, height);
    if (!this.image) return;

    ctx.drawImage(this.image, 0, 0, width, height);

    const homography = computeHomography(this.corners);
    if (!homography) return;

    const map = (u, v) => applyHomography(homography, u, v);
    const lineWidth = Math.max(1.2, Math.min(width, height) / 900);

    // Griglia proiettata in prospettiva.
    for (let i = 0; i <= 9; i += 1) {
      const isMajor = i % 3 === 0;
      ctx.strokeStyle = isMajor ? 'rgba(79, 70, 229, 0.72)' : 'rgba(129, 140, 248, 0.4)';
      ctx.lineWidth = isMajor ? lineWidth * 2.1 : lineWidth;
      ctx.beginPath();
      const verticalStart = map(i / 9, 0);
      const verticalEnd = map(i / 9, 1);
      ctx.moveTo(verticalStart.x, verticalStart.y);
      ctx.lineTo(verticalEnd.x, verticalEnd.y);
      const horizontalStart = map(0, i / 9);
      const horizontalEnd = map(1, i / 9);
      ctx.moveTo(horizontalStart.x, horizontalStart.y);
      ctx.lineTo(horizontalEnd.x, horizontalEnd.y);
      ctx.stroke();
    }

    // Numeri.
    if (this.grid) {
      for (let index = 0; index < 81; index += 1) {
        const value = this.grid[index];
        if (!value) continue;
        const isGiven = this.givens.has(index);
        if (this.onlyAi && isGiven) continue;

        const row = Math.floor(index / 9);
        const col = index % 9;
        const center = map((col + 0.5) / 9, (row + 0.5) / 9);
        if (!center) continue;

        const p00 = map(col / 9, row / 9);
        const p10 = map((col + 1) / 9, row / 9);
        const p01 = map(col / 9, (row + 1) / 9);
        const p11 = map((col + 1) / 9, (row + 1) / 9);
        if (!p00 || !p10 || !p01 || !p11) continue;

        const cellWidth = (distance(p00, p10) + distance(p01, p11)) / 2;
        const cellHeight = (distance(p00, p01) + distance(p10, p11)) / 2;
        const fontSize = Math.max(10, Math.min(cellWidth, cellHeight) * 0.64);

        ctx.font = `800 ${fontSize}px ui-sans-serif, system-ui, "Segoe UI", sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineJoin = 'round';
        ctx.lineWidth = Math.max(2, fontSize * 0.2);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.94)';
        ctx.strokeText(String(value), center.x, center.y);
        ctx.fillStyle = isGiven ? '#0f172a' : '#dc2626';
        ctx.fillText(String(value), center.x, center.y);
      }
    }

    if (this.editing) {
      // Bordo tratteggiato del quadrilatero.
      ctx.save();
      ctx.setLineDash([lineWidth * 6, lineWidth * 5]);
      ctx.strokeStyle = 'rgba(34, 211, 238, 0.9)';
      ctx.lineWidth = lineWidth * 1.6;
      ctx.beginPath();
      const first = map(0, 0);
      ctx.moveTo(first.x, first.y);
      for (const [u, v] of [[1, 0], [1, 1], [0, 1]]) {
        const point = map(u, v);
        ctx.lineTo(point.x, point.y);
      }
      ctx.closePath();
      ctx.stroke();
      ctx.restore();

      // Maniglie trascinabili.
      const radius = Math.max(11, Math.min(width, height) * 0.016);
      this.corners.forEach((corner, index) => {
        const x = corner.x * width;
        const y = corner.y * height;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fillStyle = index === this.activeCorner ? 'rgba(34, 211, 238, 0.95)' : 'rgba(15, 23, 42, 0.82)';
        ctx.fill();
        ctx.lineWidth = Math.max(2, radius * 0.22);
        ctx.strokeStyle = '#e0f2fe';
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x, y, radius * 0.34, 0, Math.PI * 2);
        ctx.fillStyle = '#e0f2fe';
        ctx.fill();
      });
    }
  }

  destroy() {
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown);
    this.canvas.removeEventListener('pointermove', this.handlePointerMove);
    this.canvas.removeEventListener('pointerup', this.handlePointerUp);
    this.canvas.removeEventListener('pointercancel', this.handlePointerUp);
  }
}
