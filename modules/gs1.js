/**
 * gs1.js — GS1-128 Application Identifier parser and builder
 *
 * Supports the four AIs used by QuickStore deliveries:
 *   (01) GTIN          — 14 digits, fixed length
 *   (17) Best Before   — 6 digits YYMMDD, fixed length
 *   (37) Quantity      — variable length
 *   (10) Batch / Lot   — variable length
 *
 * Both the parenthesised human-readable form  (01)04000417023400(17)280629…
 * and the raw concatenated form are accepted as input.
 */

// Fixed-length AIs: AI → data length in characters
const AI_FIXED = {
  '00': 18, '01': 14, '02': 14,
  '11': 6,  '12': 6,  '13': 6,
  '15': 6,  '17': 6,  '18': 6,
  '19': 6,  '20': 2,
};

// ── Parser ────────────────────────────────────────────────────────────────────

/**
 * Parse a GS1-128 string and return an object with recognised fields.
 *
 * @param {string} input
 * @returns {{ gtin?, best_before?, quantity?, batch_ref? }}
 */
export function parseGS1(input) {
  const str    = (input ?? '').replace(/\s/g, '');
  const result = {};

  if (str.startsWith('(')) {
    // Parenthesised form — straightforward regex scan
    const re = /\((\d{2,4})\)([^(]*)/g;
    let m;
    while ((m = re.exec(str)) !== null) {
      _applyAI(result, m[1], m[2]);
    }
  } else {
    // Raw concatenated form — walk using AI length table
    let i = 0;
    while (i < str.length) {
      // Try 4-, 3-, 2-digit AI prefixes in order
      let ai = null, dataLen = null;
      for (const len of [4, 3, 2]) {
        const candidate = str.slice(i, i + len);
        if (AI_FIXED[candidate] !== undefined) {
          ai      = candidate;
          dataLen = AI_FIXED[candidate];
          break;
        }
      }
      if (!ai) break;   // unknown AI — stop
      i += ai.length;
      _applyAI(result, ai, str.slice(i, i + dataLen));
      i += dataLen;
    }
  }

  return result;
}

function _applyAI(result, ai, value) {
  switch (ai) {
    case '01':   // GTIN — store as-is (14 digits)
      result.gtin = value;
      break;
    case '17':   // Best Before YYMMDD → YYYY-MM-DD
      result.best_before =
        `20${value.slice(0,2)}-${value.slice(2,4)}-${value.slice(4,6)}`;
      break;
    case '37':   // Quantity
      result.quantity = parseInt(value, 10);
      break;
    case '10':   // Lot / Batch
      result.batch_ref = value.trim();
      break;
  }
}

// ── Builder ───────────────────────────────────────────────────────────────────

/**
 * Build a GS1-128 parenthesised string from individual fields.
 * Only AIs for which data is supplied are included.
 *
 * @param {string}      gtin        — 14-digit GTIN
 * @param {string|null} bestBefore  — 'YYYY-MM-DD' or null
 * @param {number|null} quantity
 * @param {string|null} batchRef
 * @returns {string}  e.g. "(01)04000417023400(17)280629(37)24(10)CH-MW-003"
 */
export function buildGS1(gtin, bestBefore, quantity, batchRef) {
  let str = `(01)${gtin.padStart(14, '0')}`;

  if (bestBefore) {
    const [y, m, d] = bestBefore.split('-');
    str += `(17)${y.slice(2)}${m}${d}`;
  }

  if (quantity != null) str += `(37)${quantity}`;
  if (batchRef)         str += `(10)${batchRef}`;

  return str;
}
