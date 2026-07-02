/**
 * robot.js — v5
 *
 * Updated for the v9 tile-based warehouse geometry: CELL_SIZE is now equal
 * to the visual TILE size (24px), so one navigability-grid cell IS one
 * visible floor tile. Grid-based A* pathfinding.
 *
 * How it works
 * ────────────
 * The warehouse canvas is divided into a grid where each cell is
 * CELL_SIZE × CELL_SIZE pixels (= one tile). "Large paths" (the Hauptgang,
 * the vertical transit lane) are 2 tiles wide, so the robot can dodge
 * sideways around a single blocked tile. "Around-shelf" access lanes are
 * exactly 1 tile wide — tight, single-file by design.
 *
 * Navigability rules (_isNavigable):
 *   • Slot rectangles          → blocked
 *   • Right wall (Versand)     → blocked entirely
 *   • Left wall (Warenannahme) → blocked EXCEPT at Hauptgang height
 *                                 (the one door into the robot's home base)
 *   • Label zone (left padding)→ blocked EXCEPT at Hauptgang height
 *                                 (keeps the robot off the zone-name text)
 *   • Gefrierwand               → blocked EXCEPT under column 3
 *                                 (the freezer door)
 *   • Deco rooms at the bottom → blocked
 *   • Everything else          → navigable
 *
 * A* uses Manhattan-distance heuristic with a min-heap open set.
 *
 * Multi-stop route order
 * ───────────────────────
 * For animateMultiRetrieve/animateMultiStore/planMultiRetrieveRoute, the
 * order stops are VISITED is chosen for shortest total travel distance —
 * NOT the order the caller passed them in. This is safe because all DB
 * writes for a multi-stop trip are already committed before the animation
 * starts, so visiting order has zero effect on correctness; it's purely
 * about the robot's walk looking sensible. Exhaustive permutation search is
 * used for realistic stop counts (≤7); a nearest-neighbor greedy fallback
 * kicks in beyond that to stay fast.
 *
 * Obstacle API
 * ────────────
 *   toggleObstacle(gx, gy)   — flip a navigable tile's blocked state
 *   clearObstacles()          — remove all obstacles
 *   getObstacles()            — returns the current obstacle Set
 *   pixelToGrid(px, py)       — convert canvas pixel → grid cell
 *   getGridW() / getGridH()   — grid dimensions
 *
 * Animation
 * ─────────
 * Path grid cells are compressed into direction-change waypoints and
 * animated at SPEED_H / SPEED_V px/s with a cubic ease-in-out.
 *
 * Public API:
 *   initRobot(inventory)
 *   canReachSlot(slot)       — query reachability WITHOUT animating; use this
 *                               to validate a move before writing to the DB
 *   animateRobot(slot, action, inventory, onComplete) — onComplete(success)
 *   planMultiRetrieveRoute(slots) — validate/order a multi-stop pick list
 *                               WITHOUT animating; returns { reachable, unreachable }
 *   animateMultiRetrieve(slots, inventory, { onStop, onComplete })
 *                               — ONE trip visiting every slot in order, then
 *                                 the Versand exit, then home — used for
 *                                 picking a whole order instead of item-by-item
 *   animateMultiStore(slots, inventory, { onStop, onComplete })
 *                               — ONE trip visiting every slot in order, then
 *                                 straight home — used when a single delivery
 *                                 has to be split across slots by capacity
 *   isRobotBusy()
 *   addObstacle / removeObstacle / toggleObstacle / clearObstacles
 *   getObstacles / pixelToGrid / getGridW / getGridH
 *   getGraph()   — returns { grid, obstacles } for debugging
 */

import {
  SLOT_W, SLOT_H, CELL_SIZE, CANVAS_W, CANVAS_H,
  Y_D, Y_C, Y_A, Y_B,
  AISLE_Y, AISLE_H, AISLE_CY,
  WALL_TOP, WALL_BOT,
  DECO_Y, PAD_T,
  LEFT_W, RIGHT_W, LABEL_ZONE_W,
  DOOR_LEFT, DOOR_RIGHT,
  HOME_X, EXIT_X,
  getColumnCenterX, slotPos,
  setObstacles as _warehouseSetObstacles,
  setRobotState, clearRobotState,
  redrawWarehouse, renderWarehouse,
} from './warehouse.js';

// ── Grid dimensions ───────────────────────────────────────────────────────────

const GRID_W = Math.ceil(CANVAS_W / CELL_SIZE);   // 34 tiles
const GRID_H = Math.ceil(CANVAS_H / CELL_SIZE);   // 21 tiles

// ── Animation constants ───────────────────────────────────────────────────────

const SPEED_H   = 240;   // px / s — horizontal
const SPEED_V   = 180;   // px / s — vertical
const WORK_TIME = 0.75;  // s — dwell at slot

// ── Module state ──────────────────────────────────────────────────────────────

let _grid       = null;        // boolean[GRID_H][GRID_W]  — true = navigable
let _obstacles  = new Set();  // "gx,gy" strings
let _frame      = null;
let _busy       = false;
let _inventory  = [];

// ── Public API ────────────────────────────────────────────────────────────────

export function initRobot(inventory) {
  _inventory = inventory;
  _grid      = _buildGrid();

  const hgx = Math.floor(HOME_X / CELL_SIZE);
  const hgy = Math.floor(AISLE_CY / CELL_SIZE);
  setRobotState({ x: HOME_X, y: AISLE_CY, working: false, t: 0 });
  redrawWarehouse();
}

/**
 * Find the shortest path from home to any valid dock for a slot, trying
 * all 8 approach candidates. Returns the cell path, or null if every
 * candidate is unreachable (blocked by walls and/or obstacles).
 * Pure lookup — does not touch _busy or start any animation.
 */
function _findPathToSlot(slot) {
  const homeGX = Math.floor(HOME_X   / CELL_SIZE);
  const homeGY = Math.floor(AISLE_CY / CELL_SIZE);

  const candidates = _dockCandidates(slot);
  let best = null;
  for (const cand of candidates) {
    if (_obstacles.has(`${cand.gx},${cand.gy}`)) continue;
    const path = _aStar(homeGX, homeGY, cand.gx, cand.gy);
    if (path && (!best || path.length < best.length)) best = path;
  }
  return best;
}

/**
 * Check whether the robot can currently reach a slot at all — without
 * starting any animation or touching busy state. Callers should use this
 * to validate a move BEFORE writing to the database, so a blocked path
 * never results in an inventory change with no matching robot movement.
 */
export function canReachSlot(slot) {
  if (!_grid) return false;
  return _findPathToSlot(slot) !== null;
}

/**
 * Animate the robot to a slot and back.
 * onComplete is ALWAYS called — with `true` if the robot actually made
 * the trip, or `false` if it couldn't (no path, or already busy). Callers
 * must check this argument rather than assuming any call means success.
 */
export function animateRobot(slot, action, inventory, onComplete) {
  if (_busy || !_grid) {
    if (onComplete) onComplete(false);
    return;
  }
  _busy      = true;
  _inventory = inventory;

  const cells = _findPathToSlot(slot);

  if (!cells) {
    console.warn('[robot] Kein Weg zu', slot.label, '— Hindernisse:', [..._obstacles]);
    _busy = false;
    if (onComplete) onComplete(false);
    return;
  }

  // Build the full trip as an array of waypoints, tracking which indices
  // get a WORK_TIME pause (grabbing the item, and — for retrieve — dropping
  // it off at the Versand exit before heading home).
  const wpsOut = _cellsToWaypoints(cells);   // home -> dock
  const dock   = cells[cells.length - 1];

  const { x: slotCX, y: slotCY } = _slotCenter(slot);
  const reachIn = { px: slotCX, py: slotCY };

  const fullWps     = [...wpsOut];
  const peakIndices = [];

  fullWps.push(reachIn);
  peakIndices.push(fullWps.length - 1);       // pause 1: grab / place item
  fullWps.push(wpsOut[wpsOut.length - 1]);    // retract to dock

  if (action === 'retrieve') {
    // Detour via the Versand exit to drop the item off, THEN go home.
    // Both legs are fresh A* searches — not a mirror of the outbound trip,
    // since the exit is on the opposite side of the building from the slot.
    const exitGX = Math.floor(EXIT_X  / CELL_SIZE);
    const exitGY = Math.floor(AISLE_CY / CELL_SIZE);
    const homeGX = Math.floor(HOME_X  / CELL_SIZE);
    const homeGY = Math.floor(AISLE_CY / CELL_SIZE);

    const pathToExit = _aStar(dock.gx, dock.gy, exitGX, exitGY);
    const pathToHome = pathToExit ? _aStar(exitGX, exitGY, homeGX, homeGY) : null;

    if (pathToExit && pathToHome) {
      const wpsToExit = _cellsToWaypoints(pathToExit);
      const wpsToHome = _cellsToWaypoints(pathToHome);

      fullWps.push(...wpsToExit.slice(1));    // dock -> Versand exit
      peakIndices.push(fullWps.length - 1);   // pause 2: drop off at exit
      fullWps.push(...wpsToHome.slice(1));    // exit -> home
    } else {
      // Extremely unlikely (the Hauptgang+Versand door are always open
      // baseline geometry, never blockable by the user) — but if it
      // somehow happens, fall back to a direct return rather than getting stuck.
      console.warn('[robot] Kein Weg zur Versandausgabe — kehre direkt zurück.');
      const wpsBack = [...wpsOut].reverse();
      fullWps.push(...wpsBack.slice(1));
    }
  } else {
    // store — simple round trip, no exit detour
    const wpsBack = [...wpsOut].reverse();
    fullWps.push(...wpsBack.slice(1));
  }

  const timed = _buildTimedPath(fullWps, peakIndices);
  const startMs = performance.now();

  function tick(ms) {
    const elapsed = (ms - startMs) / 1000;

    let seg = timed.length - 2;
    for (let i = 0; i < timed.length - 1; i++) {
      if (elapsed < timed[i + 1].t) { seg = i; break; }
    }

    const from = timed[seg];
    const to   = timed[Math.min(seg + 1, timed.length - 1)];
    const dur  = to.t - from.t;
    const raw  = dur > 0 ? (elapsed - from.t) / dur : 1;
    const te   = _ease(Math.min(Math.max(raw, 0), 1));

    setRobotState({
      x:       _lerp(from.px, to.px, te),
      y:       _lerp(from.py, to.py, te),
      working: to.working ?? false,
      t:       ms / 1000,
    });
    redrawWarehouse();

    if (elapsed < timed[timed.length - 1].t) {
      _frame = requestAnimationFrame(tick);
    } else {
      setRobotState({ x: HOME_X, y: AISLE_CY, working: false, t: 0 });
      renderWarehouse(_inventory);
      _busy = false;
      if (onComplete) onComplete(true);
    }
  }

  if (_frame) cancelAnimationFrame(_frame);
  _frame = requestAnimationFrame(tick);
}

export function isRobotBusy() { return _busy; }

/**
 * Plans a one-trip multi-stop route (home → slot → slot → … ) WITHOUT
 * animating or touching busy state — each leg starts where the previous
 * one ends, not back at home. Use this to validate + order a picking list
 * before writing to the DB, exactly like canReachSlot does for a single
 * slot: a stop nothing can path to is reported in `unreachable` rather
 * than silently dropped.
 *
 * @param {object[]} slots — slots to visit, in preferred order
 * @returns {{ reachable: object[], unreachable: object[] }}
 */
export function planMultiRetrieveRoute(slots) {
  if (!_grid || !slots.length) return { reachable: [], unreachable: [...slots] };

  const homeGX = Math.floor(HOME_X   / CELL_SIZE);
  const homeGY = Math.floor(AISLE_CY / CELL_SIZE);

  const ordered = _optimizeVisitOrder(homeGX, homeGY, slots, true);
  const { legs, unreachable } = _planRouteLegs(homeGX, homeGY, ordered);
  return { reachable: legs.map(l => l.slot), unreachable };
}

/**
 * Animate ONE continuous trip that visits every slot in `slots` — reordered
 * for the shortest total travel distance, not necessarily the order given —
 * chaining leg to leg instead of returning home between stops, then heads
 * to the Versand exit to drop everything off, then returns home. Used for
 * "pick a whole order" instead of one round trip per item.
 *
 * @param {object[]} slots
 * @param {object[]} inventory
 * @param {object} [handlers]
 * @param {(slot: object) => void} [handlers.onStop] — fired the moment the
 *   robot finishes grabbing at each slot, in (optimized) visit order — lets
 *   callers flip that item to "done" in a UI as the robot actually reaches it.
 * @param {(success: boolean, visited: object[], unreachable: object[]) => void} [handlers.onComplete]
 *   `visited` lists the slots actually reached (in visit order); `unreachable`
 *   lists any that had to be skipped because no path existed at trip-start.
 */
export function animateMultiRetrieve(slots, inventory, { onStop, onComplete } = {}) {
  if (_busy || !_grid || !slots.length) {
    if (onComplete) onComplete(false, [], slots ?? []);
    return;
  }
  _busy      = true;
  _inventory = inventory;

  const homeGX = Math.floor(HOME_X   / CELL_SIZE);
  const homeGY = Math.floor(AISLE_CY / CELL_SIZE);
  const exitGX = Math.floor(EXIT_X   / CELL_SIZE);
  const exitGY = Math.floor(AISLE_CY / CELL_SIZE);

  const orderedSlots = _optimizeVisitOrder(homeGX, homeGY, slots, true);
  const { legs, unreachable, endGX, endGY } = _planRouteLegs(homeGX, homeGY, orderedSlots);

  if (!legs.length) {
    _busy = false;
    if (onComplete) onComplete(false, [], unreachable);
    return;
  }

  const toExit = _aStar(endGX, endGY, exitGX, exitGY);
  const toHome = toExit ? _aStar(exitGX, exitGY, homeGX, homeGY) : null;

  // Chain every leg's waypoints together: dock at slot 1, grab, continue
  // straight to slot 2's dock (no detour home in between), and so on.
  const fullWps     = [];
  const peakIndices = [];
  let first = true;

  for (const leg of legs) {
    const wps = _cellsToWaypoints(leg.cells);
    fullWps.push(...(first ? wps : wps.slice(1)));
    first = false;

    const { x: cx, y: cy } = _slotCenter(leg.slot);
    fullWps.push({ px: cx, py: cy });
    peakIndices.push(fullWps.length - 1);      // pause: grab item
    fullWps.push(wps[wps.length - 1]);         // retract to dock
  }

  if (toExit && toHome) {
    fullWps.push(..._cellsToWaypoints(toExit).slice(1));   // last dock -> Versand
    peakIndices.push(fullWps.length - 1);                  // pause: drop off
    fullWps.push(..._cellsToWaypoints(toHome).slice(1));   // Versand -> home
  } else {
    // Extremely unlikely (see animateRobot) — fall back to a direct return.
    console.warn('[robot] Kein Weg zur Versandausgabe nach Mehrfachkommissionierung.');
    const homePath = _aStar(endGX, endGY, homeGX, homeGY);
    if (homePath) fullWps.push(..._cellsToWaypoints(homePath).slice(1));
  }

  const peakTimes = [];
  const timed     = _buildTimedPath(fullWps, peakIndices, peakTimes);
  const startMs   = performance.now();

  // Fire onStop the moment each item's grab-dwell finishes, independent of
  // the render tick — so UI updates land exactly when the robot leaves that shelf.
  if (onStop) {
    legs.forEach((leg, i) => {
      const tSec = peakTimes[i];
      if (tSec != null) window.setTimeout(() => onStop(leg.slot), tSec * 1000);
    });
  }

  function tick(ms) {
    const elapsed = (ms - startMs) / 1000;

    let seg = timed.length - 2;
    for (let i = 0; i < timed.length - 1; i++) {
      if (elapsed < timed[i + 1].t) { seg = i; break; }
    }

    const from = timed[seg];
    const to   = timed[Math.min(seg + 1, timed.length - 1)];
    const dur  = to.t - from.t;
    const raw  = dur > 0 ? (elapsed - from.t) / dur : 1;
    const te   = _ease(Math.min(Math.max(raw, 0), 1));

    setRobotState({
      x:       _lerp(from.px, to.px, te),
      y:       _lerp(from.py, to.py, te),
      working: to.working ?? false,
      t:       ms / 1000,
    });
    redrawWarehouse();

    if (elapsed < timed[timed.length - 1].t) {
      _frame = requestAnimationFrame(tick);
    } else {
      setRobotState({ x: HOME_X, y: AISLE_CY, working: false, t: 0 });
      renderWarehouse(_inventory);
      _busy = false;
      if (onComplete) onComplete(true, legs.map(l => l.slot), unreachable);
    }
  }

  if (_frame) cancelAnimationFrame(_frame);
  _frame = requestAnimationFrame(tick);
}

/**
 * Animate ONE continuous "store" trip that visits every slot in `slots` in
 * order (chaining leg to leg, not returning home between stops) to drop
 * off part of a delivery at each, then heads home once — used when a
 * single delivery has to be split across multiple slots because of a
 * per-slot capacity limit. Structurally the mirror of animateMultiRetrieve,
 * just without the Versand-exit detour (a delivery starts and ends at
 * home; there's nothing to drop off at the exit).
 *
 * @param {object[]} slots
 * @param {object[]} inventory
 * @param {object} [handlers]
 * @param {(slot: object) => void} [handlers.onStop] — fired the moment the
 *   robot finishes placing goods at each slot, in visit order.
 * @param {(success: boolean, visited: object[], unreachable: object[]) => void} [handlers.onComplete]
 */
export function animateMultiStore(slots, inventory, { onStop, onComplete } = {}) {
  if (_busy || !_grid || !slots.length) {
    if (onComplete) onComplete(false, [], slots ?? []);
    return;
  }
  _busy      = true;
  _inventory = inventory;

  const homeGX = Math.floor(HOME_X   / CELL_SIZE);
  const homeGY = Math.floor(AISLE_CY / CELL_SIZE);

  const orderedSlots = _optimizeVisitOrder(homeGX, homeGY, slots, false);
  const { legs, unreachable, endGX, endGY } = _planRouteLegs(homeGX, homeGY, orderedSlots);

  if (!legs.length) {
    _busy = false;
    if (onComplete) onComplete(false, [], unreachable);
    return;
  }

  // Chain every leg's waypoints together: dock at slot 1, place goods,
  // continue straight to slot 2's dock (no detour home in between), and so on.
  const fullWps     = [];
  const peakIndices = [];
  let first = true;

  for (const leg of legs) {
    const wps = _cellsToWaypoints(leg.cells);
    fullWps.push(...(first ? wps : wps.slice(1)));
    first = false;

    const { x: cx, y: cy } = _slotCenter(leg.slot);
    fullWps.push({ px: cx, py: cy });
    peakIndices.push(fullWps.length - 1);      // pause: place goods
    fullWps.push(wps[wps.length - 1]);         // retract to dock
  }

  // No exit detour for a store trip — head straight home from the last dock.
  const homePath = _aStar(endGX, endGY, homeGX, homeGY);
  if (homePath) {
    fullWps.push(..._cellsToWaypoints(homePath).slice(1));
  } else {
    // Extremely unlikely (the transit lane home is baseline geometry and
    // never blockable) — but fall back to reversing the last leg rather
    // than leaving the robot stranded.
    console.warn('[robot] Kein Weg zurück zur Basis nach Mehrfacheinlagerung.');
    const wpsBack = [..._cellsToWaypoints(legs[legs.length - 1].cells)].reverse();
    fullWps.push(...wpsBack.slice(1));
  }

  const peakTimes = [];
  const timed     = _buildTimedPath(fullWps, peakIndices, peakTimes);
  const startMs   = performance.now();

  if (onStop) {
    legs.forEach((leg, i) => {
      const tSec = peakTimes[i];
      if (tSec != null) window.setTimeout(() => onStop(leg.slot), tSec * 1000);
    });
  }

  function tick(ms) {
    const elapsed = (ms - startMs) / 1000;

    let seg = timed.length - 2;
    for (let i = 0; i < timed.length - 1; i++) {
      if (elapsed < timed[i + 1].t) { seg = i; break; }
    }

    const from = timed[seg];
    const to   = timed[Math.min(seg + 1, timed.length - 1)];
    const dur  = to.t - from.t;
    const raw  = dur > 0 ? (elapsed - from.t) / dur : 1;
    const te   = _ease(Math.min(Math.max(raw, 0), 1));

    setRobotState({
      x:       _lerp(from.px, to.px, te),
      y:       _lerp(from.py, to.py, te),
      working: to.working ?? false,
      t:       ms / 1000,
    });
    redrawWarehouse();

    if (elapsed < timed[timed.length - 1].t) {
      _frame = requestAnimationFrame(tick);
    } else {
      setRobotState({ x: HOME_X, y: AISLE_CY, working: false, t: 0 });
      renderWarehouse(_inventory);
      _busy = false;
      if (onComplete) onComplete(true, legs.map(l => l.slot), unreachable);
    }
  }

  if (_frame) cancelAnimationFrame(_frame);
  _frame = requestAnimationFrame(tick);
}

/**
 * Toggle an obstacle cell.  Only navigable cells can receive obstacles;
 * calls are silently ignored for wall / slot cells.
 */
export function toggleObstacle(gx, gy) {
  const key = `${gx},${gy}`;
  if (_obstacles.has(key)) {
    _obstacles.delete(key);
  } else if (_grid?.[gy]?.[gx]) {
    _obstacles.add(key);
  }
  _syncObstacles();
}

export function addObstacle(gx, gy) {
  const key = `${gx},${gy}`;
  if (_grid?.[gy]?.[gx]) { _obstacles.add(key); _syncObstacles(); }
}

export function removeObstacle(gx, gy) {
  _obstacles.delete(`${gx},${gy}`);
  _syncObstacles();
}

export function clearObstacles() {
  _obstacles.clear();
  _syncObstacles();
}

export function getObstacles()         { return _obstacles; }
export function pixelToGrid(px, py)   { return { gx: Math.floor(px / CELL_SIZE), gy: Math.floor(py / CELL_SIZE) }; }
export function getGridW()             { return GRID_W; }
export function getGridH()             { return GRID_H; }
export function getGraph()             { return { grid: _grid, obstacles: _obstacles }; }

// ── Grid building ─────────────────────────────────────────────────────────────

function _buildGrid() {
  // Precompute slot rectangles (never change — all 20 fixed slots)
  const slotRects = [];
  for (let col = 1; col <= 5; col++) {
    const sx = getColumnCenterX(col) - SLOT_W / 2;
    slotRects.push({ x: sx, y: Y_D, w: SLOT_W, h: SLOT_H }); // frozen
    slotRects.push({ x: sx, y: Y_C, w: SLOT_W, h: SLOT_H }); // chilled
    slotRects.push({ x: sx, y: Y_A, w: SLOT_W, h: SLOT_H }); // ambient A
    slotRects.push({ x: sx, y: Y_B, w: SLOT_W, h: SLOT_H }); // ambient B
  }

  return Array.from({ length: GRID_H }, (_, gy) =>
    Array.from({ length: GRID_W }, (_, gx) =>
      _isNavigable(gx, gy, slotRects)
    )
  );
}

function _isNavigable(gx, gy, slotRects) {
  const px = gx * CELL_SIZE + CELL_SIZE / 2;
  const py = gy * CELL_SIZE + CELL_SIZE / 2;

  if (px < 0 || px >= CANVAS_W || py < 0 || py >= CANVAS_H) return false;

  // Right wall (Versand) — only open at Hauptgang height (exit door,
  // mirrors Warenannahme). This is where retrieved goods get dropped off.
  if (px >= CANVAS_W - RIGHT_W) {
    return py >= AISLE_Y && py <= AISLE_Y + AISLE_H;
  }

  // Left wall (Warenannahme) — only open at Hauptgang height (robot door)
  if (px < LEFT_W) {
    return py >= AISLE_Y && py <= AISLE_Y + AISLE_H;
  }

  // Above storage area
  if (py < PAD_T) return false;

  // Deco / service rooms at the bottom
  if (py >= DECO_Y) return false;

  // Label zone — a narrow strip beside the Warenannahme wall reserved for the
  // vertical TIEFKÜHL / KÜHLUNG / TROCKEN text. Permanently non-navigable so
  // the robot can never be drawn overlapping the labels. The Hauptgang band
  // is excluded since no label text appears there and the robot needs that
  // full-width strip to enter from the door.
  if (px < LEFT_W + LABEL_ZONE_W && !(py >= AISLE_Y && py < AISLE_Y + AISLE_H)) {
    return false;
  }

  // Slot faces (fixed, precomputed)
  for (const r of slotRects) {
    if (px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h) return false;
  }

  // Gefrierwand — blocked between WALL_TOP and WALL_BOT except the door.
  // By this point px is already guaranteed to be in [LEFT_W, CANVAS_W-RIGHT_W),
  // so this check covers the ENTIRE interior width including the transit lane —
  // there is no way around the wall except through the door.
  if (py >= WALL_TOP && py < WALL_BOT) {
    if (px >= DOOR_LEFT && px <= DOOR_RIGHT) return true;
    return false;
  }

  return true;
}

// ── Dock position ─────────────────────────────────────────────────────────────

/**
 * Returns every valid dock cell for a slot: the 4 grid columns spanning
 * its width, in the 1-tile gap directly ABOVE the slot, plus the same 4
 * columns in the 1-tile gap directly BELOW it — up to 8 candidates total.
 *
 * Every shelf row in this layout now has a navigable gap on both sides
 * (frozen: header-gap above, wall-gap below; chilled: wall-gap above,
 * aisle-gap below; ambient A: aisle-gap above, row-gap below; ambient B:
 * row-gap above, deco-gap below), so the robot can approach — and grab —
 * from whichever side is closer or unobstructed.
 */
function _dockCandidates(slot) {
  const { x: sx, y: sy } = slotPos(slot);
  const aboveY = sy - CELL_SIZE / 2;            // centre of the gap above
  const belowY = sy + SLOT_H + CELL_SIZE / 2;  // centre of the gap below

  const gxStart    = Math.round(sx / CELL_SIZE);
  const tilesAcross = SLOT_W / CELL_SIZE;        // 4

  const candidates = [];
  for (const py of [aboveY, belowY]) {
    const gy = Math.floor(py / CELL_SIZE);
    for (let i = 0; i < tilesAcross; i++) {
      const gx = gxStart + i;
      if (_grid[gy]?.[gx]) candidates.push({ gx, gy });
    }
  }
  return candidates;
}

function _slotCenter(slot) {
  const { x, y } = slotPos(slot);
  return { x: x + SLOT_W / 2, y: y + SLOT_H / 2 };
}

/**
 * Plans a chain of docking legs starting at (startGX, startGY): for each
 * slot in order, find the shortest path from wherever the previous leg
 * ended (not always home — this is what lets a multi-stop trip go straight
 * from one shelf to the next). Slots with no reachable dock from the
 * current position are skipped and reported separately, so one blocked
 * shelf doesn't derail the rest of the route.
 *
 * @returns {{ legs: {cells, slot}[], unreachable: object[], endGX: number, endGY: number }}
 */
function _planRouteLegs(startGX, startGY, slots) {
  let curGX = startGX, curGY = startGY;
  const legs = [];
  const unreachable = [];

  for (const slot of slots) {
    const candidates = _dockCandidates(slot);
    let best = null;
    for (const cand of candidates) {
      if (_obstacles.has(`${cand.gx},${cand.gy}`)) continue;
      const path = _aStar(curGX, curGY, cand.gx, cand.gy);
      if (path && (!best || path.length < best.length)) best = path;
    }

    if (!best) {
      unreachable.push(slot);
      continue;   // stay put, try the next slot from the same spot
    }

    legs.push({ cells: best, slot });
    curGX = best[best.length - 1].gx;
    curGY = best[best.length - 1].gy;
  }

  return { legs, unreachable, endGX: curGX, endGY: curGY };
}

/** Lazily yields every permutation of an array (used only for small N). */
function* _permutations(arr) {
  if (arr.length <= 1) { yield arr; return; }
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const perm of _permutations(rest)) yield [arr[i], ...perm];
  }
}

// Beyond this many stops, exhaustive permutation search (N!) gets too slow
// for a UI action — fall back to a nearest-neighbor greedy order instead.
// Real orders/deliveries in this app top out well below this (a demo order
// caps at 5 items; a capacity split rarely needs more than 2-3 slots).
const MAX_EXHAUSTIVE_STOPS = 7;

/**
 * Reorders `slots` to (approximately, for large N) minimise total travel
 * distance for a multi-stop trip starting at (startGX, startGY) — and, for
 * retrieve trips, ending near the Versand exit before heading home. The
 * backend already committed every allocation atomically before any
 * animation starts, so visiting order has zero effect on correctness —
 * purely a matter of making the robot's walk look sensible instead of
 * bouncing around in delivery-plan order.
 *
 * @param {number} startGX
 * @param {number} startGY
 * @param {object[]} slots
 * @param {boolean} viaExit — true for retrieve trips, which must route
 *   through the Versand exit before returning home
 * @returns {object[]} `slots`, reordered
 */
function _optimizeVisitOrder(startGX, startGY, slots, viaExit) {
  if (slots.length <= 1) return slots;

  const exitGX = viaExit ? Math.floor(EXIT_X / CELL_SIZE) : null;
  const exitGY = viaExit ? Math.floor(AISLE_CY / CELL_SIZE) : null;

  const routeCost = (order) => {
    const { legs, unreachable, endGX, endGY } = _planRouteLegs(startGX, startGY, order);
    if (unreachable.length) return Infinity;   // an invalid order — some slot unreachable from a prior stop
    let cost = legs.reduce((sum, leg) => sum + leg.cells.length, 0);
    if (viaExit) {
      const toExit = _aStar(endGX, endGY, exitGX, exitGY);
      cost += toExit ? toExit.length : Infinity;
    }
    return cost;
  };

  if (slots.length <= MAX_EXHAUSTIVE_STOPS) {
    let best = slots, bestCost = Infinity;
    for (const perm of _permutations(slots)) {
      const cost = routeCost(perm);
      if (cost < bestCost) { bestCost = cost; best = perm; }
    }
    return best;
  }

  // Nearest-neighbor greedy fallback for unusually large stop counts.
  const remaining = [...slots];
  const order = [];
  let curGX = startGX, curGY = startGY;
  while (remaining.length) {
    let bestIdx = 0, bestDist = Infinity;
    remaining.forEach((slot, i) => {
      const { legs, unreachable } = _planRouteLegs(curGX, curGY, [slot]);
      const dist = unreachable.length ? Infinity : legs[0].cells.length;
      if (dist < bestDist) { bestDist = dist; bestIdx = i; }
    });
    const [chosen] = remaining.splice(bestIdx, 1);
    order.push(chosen);
    const chosenLeg = _planRouteLegs(curGX, curGY, [chosen]).legs[0];
    if (chosenLeg) {
      const lastCell = chosenLeg.cells[chosenLeg.cells.length - 1];
      curGX = lastCell.gx;
      curGY = lastCell.gy;
    }
  }
  return order;
}

// ── A* pathfinding ────────────────────────────────────────────────────────────

function _aStar(startGX, startGY, endGX, endGY) {
  if (startGX === endGX && startGY === endGY) {
    return [{ gx: startGX, gy: startGY }];
  }

  const h    = (gx, gy) => Math.abs(gx - endGX) + Math.abs(gy - endGY);
  const heap = new _MinHeap();
  const gCost  = new Map();
  const parent = new Map();

  const startKey = `${startGX},${startGY}`;
  heap.push({ f: h(startGX, startGY), gx: startGX, gy: startGY });
  gCost.set(startKey, 0);
  parent.set(startKey, null);

  const DIRS = [[0, -1], [0, 1], [-1, 0], [1, 0]];

  while (heap.size > 0) {
    const { gx, gy } = heap.pop();
    const key        = `${gx},${gy}`;
    const g          = gCost.get(key);

    if (gx === endGX && gy === endGY) {
      // Reconstruct path
      const path = [];
      let cur = key;
      while (cur !== null) {
        const [pgx, pgy] = cur.split(',').map(Number);
        path.unshift({ gx: pgx, gy: pgy });
        cur = parent.get(cur);
      }
      return path;
    }

    for (const [dx, dy] of DIRS) {
      const nx  = gx + dx, ny = gy + dy;
      const nKey = `${nx},${ny}`;
      if (!_grid[ny]?.[nx] || _obstacles.has(nKey)) continue;

      const ng = g + 1;
      if (!gCost.has(nKey) || ng < gCost.get(nKey)) {
        gCost.set(nKey, ng);
        parent.set(nKey, key);
        heap.push({ f: ng + h(nx, ny), gx: nx, gy: ny });
      }
    }
  }

  return null;  // no route
}

// ── Path → waypoints ──────────────────────────────────────────────────────────

/**
 * Compress consecutive same-direction grid cells into pixel waypoints.
 * Direction changes create new waypoints, keeping the path visually clean.
 */
function _cellsToWaypoints(cells) {
  if (cells.length === 0) return [];
  const wps = [_c2px(cells[0])];
  if (cells.length === 1) return wps;

  let prevDx = cells[1].gx - cells[0].gx;
  let prevDy = cells[1].gy - cells[0].gy;

  for (let i = 1; i < cells.length; i++) {
    const isLast = i === cells.length - 1;
    const dx = isLast ? prevDx : cells[i + 1].gx - cells[i].gx;
    const dy = isLast ? prevDy : cells[i + 1].gy - cells[i].gy;

    if (dx !== prevDx || dy !== prevDy || isLast) {
      wps.push(_c2px(cells[i]));
      prevDx = dx; prevDy = dy;
    }
  }

  return wps;
}

function _c2px(cell) {
  return {
    px: cell.gx * CELL_SIZE + CELL_SIZE / 2,
    py: cell.gy * CELL_SIZE + CELL_SIZE / 2,
  };
}

// ── Path timing ───────────────────────────────────────────────────────────────

/**
 * @param {Array} waypoints
 * @param {number[]} peakIndices — indices within `waypoints` where the
 *   robot pauses for WORK_TIME (e.g. grabbing an item, dropping it off).
 *   Multiple pauses are supported, since retrieve trips now stop twice:
 *   once at the slot, once at the Versand exit.
 * @param {number[]} [peakTimesOut] — optional; if given, pushed with the
 *   trip-relative time (seconds) at which each pause in `peakIndices`
 *   finishes, in the same order. Lets callers schedule a "this stop is
 *   done" callback for a multi-stop trip without duplicating the timing
 *   math.
 */
function _buildTimedPath(waypoints, peakIndices, peakTimesOut) {
  const peaks = new Set(peakIndices);
  let T = 0;
  const timed = [{ ...waypoints[0], t: 0 }];

  for (let i = 1; i < waypoints.length; i++) {
    const from  = waypoints[i - 1];
    const to    = waypoints[i];
    const dx    = Math.abs(to.px - from.px);
    const dy    = Math.abs(to.py - from.py);
    const speed = dy < 1 ? SPEED_H : SPEED_V;
    T += Math.hypot(dx, dy) / speed;

    timed.push({ ...to, t: T, working: to.working ?? false });

    if (peaks.has(i)) {
      T += WORK_TIME;
      timed.push({ ...to, t: T, working: true });
      if (peakTimesOut) peakTimesOut.push(T);
    }
  }

  return timed;
}

// ── Obstacle sync ─────────────────────────────────────────────────────────────

function _syncObstacles() {
  _warehouseSetObstacles(_obstacles);
  redrawWarehouse();
}

// ── Min-heap (priority queue for A*) ─────────────────────────────────────────

class _MinHeap {
  constructor() { this._h = []; }
  get size()    { return this._h.length; }

  push(item) {
    this._h.push(item);
    this._up(this._h.length - 1);
  }

  pop() {
    const top  = this._h[0];
    const last = this._h.pop();
    if (this._h.length > 0) { this._h[0] = last; this._dn(0); }
    return top;
  }

  _up(i) {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this._h[p].f <= this._h[i].f) break;
      [this._h[p], this._h[i]] = [this._h[i], this._h[p]];
      i = p;
    }
  }

  _dn(i) {
    const n = this._h.length;
    while (true) {
      let m = i;
      const l = 2*i+1, r = 2*i+2;
      if (l < n && this._h[l].f < this._h[m].f) m = l;
      if (r < n && this._h[r].f < this._h[m].f) m = r;
      if (m === i) break;
      [this._h[m], this._h[i]] = [this._h[i], this._h[m]];
      i = m;
    }
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function _lerp(a, b, t) { return a + (b - a) * t; }
function _ease(t) { return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2, 3)/2; }
