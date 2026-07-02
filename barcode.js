/**
 * barcode.js — Pure-JS Code 128B barcode renderer
 *
 * No external dependencies. Produces an <svg> string directly.
 *
 * Code 128B encodes printable ASCII (32–127). Each symbol is 3 bars and
 * 3 spaces with widths summing to 11 units. The stop symbol is 7 elements
 * summing to 13 units, followed by a 2-unit termination bar.
 *
 * Public API:
 *   renderBarcodeSVG(text, options?) → SVG string
 *   renderBarcodeInto(element, text, options?)  → sets innerHTML of element
 */

// ── Symbol patterns indexed 0–105 ────────────────────────────────────────────
// Each entry: [bar, space, bar, space, bar, space] widths in units.
//
//   0–95   → Code Set B characters (symbol value = ASCII code − 32)
//   96–102 → Function codes
//   103    → Start A
//   104    → Start B  ← used below
//   105    → Start C
//
const S = [
  [2,1,2,2,2,2],[2,2,2,1,2,2],[2,2,2,2,2,1],[1,2,1,2,2,3],[1,2,1,3,2,2],
  [1,3,1,2,2,2],[1,2,2,2,1,3],[1,2,2,3,1,2],[1,3,2,2,1,2],[2,2,1,2,1,3],
  [2,2,1,3,1,2],[2,3,1,2,1,2],[1,1,2,2,3,2],[1,2,2,1,3,2],[1,2,2,2,3,1],
  [1,1,3,2,2,2],[1,2,3,1,2,2],[1,2,3,2,2,1],[2,2,3,2,1,1],[2,2,1,1,3,2],
  [2,2,1,2,3,1],[2,1,3,2,1,2],[2,2,3,1,1,2],[3,1,2,1,3,1],[3,1,1,2,2,2],
  [3,2,1,1,2,2],[3,2,1,2,2,1],[3,1,2,2,1,2],[3,2,2,1,1,2],[3,2,2,2,1,1],
  [2,1,2,1,2,3],[2,1,2,3,2,1],[2,3,2,1,2,1],[1,1,1,3,2,3],[1,3,1,1,2,3],
  [1,3,1,3,2,1],[1,1,2,3,1,3],[1,3,2,1,1,3],[1,3,2,3,1,1],[2,1,1,3,1,3],
  [2,3,1,1,1,3],[2,3,1,3,1,1],[1,1,2,1,3,3],[1,1,2,3,3,1],[1,3,2,1,3,1],
  [1,1,3,1,2,3],[1,1,3,3,2,1],[1,3,3,1,2,1],[3,1,3,1,2,1],[2,1,1,3,3,1],
  [2,3,1,1,3,1],[2,1,3,1,1,3],[2,1,3,3,1,1],[2,1,3,1,3,1],[3,1,1,1,2,3],
  [3,1,1,3,2,1],[3,3,1,1,2,1],[3,1,2,1,1,3],[3,1,2,3,1,1],[3,3,2,1,1,1],
  [3,1,4,1,1,1],[2,2,1,4,1,1],[4,3,1,1,1,1],[1,1,1,2,2,4],[1,1,1,4,2,2],
  [1,2,1,1,2,4],[1,2,1,4,2,1],[1,4,1,1,2,2],[1,4,1,2,2,1],[1,1,2,2,1,4],
  [1,1,2,4,1,2],[1,2,2,1,1,4],[1,2,2,4,1,1],[1,4,2,1,1,2],[1,4,2,2,1,1],
  [2,4,1,2,1,1],[2,2,1,1,1,4],[4,1,3,1,1,1],[2,4,1,1,1,2],[1,3,4,1,1,1],
  [1,1,1,2,4,2],[1,2,1,1,4,2],[1,2,1,2,4,1],[1,1,4,2,1,2],[1,2,4,1,1,2],
  [1,2,4,2,1,1],[4,1,1,2,1,2],[4,2,1,1,1,2],[4,2,1,2,1,1],[2,1,2,1,4,1],
  [2,1,4,1,2,1],[4,1,2,1,2,1],[1,1,1,1,4,3],[1,1,1,3,4,1],[1,3,1,1,4,1],
  [1,1,4,1,1,3],[1,1,4,3,1,1],[4,1,1,1,1,3],[4,1,1,3,1,1],[1,1,3,1,4,1],
  [1,1,4,1,3,1],[3,1,1,1,4,1],[4,1,1,1,3,1],
  // Special / Start / Stop symbols (values 103–105)
  [2,1,1,4,1,2],  // 103 Start A
  [2,1,1,2,1,4],  // 104 Start B  ←
  [2,1,1,2,3,2],  // 105 Start C
];

const START_B   = 104;
const STOP_PAT  = [2,3,3,1,1,1,2];  // 7 widths, 13 units
const TERM_BAR  = 2;                 // termination bar after stop

// ── Encoder ───────────────────────────────────────────────────────────────────

function _encode(text) {
  const values = [];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 32 && c <= 127) values.push(c - 32);
  }

  // Weighted checksum
  let sum = START_B;
  values.forEach((v, i) => { sum += (i + 1) * v; });
  const check = sum % 103;

  // Flatten to bar/space sequence: [width, isBar]
  const segments = [];
  const push = (pattern) =>
    pattern.forEach((w, i) => segments.push([w, i % 2 === 0]));

  push([10]);            // left quiet zone (space)
  segments[0][1] = false;
  push(S[START_B]);
  values.forEach(v => push(S[v]));
  push(S[check]);
  push(STOP_PAT);
  segments.push([TERM_BAR, true]);
  segments.push([10, false]);   // right quiet zone

  return segments;
}

// ── SVG renderer ──────────────────────────────────────────────────────────────

/**
 * Render a Code 128B barcode as an SVG string.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {number} [opts.height=50]       Bar height in px
 * @param {number} [opts.scale=2]         Pixels per barcode unit
 * @param {string} [opts.barColor]        Bar colour
 * @param {string} [opts.bgColor]         Background colour (or 'none')
 * @returns {string} SVG markup
 */
export function renderBarcodeSVG(text, {
  height   = 50,
  scale    = 2,
  barColor = '#111827',
  bgColor  = '#ffffff',
} = {}) {
  const segments = _encode(text);
  const totalUnits = segments.reduce((s, [w]) => s + w, 0);
  const W = totalUnits * scale;
  const H = height;

  const rects = [];
  if (bgColor !== 'none') {
    rects.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="${bgColor}"/>`);
  }

  let x = 0;
  for (const [units, isBar] of segments) {
    const w = units * scale;
    if (isBar) {
      rects.push(`<rect x="${x}" y="0" width="${w}" height="${H}" fill="${barColor}"/>`);
    }
    x += w;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" \
width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" \
role="img" aria-label="Barcode">\n${rects.join('\n')}\n</svg>`;
}

/**
 * Convenience wrapper: render a barcode into an existing DOM element.
 * Replaces the element's innerHTML.
 *
 * @param {Element} el
 * @param {string}  text
 * @param {object}  [opts]
 */
export function renderBarcodeInto(el, text, opts = {}) {
  if (!el) return;
  el.innerHTML = renderBarcodeSVG(text, opts);
}
