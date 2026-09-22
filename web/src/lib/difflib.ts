/**
 * A port of the part of Python's difflib.SequenceMatcher that the
 * uploader relies on: ratio() over two strings, with isjunk=None and the
 * default autojunk heuristic.
 *
 * Match scores feed straight into the confidence percentages artists
 * see, so this has to agree with the desktop app to the digit. It is
 * checked against Python's own output in test/parity.test.ts.
 */

type Block = [number, number, number];

function buildB2j(b: string): Map<string, number[]> {
  const b2j = new Map<string, number[]>();
  for (let i = 0; i < b.length; i++) {
    const indices = b2j.get(b[i]);
    if (indices) indices.push(i);
    else b2j.set(b[i], [i]);
  }
  // autojunk: in sequences of 200+ items, anything occurring in more
  // than 1% of positions is dropped from the index (but not junked).
  const n = b.length;
  if (n >= 200) {
    const ntest = Math.floor(n / 100) + 1;
    for (const [elt, idxs] of [...b2j]) {
      if (idxs.length > ntest) b2j.delete(elt);
    }
  }
  return b2j;
}

function findLongestMatch(
  a: string, b: string, b2j: Map<string, number[]>,
  alo: number, ahi: number, blo: number, bhi: number,
): Block {
  let besti = alo, bestj = blo, bestsize = 0;
  let j2len = new Map<number, number>();
  for (let i = alo; i < ahi; i++) {
    const newj2len = new Map<number, number>();
    for (const j of b2j.get(a[i]) ?? []) {
      if (j < blo) continue;
      if (j >= bhi) break;
      const k = (j2len.get(j - 1) ?? 0) + 1;
      newj2len.set(j, k);
      if (k > bestsize) {
        besti = i - k + 1;
        bestj = j - k + 1;
        bestsize = k;
      }
    }
    j2len = newj2len;
  }
  // With isjunk=None nothing is junk, so extend over equal neighbours
  // (this is what picks up the autojunk'd "popular" elements).
  while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
    besti--; bestj--; bestsize++;
  }
  while (besti + bestsize < ahi && bestj + bestsize < bhi
         && a[besti + bestsize] === b[bestj + bestsize]) {
    bestsize++;
  }
  return [besti, bestj, bestsize];
}

/** difflib.SequenceMatcher(None, a, b).ratio() */
export function ratio(a: string, b: string): number {
  const total = a.length + b.length;
  if (!total) return 1.0;
  const b2j = buildB2j(b);
  let matches = 0;
  const queue: [number, number, number, number][] = [[0, a.length, 0, b.length]];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop()!;
    const [i, j, k] = findLongestMatch(a, b, b2j, alo, ahi, blo, bhi);
    if (k) {
      matches += k;
      if (alo < i && blo < j) queue.push([alo, i, blo, j]);
      if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
    }
  }
  return (2.0 * matches) / total;
}
