// Split page text into overlapping chunks that fit the embedder's input signature.
//
// The LiteRT model only accepts inputs up to its signature length (we create it with
// maxInputLength 512 tokens). Anything longer fails with
// "INVALID_ARGUMENT: Failed to compute text embedding." — so chunks are sized by an
// estimated token count, not by characters. CJK text costs ~1 token per character,
// Latin text ~1 token per 3–4 characters.

export const TOKEN_BUDGET = 360; // per chunk body; leaves room for the prompt + title within 512

const CJK = /[　-〿぀-ヿ㐀-䶿一-鿿가-힯豈-﫿＀-￯]/g;

// Deliberately pessimistic estimate (over-counting is safe, under-counting is not).
// Emoji and other non-ASCII symbols may byte-fall-back to several tokens each.
export function estimateTokens(s) {
  const str = String(s);
  const cjk = (str.match(CJK) || []).length;
  const ascii = (str.match(/[\x00-\x7f]/g) || []).length;
  const other = str.length - cjk - ascii;   // UTF-16 units: an emoji counts twice
  return Math.ceil(cjk * 1.2 + ascii / 3 + other * 2);
}

// Longest prefix of s that fits within maxTokens.
export function truncateToTokens(s, maxTokens) {
  const str = String(s);
  if (estimateTokens(str) <= maxTokens) return str;
  let lo = 0, hi = str.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (estimateTokens(str.slice(0, mid)) <= maxTokens) lo = mid; else hi = mid - 1;
  }
  return str.slice(0, lo);
}

export function chunkText(text, { maxTokens = TOKEN_BUDGET, overlapTokens = 50, maxChunks = 32 } = {}) {
  const clean = String(text)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/g, "") // control / zero-width chars
    .replace(/\r/g, "")
    .replace(/[ \t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!clean) return [];

  // Paragraphs; any paragraph over budget is hard-split by tokens.
  const pieces = [];
  for (const p of clean.split(/\n+/).map(x => x.trim()).filter(Boolean)) {
    let rest = p;
    while (estimateTokens(rest) > maxTokens) {
      const head = truncateToTokens(rest, maxTokens);
      pieces.push(head);
      const back = truncateToTokens([...head].reverse().join(""), overlapTokens).length; // overlap from the tail
      rest = rest.slice(Math.max(1, head.length - back));
    }
    if (rest) pieces.push(rest);
  }

  const chunks = [];
  let cur = "";
  for (const p of pieces) {
    const joined = cur ? cur + "\n" + p : p;
    if (cur && estimateTokens(joined) > maxTokens) {
      chunks.push(cur);
      if (chunks.length >= maxChunks) return chunks;
      const tail = cur.slice(-Math.max(1, truncateToTokens([...cur].reverse().join(""), overlapTokens).length));
      const withOverlap = tail + "\n" + p;
      cur = estimateTokens(withOverlap) <= maxTokens ? withOverlap : p;
    } else {
      cur = joined;
    }
  }
  if (cur && chunks.length < maxChunks) chunks.push(cur);
  return chunks;
}

// Small stable hash to skip re-indexing unchanged pages.
export function hashText(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
}
