// SPDX-License-Identifier: Apache-2.0
// The one-to-one assignment of a note's clusters to candidates: the
// Hungarian method over the eligible pairs, with one unknown option per cluster, maximizing the
// summed score. Equal optima break deterministically: candidates in ascending id order each take
// the first cluster, in ascending key order, that still allows an optimal completion. Pure.

/** Relative tolerance under which two totals count as equal. */
const EPS = 1e-9

/**
 * `weight[i][j]` is the gain of cluster `i` taking candidate `j` over its unknown option (> 0),
 * or null when the pair is forbidden or not above the floor. Rows and columns are already in
 * ascending key and id order. Returns the column assigned to each row, or -1 (unknown).
 */
export function assignOneToOne(weight: (number | null)[][], columns: number): number[] {
  const rows = weight.map((_, i) => i)
  const result: number[] = rows.map(() => -1)
  let freeRows = rows.filter((i) => weight[i]?.some((w) => w !== null))
  let freeCols: number[] = []
  for (let j = 0; j < columns; j++) if (freeRows.some((i) => weight[i]?.[j] != null)) freeCols.push(j)
  let best = optimum(weight, freeRows, freeCols)

  for (const j of [...freeCols]) {
    for (const i of freeRows) {
      const w = weight[i]?.[j]
      if (w == null) continue
      const restRows = freeRows.filter((r) => r !== i)
      const restCols = freeCols.filter((c) => c !== j)
      const rest = optimum(weight, restRows, restCols)
      if (w + rest >= best - EPS * (1 + Math.abs(best))) {
        result[i] = j
        freeRows = restRows
        best = rest
        break
      }
    }
    // Taken or not, this candidate is settled: no optimal completion gives it another cluster.
    freeCols = freeCols.filter((c) => c !== j)
  }
  return result
}

/**
 * The best total of a max-weight matching of `rows` into `cols`, each row free to take its own
 * unknown column (gain 0). Hungarian method on costs, O(n²·m).
 */
function optimum(weight: (number | null)[][], rows: number[], cols: number[]): number {
  const n = rows.length
  if (n === 0 || cols.length === 0) return 0
  const real = cols.length
  const m = real + n
  // 1-indexed. A forbidden pair costs 1: never better than a free unknown column (0).
  const cost = (i: number, j: number): number => {
    if (j > real) return 0
    const w = weight[rows[i - 1] as number]?.[cols[j - 1] as number]
    return w == null ? 1 : -w
  }
  const u = new Float64Array(n + 1)
  const v = new Float64Array(m + 1)
  const p = new Int32Array(m + 1)
  const way = new Int32Array(m + 1)
  for (let i = 1; i <= n; i++) {
    p[0] = i
    let j0 = 0
    const minv = new Float64Array(m + 1).fill(Infinity)
    const used = new Uint8Array(m + 1)
    do {
      used[j0] = 1
      const i0 = p[j0] as number
      let delta = Infinity
      let j1 = 0
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue
        const cur = cost(i0, j) - (u[i0] as number) - (v[j] as number)
        if (cur < (minv[j] as number)) {
          minv[j] = cur
          way[j] = j0
        }
        if ((minv[j] as number) < delta) {
          delta = minv[j] as number
          j1 = j
        }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          u[p[j] as number] = (u[p[j] as number] as number) + delta
          v[j] = (v[j] as number) - delta
        } else {
          minv[j] = (minv[j] as number) - delta
        }
      }
      j0 = j1
    } while (p[j0] !== 0)
    do {
      const j1 = way[j0] as number
      p[j0] = p[j1] as number
      j0 = j1
    } while (j0 !== 0)
  }
  let total = 0
  for (let j = 1; j <= real; j++) {
    const i = p[j] as number
    if (i === 0) continue
    const w = weight[rows[i - 1] as number]?.[cols[j - 1] as number]
    if (w != null) total += w
  }
  return total
}
