/**
 * warehouse.js — v10
 *
 * Tile-based geometry, building on v9.
 *
 * Every dimension in this file is derived from a single TILE constant
 * (24px). The whole floor plan is laid out in whole tile counts first —
 * slot size, corridor widths, wall thickness, gaps — and only then
 * multiplied into pixels. This guarantees:
 *
 *   • Every "large path" (Hauptgang, the vertical transit lane) is exactly
 *     2 tiles wide, giving the robot room to dodge sideways around a
 *     blocked tile.
 *   • Every "around-shelf" access lane (the 1-tile gap directly above and
 *     below each row of slots) gives the robot a navigable strip on BOTH
 *     sides of every shelf — frozen included, now that there's a gap
 *     between the header and the top of the frozen row, not just below it.
 *     robot.js can dock at any of the 4 tiles spanning a shelf's width on
 *     either side (8 candidates total), picking whichever gives the
 *     shortest route — useful once obstacles start blocking specific tiles.
 *   • The navigability grid used by robot.js for A* has CELL_SIZE = TILE,
 *     so one grid cell = one visual tile = one placeable obstacle.
 *
 * Tile budget (see inline tile-unit comments below for the exact layout):
 *   Horizontal: Warenannahme(3) + label(1) + transit(2) + 5 slot columns
 *               of 4 tiles each with 1-tile gaps + pad(1) + Versand(3) = 34 tiles → 816px
 *   Vertical:   header(1) + header-gap(1) + frozen(2) + wall-gap(1) + wall(1)
 *               + wall-gap(1) + chilled(2) + aisle-gap(1) + Hauptgang(2)
 *               + aisle-gap(1) + ambient-A(2) + row-gap(1) + ambient-B(2)
 *               + bottom-gap(1) + deco(2) = 21 tiles → 504px
 */

// ── Tile system ───────────────────────────────────────────────────────────────

export const TILE      = 24;   // px per tile — the single source of truth for all geometry
export const CELL_SIZE  = TILE; // navigability grid cell size — 1 cell = 1 visual tile

// ── Horizontal tile budget ────────────────────────────────────────────────────

const HOME_TILES_W     = 3;   // Warenannahme strip
const LABEL_TILES_W    = 1;   // protected zone-label column
const TRANSIT_TILES_W  = 2;   // vertical transit corridor — a "large path"
const SLOT_TILES_W     = 4;   // each shelf slot
const COL_GAP_TILES    = 1;   // gap between adjacent slot columns — "around shelves"
const PAD_R_TILES      = 1;   // buffer before the Versand wall
const VERSAND_TILES_W  = 3;   // Versand strip

export const LEFT_W  = HOME_TILES_W * TILE;        // 72
export const RIGHT_W = VERSAND_TILES_W * TILE;     // 72
export const LABEL_ZONE_W = LABEL_TILES_W * TILE;  // 24
const TRANSIT_W = TRANSIT_TILES_W * TILE;            // 48
const PAD_R     = PAD_R_TILES * TILE;                // 24

export const SLOT_W  = SLOT_TILES_W * TILE;   // 96
const        COL_GAP = COL_GAP_TILES * TILE;  // 24
const        COLD_COL_STEP = SLOT_W + COL_GAP; // 120 — column pitch

export const GRID_X = LEFT_W + LABEL_ZONE_W + TRANSIT_W;  // 144 — first slot column starts here
export const AMB_W  = 4 * COLD_COL_STEP + SLOT_W;          // 576 — col1-left to col5-right span

export const CANVAS_W = GRID_X + AMB_W + PAD_R + RIGHT_W;  // 816

// ── Vertical tile budget ──────────────────────────────────────────────────────

const HEADER_TILES_H   = 1;   // "KÜHLBEREICH" header strip
const SLOT_TILES_H     = 2;   // each shelf slot row
const GAP_TILES        = 1;   // every approach lane / row gap — "around shelves"
const WALL_TILES_H     = 1;   // Gefrierwand thickness
const HAUPTGANG_TILES  = 2;   // main aisle — a "large path"
const DECO_TILES_H     = 2;   // decorative bottom rooms

export const PAD_T  = HEADER_TILES_H * TILE; // 24
export const SLOT_H = SLOT_TILES_H * TILE;   // 48
const GAP            = GAP_TILES * TILE;       // 24 — reused for every 1-tile gap
const WALL_H         = WALL_TILES_H * TILE;    // 24

export const Y_D      = PAD_T + GAP;                       // 48 — +1 tile gap above frozen row
export const WALL_TOP = Y_D + SLOT_H + GAP;                // 120
export const WALL_BOT = WALL_TOP + WALL_H;                 // 144
export const Y_C      = WALL_BOT + GAP;                    // 168
export const AISLE_H  = HAUPTGANG_TILES * TILE;            // 48
export const AISLE_Y  = Y_C + SLOT_H + GAP;                // 240
export const AISLE_CY = AISLE_Y + AISLE_H / 2;              // 264
export const Y_A      = AISLE_Y + AISLE_H + GAP;           // 312
export const Y_B      = Y_A + SLOT_H + GAP;                // 384
export const DECO_Y   = Y_B + SLOT_H + GAP;                 // 456
const        DECO_H   = DECO_TILES_H * TILE;                 // 48

export const CANVAS_H = DECO_Y + DECO_H;  // 504

// ── Gefrierwand door geometry ─────────────────────────────────────────────────
// The door spans the full width of column 3, so it visually and structurally
// aligns with that shelf column — "the spot where the vertical path is at
// its widest" from the original brief.

export const DOOR_COL   = 3;
export const DOOR_LEFT  = GRID_X + 2 * COLD_COL_STEP;  // 384
export const DOOR_RIGHT = DOOR_LEFT + SLOT_W;           // 480

// ── Column / label helpers ────────────────────────────────────────────────────

/** X centre of a storage column. Uniform pitch now — no special-casing needed. */
export function getColumnCenterX(col) {
  return GRID_X + (col - 1) * COLD_COL_STEP + SLOT_W / 2;
}

export const HOME_X = LEFT_W / 2;                          // 36
export const EXIT_X = CANVAS_W - RIGHT_W / 2;               // 780 — Versand drop-off point
export const LABEL_X = LEFT_W + LABEL_ZONE_W / 2;          // 84 — zone-label text centre

// Visual divider between Trockenware (col 1-3) and Frische (col 4-5),
// centred in the gap between column 3 and column 4.
const ZONE_DIVIDER_X = DOOR_RIGHT + COL_GAP / 2;  // 492

const TROCK_X  = GRID_X;                      // 144
const TROCK_W  = DOOR_RIGHT - GRID_X;        // 336 — span of columns 1-3
const FRISCH_X = GRID_X + 3 * COLD_COL_STEP; // 504 — column 4 left edge
const FRISCH_W = AMB_W - (FRISCH_X - GRID_X); // 216 — span of columns 4-5

// ── Zone colours ──────────────────────────────────────────────────────────────

const ZONE = {
  frozen:  { empty: '#0A1220', occupied: '#1A3A6E', label: '#2A5090', text: '#90B8E8' },
  chilled: { empty: '#162540', occupied: '#1A5FA8', label: '#3A70A8', text: '#A0C8F0' },
  fresh:   { empty: '#162010', occupied: '#3A6E1A', label: '#5AAA30', text: '#B0E880' },
  ambient: { empty: '#1E2736', occupied: '#1E5C38', label: '#4A7A5A', text: '#9DD8B0' },
};

export const ROBOT_COLOR = '#F59E0B';

// ── Module state ──────────────────────────────────────────────────────────────

let _canvas      = null;
let _ctx         = null;
let _slots       = [];
let _selectedId  = null;
let _onSlotClick = null;
let _robotState  = null;
let _obstacles   = new Set();
let _showGrid    = false;

// ── Public API ────────────────────────────────────────────────────────────────

export function initWarehouse(canvasEl, onSlotClick) {
  _canvas      = canvasEl;
  _ctx         = canvasEl.getContext('2d');
  _onSlotClick = onSlotClick;
  _canvas.width  = CANVAS_W;
  _canvas.height = CANVAS_H;
  _canvas.addEventListener('click',     _handleClick);
  _canvas.addEventListener('mousemove', _handleHover);
}

export function renderWarehouse(inventoryData) {
  _slots = inventoryData;
  _draw();
}

export function redrawWarehouse() { _draw(); }

export function setRobotState(state) { _robotState = state; }
export function clearRobotState()    { _robotState = null; }

/** Called by robot.js whenever the obstacle set changes. */
export function setObstacles(set) { _obstacles = set; }

/** Toggle a faint tile-grid overlay — helpful while placing obstacles. */
export function setShowGrid(v) { _showGrid = v; }

// ── Main draw ─────────────────────────────────────────────────────────────────

function _draw() {
  _ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
  _drawBackground();
  _drawSideStrips();
  _drawKuehlbereich();
  _drawAisle();
  _drawAmbientSections();
  _drawDecoRooms();
  _drawZoneLabels();
  _drawGridOverlay();
  _slots.forEach(s => _drawSlot(s, s.id === _selectedId));
  _drawObstacles();
  _drawRobot();
}

function _drawBackground() {
  _ctx.fillStyle = '#0F1520';
  _ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
}

// ── Tile-grid overlay (obstacle-placement aid) ───────────────────────────────

function _drawGridOverlay() {
  if (!_showGrid) return;
  _ctx.save();
  _ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  _ctx.lineWidth   = 1;
  for (let x = 0; x <= CANVAS_W; x += TILE) {
    _ctx.beginPath(); _ctx.moveTo(x + 0.5, 0); _ctx.lineTo(x + 0.5, CANVAS_H); _ctx.stroke();
  }
  for (let y = 0; y <= CANVAS_H; y += TILE) {
    _ctx.beginPath(); _ctx.moveTo(0, y + 0.5); _ctx.lineTo(CANVAS_W, y + 0.5); _ctx.stroke();
  }
  _ctx.restore();
}

// ── Kühlbereich ───────────────────────────────────────────────────────────────

function _drawKuehlbereich() {
  _ctx.fillStyle = 'rgba(8, 14, 42, 0.65)';
  _ctx.fillRect(GRID_X, Y_D, AMB_W, SLOT_H);

  _ctx.fillStyle = 'rgba(14, 32, 76, 0.45)';
  _ctx.fillRect(GRID_X, Y_C, AMB_W, SLOT_H);

  _ctx.fillStyle = 'rgba(10, 22, 54, 0.75)';
  _ctx.fillRect(GRID_X, 0, AMB_W, PAD_T);
  _ctx.fillStyle    = '#2A5090';
  _ctx.font         = '600 9px "JetBrains Mono", monospace';
  _ctx.textAlign    = 'center';
  _ctx.textBaseline = 'middle';
  _ctx.fillText('KÜHLBEREICH', GRID_X + AMB_W / 2, PAD_T / 2);

  _drawGefrierwand();
}

/**
 * Gefrierwand with a door at column 3. Spans the interior room width only
 * (from the edge of the Warenannahme strip to the edge of the Versand
 * strip) — NOT the full canvas. The side strips already seal themselves
 * off at this height via their own door logic (see robot.js _isNavigable,
 * which only evaluates this wall once px is already confirmed to be inside
 * the interior), so extending the visual wall over them added nothing
 * functionally and only covered up the "Warenannahme" / "Versand" labels.
 */
function _drawGefrierwand() {
  const wy = WALL_TOP, wh = WALL_H;
  const wallL = LEFT_W, wallR = CANVAS_W - RIGHT_W;

  for (const [wx, ww] of [[wallL, DOOR_LEFT - wallL], [DOOR_RIGHT, wallR - DOOR_RIGHT]]) {
    if (ww <= 0) continue;

    _ctx.fillStyle = '#101622';
    _ctx.fillRect(wx, wy, ww, wh);

    _ctx.save();
    _ctx.beginPath(); _ctx.rect(wx, wy, ww, wh); _ctx.clip();
    _ctx.strokeStyle = 'rgba(70, 100, 180, 0.3)';
    _ctx.lineWidth   = 1;
    for (let i = wx - wh; i < wx + ww + wh; i += 7) {
      _ctx.beginPath();
      _ctx.moveTo(i, wy + wh);
      _ctx.lineTo(i + wh, wy);
      _ctx.stroke();
    }
    _ctx.restore();
  }

  _ctx.strokeStyle = '#2A4898'; _ctx.lineWidth = 1.5;
  _ctx.beginPath();
  _ctx.moveTo(wallL,      wy); _ctx.lineTo(DOOR_LEFT, wy);
  _ctx.moveTo(DOOR_RIGHT, wy); _ctx.lineTo(wallR,      wy);
  _ctx.stroke();
  _ctx.strokeStyle = '#1E3468'; _ctx.lineWidth = 1;
  _ctx.beginPath();
  _ctx.moveTo(wallL,      wy + wh); _ctx.lineTo(DOOR_LEFT, wy + wh);
  _ctx.moveTo(DOOR_RIGHT, wy + wh); _ctx.lineTo(wallR,      wy + wh);
  _ctx.stroke();

  _ctx.fillStyle    = 'rgba(90, 130, 210, 0.38)';
  _ctx.font         = '600 7px "JetBrains Mono", monospace';
  _ctx.textAlign    = 'center'; _ctx.textBaseline = 'middle';
  const leftLabelX = wallL + (DOOR_LEFT - wallL) / 2;
  _ctx.fillText('GEFRIERWAND  ·  ISOLIERUNG', leftLabelX, wy + wh / 2);

  _ctx.strokeStyle = 'rgba(90, 180, 255, 0.5)';
  _ctx.lineWidth   = 2;
  _ctx.beginPath();
  _ctx.moveTo(DOOR_LEFT,  wy - 3); _ctx.lineTo(DOOR_LEFT,  wy + wh + 3);
  _ctx.moveTo(DOOR_RIGHT, wy - 3); _ctx.lineTo(DOOR_RIGHT, wy + wh + 3);
  _ctx.stroke();

  _ctx.fillStyle    = 'rgba(90, 180, 255, 0.45)';
  _ctx.font         = '600 6px "JetBrains Mono", monospace';
  _ctx.textAlign    = 'center'; _ctx.textBaseline = 'bottom';
  _ctx.fillText('TÜR', (DOOR_LEFT + DOOR_RIGHT) / 2, wy - 1);
}

// ── Aisle ─────────────────────────────────────────────────────────────────────

function _drawAisle() {
  _ctx.fillStyle = '#111827';
  _ctx.fillRect(0, AISLE_Y, CANVAS_W, AISLE_H);

  _ctx.save();
  _ctx.strokeStyle = ROBOT_COLOR; _ctx.lineWidth = 1; _ctx.globalAlpha = 0.22;
  _ctx.setLineDash([8, 5]);
  _ctx.beginPath();
  _ctx.moveTo(LEFT_W, AISLE_CY); _ctx.lineTo(CANVAS_W - RIGHT_W, AISLE_CY);
  _ctx.stroke();
  _ctx.restore();

  _ctx.fillStyle    = 'rgba(245,158,11,0.2)';
  _ctx.font         = '600 8px "JetBrains Mono", monospace';
  _ctx.textAlign    = 'center'; _ctx.textBaseline = 'middle';
  _ctx.fillText('HAUPTGANG', CANVAS_W / 2, AISLE_CY);
}

// ── Ambient sections ──────────────────────────────────────────────────────────

function _drawAmbientSections() {
  const ambTop = AISLE_Y + AISLE_H, ambH = DECO_Y - ambTop, labelY = ambTop + 9;

  _ctx.fillStyle = 'rgba(75, 44, 8, 0.35)'; _ctx.fillRect(TROCK_X, ambTop, TROCK_W, ambH);
  _ctx.fillStyle = 'rgba(210, 140, 40, 0.5)'; _ctx.font = '600 8px "JetBrains Mono", monospace';
  _ctx.textAlign = 'center'; _ctx.textBaseline = 'middle';
  _ctx.fillText('TROCKENWARE', TROCK_X + TROCK_W / 2, labelY);

  _ctx.fillStyle = 'rgba(28, 72, 10, 0.38)'; _ctx.fillRect(FRISCH_X, ambTop, FRISCH_W, ambH);
  _ctx.fillStyle = 'rgba(90, 180, 40, 0.5)';
  _ctx.fillText('FRISCHE / OBST', FRISCH_X + FRISCH_W / 2, labelY);

  _ctx.save(); _ctx.strokeStyle = '#2A3240'; _ctx.lineWidth = 1; _ctx.setLineDash([3, 4]);
  _ctx.beginPath(); _ctx.moveTo(ZONE_DIVIDER_X, ambTop); _ctx.lineTo(ZONE_DIVIDER_X, DECO_Y); _ctx.stroke();
  _ctx.restore();
}

// ── Decorative rooms ──────────────────────────────────────────────────────────

function _drawDecoRooms() {
  _drawDecoRoom(GRID_X, DECO_Y, ZONE_DIVIDER_X - GRID_X, DECO_H, 'rgba(42,36,95,0.5)', 'rgba(110,100,210,0.3)', 'Büro / Sozialräume');
  _drawDecoRoom(ZONE_DIVIDER_X, DECO_Y, GRID_X + AMB_W - ZONE_DIVIDER_X, DECO_H, 'rgba(85,30,14,0.5)', 'rgba(210,95,60,0.3)', 'Leergut / Retouren');
}

function _drawDecoRoom(x, y, w, h, fill, stroke, label) {
  _ctx.fillStyle = fill; _ctx.fillRect(x, y, w, h);
  _ctx.strokeStyle = stroke; _ctx.lineWidth = 0.5; _ctx.strokeRect(x+.5, y+.5, w-1, h-1);
  _ctx.fillStyle = stroke; _ctx.font = '400 8px "JetBrains Mono", monospace';
  _ctx.textAlign = 'center'; _ctx.textBaseline = 'middle';
  _ctx.fillText(label, x + w / 2, y + h / 2);
}

// ── Side strips ───────────────────────────────────────────────────────────────

function _drawSideStrips() {
  _drawStrip(0,                  'Warenannahme', 'right');
  _drawStrip(CANVAS_W - RIGHT_W, 'Versand',      'left');
}

/**
 * @param {string|null} doorSide — 'right' if the door sits on this strip's
 *   right edge (facing into the interior, as for Warenannahme), 'left' if
 *   it sits on the left edge (facing into the interior, as for Versand),
 *   or null/undefined for no door.
 */
function _drawStrip(x, label, doorSide) {
  _ctx.fillStyle   = '#191E2B';
  _ctx.fillRect(x, 0, LEFT_W, CANVAS_H);
  _ctx.strokeStyle = '#252C3C'; _ctx.lineWidth = 1;
  _ctx.strokeRect(x, 0, LEFT_W, CANVAS_H);

  // Positioned in the open space above the Hauptgang (not vertically centered
  // on the whole strip) — the aisle band legitimately spans the full canvas
  // width to line up with the doors, so a centered label would sit right
  // underneath it and get covered.
  _drawVText(label, x + LEFT_W / 2, AISLE_Y / 2, '#3D4455', '9px "JetBrains Mono", monospace');

  _ctx.fillStyle   = '#252C3C';
  _ctx.fillRect(x + LEFT_W / 2 - 16, CANVAS_H - 16, 32, 8);
  _ctx.strokeStyle = '#3A4258'; _ctx.lineWidth = 0.5;
  _ctx.strokeRect(x + LEFT_W / 2 - 16, CANVAS_H - 16, 32, 8);

  if (!doorSide) return;

  // Door sits on whichever edge faces the storage interior
  const doorX  = doorSide === 'right' ? x + LEFT_W - 2 : x + 2;
  const doorY1 = AISLE_Y;
  const doorY2 = AISLE_Y + AISLE_H;

  _ctx.strokeStyle = 'rgba(90, 180, 255, 0.5)';
  _ctx.lineWidth   = 3;
  _ctx.beginPath();
  _ctx.moveTo(doorX, doorY1);
  _ctx.lineTo(doorX, doorY2);
  _ctx.stroke();

  _ctx.fillStyle    = 'rgba(90, 180, 255, 0.45)';
  _ctx.font         = '600 6px "JetBrains Mono", monospace';
  _ctx.textAlign    = doorSide === 'right' ? 'right' : 'left';
  _ctx.textBaseline = 'middle';
  const labelX = doorSide === 'right' ? doorX - 3 : doorX + 3;
  _ctx.fillText('TÜR', labelX, AISLE_CY);
}

// ── Zone labels ───────────────────────────────────────────────────────────────

function _drawZoneLabels() {
  const lx = LABEL_X;
  _drawVText('TIEFKÜHL', lx, Y_D + SLOT_H / 2,             '#2A5090', '700 8px "JetBrains Mono", monospace');
  _drawVText('KÜHLUNG',  lx, Y_C + SLOT_H / 2,             '#3A70A8', '700 8px "JetBrains Mono", monospace');
  _drawVText('TROCKEN',  lx, Y_A + (SLOT_H + GAP + SLOT_H) / 2, '#4A7A5A', '700 8px "JetBrains Mono", monospace');
}

// ── Obstacle rendering ────────────────────────────────────────────────────────
// Obstacles render as a simple cardboard-box icon (packing-tape cross),
// filling almost the entire tile — "a stray box in the aisle."

function _drawObstacles() {
  if (!_obstacles.size) return;
  const inset = 4;
  const size  = TILE - inset * 2;

  for (const key of _obstacles) {
    const [gx, gy] = key.split(',').map(Number);
    const x = gx * TILE + inset;
    const y = gy * TILE + inset;

    _ctx.fillStyle = '#8B6239';
    _rrect(x, y, size, size, 2);
    _ctx.fill();
    _ctx.strokeStyle = '#5C4023';
    _ctx.lineWidth   = 1.5;
    _ctx.stroke();

    // Packing-tape cross
    _ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    _ctx.lineWidth   = 1.5;
    _ctx.beginPath();
    _ctx.moveTo(x + 2,        y + 2);
    _ctx.lineTo(x + size - 2, y + size - 2);
    _ctx.moveTo(x + size - 2, y + 2);
    _ctx.lineTo(x + 2,        y + size - 2);
    _ctx.stroke();
  }
}

// ── Slot drawing ──────────────────────────────────────────────────────────────

function _drawSlot(slot, isSelected) {
  const { x, y } = slotPos(slot);
  const zone     = ZONE[slot.storage_type] ?? ZONE.ambient;
  const occ      = slot.quantity !== null && slot.quantity > 0;

  _ctx.beginPath(); _rrect(x, y, SLOT_W, SLOT_H, 4);
  _ctx.fillStyle = occ ? zone.occupied : zone.empty; _ctx.fill();

  if (isSelected) { _ctx.strokeStyle = ROBOT_COLOR; _ctx.lineWidth = 2; _ctx.stroke(); }

  _ctx.fillStyle = occ ? zone.text : zone.label;
  _ctx.font = '700 9px "JetBrains Mono", monospace';
  _ctx.textAlign = 'left'; _ctx.textBaseline = 'top';
  _ctx.fillText(slot.label, x + 5, y + 4);

  if (occ) {
    _ctx.fillStyle = '#E2E8F0'; _ctx.font = '500 9px Inter, sans-serif';
    _ctx.textAlign = 'center'; _ctx.textBaseline = 'middle';
    _ctx.fillText(_trunc(slot.product_name ?? '', 12), x + SLOT_W / 2, y + SLOT_H / 2 + 2);

    const bw = 22, bh = 12, bx = x + SLOT_W - bw - 3, by = y + SLOT_H - bh - 3;
    _ctx.fillStyle = 'rgba(0,0,0,0.5)'; _ctx.beginPath(); _rrect(bx, by, bw, bh, 2); _ctx.fill();
    _ctx.fillStyle = '#CBD5E1'; _ctx.font = '700 8px "JetBrains Mono", monospace';
    _ctx.textAlign = 'center'; _ctx.textBaseline = 'middle';
    _ctx.fillText('×' + slot.quantity, bx + bw / 2, by + bh / 2);
  } else {
    _ctx.fillStyle = zone.label; _ctx.font = '400 8px Inter, sans-serif';
    _ctx.textAlign = 'center'; _ctx.textBaseline = 'middle';
    _ctx.fillText('leer', x + SLOT_W / 2, y + SLOT_H / 2 + 3);
  }
}

// ── Robot drawing ─────────────────────────────────────────────────────────────

function _drawRobot() {
  if (!_robotState) return;
  const { x, y, working, t = 0 } = _robotState;
  const BW = 14, BH = 11, HW = 10, HH = 7, WR = 3;

  _ctx.save(); _ctx.globalAlpha = 0.2; _ctx.fillStyle = '#000';
  _ctx.beginPath(); _ctx.ellipse(x, y + BH/2 + WR + 1, BW/2 + 2, 2.5, 0, 0, Math.PI*2); _ctx.fill();
  _ctx.restore();

  _ctx.fillStyle = '#1A1F2E';
  _ctx.beginPath(); _ctx.arc(x - BW/2 + WR, y + BH/2, WR, 0, Math.PI*2); _ctx.fill();
  _ctx.beginPath(); _ctx.arc(x + BW/2 - WR, y + BH/2, WR, 0, Math.PI*2); _ctx.fill();

  _ctx.fillStyle = ROBOT_COLOR;
  _rrect(x - BW/2, y - BH/2, BW, BH, 3); _ctx.fill();

  _ctx.fillStyle = 'rgba(255,255,255,0.12)';
  _rrect(x - BW/2 + 2, y - BH/2 + 2, BW - 4, 4, 2); _ctx.fill();

  _ctx.fillStyle = '#D4870A';
  _rrect(x - HW/2, y - BH/2 - HH, HW, HH, 2); _ctx.fill();

  const pulse = Math.sin(t * 8);
  _ctx.fillStyle = working ? (pulse > 0 ? '#FF5050' : '#FF9900') : '#44CC88';
  _ctx.beginPath(); _ctx.arc(x, y - BH/2 - HH/2, 2, 0, Math.PI*2); _ctx.fill();

  if (working) {
    _ctx.save(); _ctx.globalAlpha = 0.22 + 0.14 * pulse; _ctx.fillStyle = '#FF5050';
    _ctx.beginPath(); _ctx.arc(x, y - BH/2 - HH/2, 5, 0, Math.PI*2); _ctx.fill();
    _ctx.restore();
  }

  _ctx.fillStyle = working ? '#FF8800' : '#44CC88';
  _ctx.beginPath(); _ctx.arc(x + BW/2 - 2, y + BH/2 - 2, 1.5, 0, Math.PI*2); _ctx.fill();
}

// ── Slot position ─────────────────────────────────────────────────────────────

export function slotPos(slot) {
  const col = slot.col_num;
  const x   = GRID_X + (col - 1) * COLD_COL_STEP;
  let   y;
  switch (slot.storage_type) {
    case 'frozen':  y = Y_D; break;
    case 'chilled': y = Y_C; break;
    default:        y = Y_A + (slot.row_num - 1) * (SLOT_H + GAP);
  }
  return { x, y };
}

// ── Interaction ───────────────────────────────────────────────────────────────

function _handleClick(e) {
  const slot = _hitTest(e);
  if (!slot) return;
  _selectedId = slot.id;
  _draw();
  if (_onSlotClick) _onSlotClick(slot);
}

function _handleHover(e) {
  _canvas.style.cursor = _hitTest(e) ? 'pointer' : 'default';
}

function _hitTest(e) {
  const r  = _canvas.getBoundingClientRect();
  const sx = _canvas.width / r.width, sy = _canvas.height / r.height;
  const mx = (e.clientX - r.left) * sx, my = (e.clientY - r.top) * sy;
  for (const slot of _slots) {
    const { x, y } = slotPos(slot);
    if (mx >= x && mx <= x + SLOT_W && my >= y && my <= y + SLOT_H) return slot;
  }
  return null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _drawVText(text, x, y, color, font) {
  _ctx.save(); _ctx.translate(x, y); _ctx.rotate(-Math.PI / 2);
  _ctx.fillStyle = color; _ctx.font = font;
  _ctx.textAlign = 'center'; _ctx.textBaseline = 'middle';
  _ctx.fillText(text, 0, 0); _ctx.restore();
}

function _rrect(x, y, w, h, r) {
  _ctx.beginPath();
  _ctx.moveTo(x+r, y); _ctx.lineTo(x+w-r, y);
  _ctx.quadraticCurveTo(x+w, y, x+w, y+r);
  _ctx.lineTo(x+w, y+h-r);
  _ctx.quadraticCurveTo(x+w, y+h, x+w-r, y+h);
  _ctx.lineTo(x+r, y+h);
  _ctx.quadraticCurveTo(x, y+h, x, y+h-r);
  _ctx.lineTo(x, y+r);
  _ctx.quadraticCurveTo(x, y, x+r, y);
  _ctx.closePath();
}

function _trunc(str, max) {
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}
