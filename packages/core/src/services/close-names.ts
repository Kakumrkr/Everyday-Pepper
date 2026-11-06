// Close names for a misspelt client name (S56a, ADR-0060): "Mraia" → Maria. Pepper asks "Did
// you mean …?" with them and never acts on one by itself. Each word of the search is compared
// with each word of a name by an edit distance that counts a swap of two neighbouring letters
// as one (optimal string alignment); a word of 3–5 letters may be 1 edit off, a longer one 2. Pure: the caller passes the names the member may see.

/** How many close names are suggested at most. */
export const CLOSE_NAMES_SHOWN = 3;

/** The edits allowed for a word of this length. */
function allowedEdits(length: number): number {
  if (length <= 2) return 0;
  return length <= 5 ? 1 : 2;
}

/** Optimal string alignment distance: insertions, deletions, substitutions, adjacent swaps. */
export function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) =>
    Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  const at = (i: number, j: number): number => d[i]?.[j] ?? Number.POSITIVE_INFINITY;
  for (let i = 1; i < rows; i += 1) {
    const row = d[i];
    if (row === undefined) continue;
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, at(i - 2, j - 2) + 1);
      }
      row[j] = best;
    }
  }
  return at(a.length, b.length);
}

const words = (text: string): string[] =>
  text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((word) => word !== '');

/**
 * How far `name` is from `search` (lower is closer), or `null` when it isn't close: every word
 * of the search must be within its allowed edits of a word of the name (or start one, for a
 * search word of 4+ letters typed in part).
 */
export function nameDistance(search: string, name: string): number | null {
  const wanted = words(search);
  const have = words(name);
  if (wanted.length === 0 || have.length === 0) return null;
  let total = 0;
  for (const word of wanted) {
    let best: number | null = null;
    const allowed = allowedEdits(word.length);
    for (const candidate of have) {
      // A word typed in part ("mrai" for Mariana) against the name's start of the same length,
      // then the whole word when the lengths are close enough to be within the edits.
      const prefix =
        word.length >= 4 && candidate.length > word.length
          ? editDistance(word, candidate.slice(0, word.length))
          : Number.POSITIVE_INFINITY;
      const closest =
        prefix === 0 || Math.abs(candidate.length - word.length) > allowed
          ? prefix
          : Math.min(prefix, editDistance(word, candidate));
      if (closest <= allowed && (best === null || closest < best)) best = closest;
    }
    if (best === null) return null;
    total += best;
  }
  return total;
}

/** The closest names to `search`, closest first (then by name), at most `limit`. */
export function closeNames<T extends { name: string }>(
  search: string,
  candidates: readonly T[],
  limit = CLOSE_NAMES_SHOWN,
): T[] {
  return candidates
    .flatMap((candidate) => {
      const distance = nameDistance(search, candidate.name);
      return distance === null ? [] : [{ candidate, distance }];
    })
    .sort((a, b) => a.distance - b.distance || a.candidate.name.localeCompare(b.candidate.name))
    .slice(0, limit)
    .map(({ candidate }) => candidate);
}
