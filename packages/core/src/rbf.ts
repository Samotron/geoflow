/**
 * Thin-plate spline (TPS) interpolation for geological surface fitting.
 *
 * TPS minimises the bending energy of a surface that passes exactly through
 * all control points.  Basis function: φ(r) = r² ln(r)
 *
 * The system solved is:
 *   [ Φ   P ] [w]   [z]
 *   [ Pᵀ  0 ] [a] = [0]
 *
 * where Φᵢⱼ = φ(‖pᵢ − pⱼ‖), P = [1  xᵢ  yᵢ], w = RBF weights,
 * a = [a₀, a₁, a₂] are the linear polynomial coefficients.
 */

export interface Pt2 { x: number; y: number; }
export interface Pt3 { x: number; y: number; z: number; }

// ── Basis function ────────────────────────────────────────────────────────────

function tps(r: number): number {
  if (r < 1e-12) return 0;
  return r * r * Math.log(r);
}

// ── Safe accessor (noUncheckedIndexedAccess-compatible) ───────────────────────

function g(arr: Float64Array, i: number): number { return arr[i] ?? 0; }
function s(arr: Float64Array, i: number, v: number): void { arr[i] = v; }

// ── Dense Gaussian elimination (flat 1-D, row-major) ─────────────────────────

function gaussSolve(n: number, A: Float64Array, b: Float64Array): Float64Array {
  // Build augmented matrix M: n rows × (n+1) cols, flat row-major
  const m = n + 1;
  const M = new Float64Array(n * m);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) s(M, i * m + j, g(A, i * n + j));
    s(M, i * m + n, g(b, i));
  }

  for (let col = 0; col < n; col++) {
    // Partial pivot
    let maxRow = col;
    let maxVal = Math.abs(g(M, col * m + col));
    for (let row = col + 1; row < n; row++) {
      const v = Math.abs(g(M, row * m + col));
      if (v > maxVal) { maxVal = v; maxRow = row; }
    }
    if (maxRow !== col) {
      for (let j = 0; j <= n; j++) {
        const tmp = g(M, col * m + j);
        s(M, col * m + j, g(M, maxRow * m + j));
        s(M, maxRow * m + j, tmp);
      }
    }

    const pivot = g(M, col * m + col);
    if (Math.abs(pivot) < 1e-14) continue;

    for (let row = col + 1; row < n; row++) {
      const f = g(M, row * m + col) / pivot;
      for (let j = col; j <= n; j++) {
        s(M, row * m + j, g(M, row * m + j) - f * g(M, col * m + j));
      }
    }
  }

  // Back-substitution
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let sv = g(M, i * m + n);
    for (let j = i + 1; j < n; j++) sv -= g(M, i * m + j) * g(x, j);
    s(x, i, sv / g(M, i * m + i));
  }
  return x;
}

// ── ThinPlateSurface ──────────────────────────────────────────────────────────

export class ThinPlateSurface {
  private readonly ptsX: Float64Array;
  private readonly ptsY: Float64Array;
  private readonly w: Float64Array;  // N RBF weights
  private readonly a0: number;
  private readonly a1: number;
  private readonly a2: number;

  /**
   * Fit a thin-plate spline to at least 3 scattered (x, y, z) data points.
   * Throws if fewer than 3 points are supplied.
   */
  constructor(pts: Pt3[]) {
    if (pts.length < 3) throw new Error('ThinPlateSurface needs ≥ 3 points');
    const n = pts.length;
    this.ptsX = new Float64Array(n);
    this.ptsY = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      this.ptsX[i] = pts[i]?.x ?? 0;
      this.ptsY[i] = pts[i]?.y ?? 0;
    }

    const sz = n + 3;
    const Aflat = new Float64Array(sz * sz);
    const bvec  = new Float64Array(sz);

    // Φ block
    for (let i = 0; i < n; i++) {
      const ix = pts[i]?.x ?? 0;
      const iy = pts[i]?.y ?? 0;
      for (let j = 0; j < n; j++) {
        const dx = ix - (pts[j]?.x ?? 0);
        const dy = iy - (pts[j]?.y ?? 0);
        s(Aflat, i * sz + j, tps(Math.sqrt(dx * dx + dy * dy)));
      }
    }
    // P block and its transpose
    for (let i = 0; i < n; i++) {
      const px = pts[i]?.x ?? 0;
      const py = pts[i]?.y ?? 0;
      s(Aflat, i * sz + n,       1);   s(Aflat, n       * sz + i, 1);
      s(Aflat, i * sz + (n + 1), px);  s(Aflat, (n + 1) * sz + i, px);
      s(Aflat, i * sz + (n + 2), py);  s(Aflat, (n + 2) * sz + i, py);
    }
    // RHS
    for (let i = 0; i < n; i++) bvec[i] = pts[i]?.z ?? 0;

    const sol = gaussSolve(sz, Aflat, bvec);
    this.w  = sol.slice(0, n);
    this.a0 = g(sol, n);
    this.a1 = g(sol, n + 1);
    this.a2 = g(sol, n + 2);
  }

  /** Evaluate the interpolated surface at (x, y). */
  evaluate(x: number, y: number): number {
    let val = this.a0 + this.a1 * x + this.a2 * y;
    for (let i = 0; i < this.ptsX.length; i++) {
      const dx = x - g(this.ptsX, i);
      const dy = y - g(this.ptsY, i);
      val += g(this.w, i) * tps(Math.sqrt(dx * dx + dy * dy));
    }
    return val;
  }

  /**
   * Evaluate on a regular nx × ny grid covering [xMin,xMax] × [yMin,yMax].
   * Returns a flat Float32Array in row-major order (y outer, x inner).
   */
  evaluateGrid(
    xMin: number, xMax: number,
    yMin: number, yMax: number,
    nx: number, ny: number,
  ): Float32Array {
    const out = new Float32Array(nx * ny);
    for (let iy = 0; iy < ny; iy++) {
      const y = yMin + (iy / (ny - 1)) * (yMax - yMin);
      for (let ix = 0; ix < nx; ix++) {
        const x = xMin + (ix / (nx - 1)) * (xMax - xMin);
        out[iy * nx + ix] = this.evaluate(x, y);
      }
    }
    return out;
  }

  /**
   * Evaluate at N equally-spaced points along the line from (x0,y0) to (x1,y1).
   */
  sampleLine(
    x0: number, y0: number,
    x1: number, y1: number,
    n: number,
  ): { dist: number; z: number }[] {
    const ddx = x1 - x0;
    const ddy = y1 - y0;
    const totalDist = Math.sqrt(ddx * ddx + ddy * ddy);
    const result: { dist: number; z: number }[] = [];
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      result.push({ dist: t * totalDist, z: this.evaluate(x0 + t * ddx, y0 + t * ddy) });
    }
    return result;
  }
}
