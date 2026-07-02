/**
 * towerdefense.js — hidden "Easter egg" minigame
 *
 * Completely self-contained: on import, it injects its own <style>, builds
 * its own tiny trigger button and full-screen overlay, and runs its own
 * canvas + game loop. It reads ONLY the read-only layout geometry and the
 * pure slotPos() helper from warehouse.js — it never calls any mutating
 * function in warehouse.js/robot.js/main.js and never touches the real
 * #warehouse-canvas, the real obstacle set, or any real inventory state.
 * Closing the overlay stops its animation loop completely; nothing here
 * can leak into or break the real simulation.
 *
 * Integration footprint in the rest of the app: ONE side-effect import
 * line in main.js (`import './modules/towerdefense.js';`). Nothing else.
 *
 * Game: shelves (same positions as the real warehouse) each start with 3
 * lives. Enemy "robots" spawn from the home/Warenannahme side and walk to
 * an alive shelf to grab a life — but that life is only actually lost once
 * the robot successfully CARRIES it all the way to the Versand zone on the
 * right. Kill it anywhere along either leg of that trip and the life is
 * safe. Killing an enemy earns currency, spent on more towers or cheap
 * obstacles to reroute enemies. Placement is blocked if it would seal off
 * every remaining shelf (or the Versand tile itself) — you can funnel
 * enemies away from some shelves, but never wall the maze shut entirely.
 */

import {
  TILE, CANVAS_W, CANVAS_H, SLOT_W, SLOT_H,
  HOME_X, EXIT_X, AISLE_CY, slotPos,
} from './warehouse.js';

// ── Shelf layout — mirrors the real warehouse's 20 slots exactly ────────────

const SLOT_DEFS = [];
for (let col = 1; col <= 5; col++) {
  SLOT_DEFS.push({ label: `D${col}`, row_num: 4, col_num: col, storage_type: 'frozen' });
  SLOT_DEFS.push({ label: `C${col}`, row_num: 3, col_num: col, storage_type: 'chilled' });
  SLOT_DEFS.push({ label: `A${col}`, row_num: 1, col_num: col, storage_type: col <= 3 ? 'ambient' : 'fresh' });
  SLOT_DEFS.push({ label: `B${col}`, row_num: 2, col_num: col, storage_type: col <= 3 ? 'ambient' : 'fresh' });
}

const START_LIVES_PER_SHELF = 3;

// ── Grid ──────────────────────────────────────────────────────────────────

const GRID_W = Math.ceil(CANVAS_W / TILE);
const GRID_H = Math.ceil(CANVAS_H / TILE);
const SPAWN_GX = Math.floor(HOME_X   / TILE);
const SPAWN_GY = Math.floor(AISLE_CY / TILE);
const EXIT_GX  = Math.floor(EXIT_X   / TILE);
const EXIT_GY  = Math.floor(AISLE_CY / TILE);

// ── Balance constants ─────────────────────────────────────────────────────

const START_CURRENCY = 120;
const OBSTACLE_COST  = 15;
const TOWER_COST     = 60;
const TOWER_RANGE_PX = 3.4 * TILE;
const TOWER_FIRE_MS  = 500;
const TOWER_DAMAGE   = 1;
const ENEMY_SPEED_PX = 1.6 * TILE;   // px / second
const SPAWN_GAP_MS   = 900;
const WAVE_GAP_MS    = 4000;
const PROJECTILE_MS  = 150;

// ── Module state (fully self-contained; reset on every open) ────────────────

let canvas, ctx, overlayEl, toastEl, hudCurrencyEl, hudLivesEl, hudWaveEl;
let gameOverEl, gameOverStatsEl, obstacleBtn, towerBtn, hintEl;

let running   = false;
let rafId     = null;
let lastTs    = 0;

let shelves      = [];   // { label, x, y, gx0, gy0, lives, docks: [{gx,gy}] }
let shelfTileSet = new Set();
let enemies      = [];   // { x, y, path, pathIdx, targetLabel, hp, maxHp }
let towers       = [];   // { gx, gy, cooldown }
let obstacles    = new Set();  // "gx,gy"
let projectiles  = [];   // { fromX, fromY, x, y, t, dur }

let currency   = START_CURRENCY;
let wave       = 0;
let waveTimer  = 0;
let spawnsLeft = 0;
let spawnTimer = 0;
let gameOver   = false;
let placeMode  = null;   // null | 'obstacle' | 'tower'
let hoverTile  = null;   // {gx,gy} while placing, for the preview ring
let toastUntil = 0;

// ══════════════════════════════════════════════════════════════════════════
// Bootstrap — runs immediately on import
// ══════════════════════════════════════════════════════════════════════════

_injectStyles();
_createTrigger();
_createOverlay();
_createKeywordTrigger();

function _injectStyles() {
  const style = document.createElement('style');
  style.textContent = `
    .qs-td-trigger {
      position: fixed;
      bottom: 6px;
      right: 6px;
      width: 14px;
      height: 14px;
      border: none;
      background: transparent;
      font-size: 10px;
      line-height: 14px;
      opacity: 0.12;
      cursor: pointer;
      z-index: 99998;
      padding: 0;
      transition: opacity 0.15s;
    }
    .qs-td-trigger:hover { opacity: 0.5; }

    .qs-td-overlay {
      display: none;
      position: fixed;
      inset: 0;
      z-index: 99999;
      background: rgba(6, 9, 16, 0.82);
      align-items: center;
      justify-content: center;
      padding: 1rem;
    }
    .qs-td-overlay.qs-td-open { display: flex; }

    .qs-td-panel {
      background: var(--surface, #fff);
      border-radius: 12px;
      padding: 0.9rem 1rem 1.1rem;
      max-width: 95vw;
      box-shadow: 0 20px 60px rgba(0,0,0,0.5);
      font-family: var(--font-mono, monospace);
    }

    .qs-td-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 0.5rem;
    }
    .qs-td-title {
      font-weight: 700;
      font-size: 0.85rem;
      color: var(--text-hi, #111);
      letter-spacing: 0.02em;
    }
    .qs-td-close {
      border: none;
      background: transparent;
      color: var(--text-lo, #666);
      font-size: 0.9rem;
      cursor: pointer;
      padding: 0.1rem 0.4rem;
    }
    .qs-td-close:hover { color: var(--red, #c00); }

    .qs-td-hud {
      display: flex;
      gap: 1rem;
      font-size: 0.75rem;
      color: var(--text-hi, #111);
      margin-bottom: 0.5rem;
      font-weight: 700;
    }
    .qs-td-hud span.qs-td-lo { color: var(--text-lo, #666); font-weight: 500; }

    .qs-td-canvas-wrap {
      position: relative;
      line-height: 0;
      border-radius: 8px;
      overflow: hidden;
    }
    .qs-td-canvas {
      display: block;
      width: 100%;
      max-width: 816px;
      height: auto;
      background: #0F1520;
      cursor: crosshair;
    }

    .qs-td-toast {
      position: absolute;
      top: 8px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(220, 38, 38, 0.92);
      color: #fff;
      font-size: 0.68rem;
      font-weight: 700;
      padding: 0.3rem 0.6rem;
      border-radius: 5px;
      opacity: 0;
      transition: opacity 0.2s;
      pointer-events: none;
      white-space: nowrap;
    }
    .qs-td-toast.qs-td-show { opacity: 1; }

    .qs-td-gameover {
      position: absolute;
      inset: 0;
      display: none;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 0.6rem;
      background: rgba(6,9,16,0.88);
      color: #fff;
      text-align: center;
      padding: 1rem;
    }
    .qs-td-gameover.qs-td-show { display: flex; }
    .qs-td-gameover p:first-child { font-size: 1.3rem; font-weight: 700; }
    .qs-td-gameover p { font-size: 0.78rem; color: #cbd5e1; margin: 0; }

    .qs-td-controls {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-top: 0.6rem;
      flex-wrap: wrap;
    }
    .qs-td-btn {
      font-family: var(--font-mono, monospace);
      font-size: 0.7rem;
      font-weight: 700;
      padding: 0.4rem 0.65rem;
      border-radius: 5px;
      border: 1px solid var(--border, #ddd);
      background: var(--bg, #f3f3f3);
      color: var(--text-hi, #111);
      cursor: pointer;
      transition: all 0.15s;
    }
    .qs-td-btn:hover { border-color: var(--blue, #1d4ed8); }
    .qs-td-btn.qs-td-active {
      background: var(--blue, #1d4ed8);
      border-color: var(--blue, #1d4ed8);
      color: #fff;
    }
    .qs-td-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .qs-td-hint {
      font-size: 0.66rem;
      color: var(--text-lo, #777);
      font-style: italic;
      margin-left: auto;
    }
  `;
  document.head.appendChild(style);
}

function _createTrigger() {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'qs-td-trigger';
  btn.textContent = '·';
  btn.setAttribute('aria-label', '');
  btn.addEventListener('click', () => {
    if (overlayEl.classList.contains('qs-td-open')) _closeGame();
    else _openGame();
  });
  document.body.appendChild(btn);
}

/**
 * Second (and more classic) way in: type "tower" anywhere on the page to
 * open the game — no need to spot the tiny corner dot. Ignored while any
 * form field has focus, so it can never interfere with actually typing
 * into the real app (product names, batch refs, quantities, etc.).
 */
function _createKeywordTrigger() {
  const WORD = 'tower';
  let buffer = '';

  document.addEventListener('keydown', (e) => {
    const t = e.target;
    const isEditable = t && (
      t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' ||
      t.tagName === 'SELECT' || t.isContentEditable
    );
    if (isEditable) { buffer = ''; return; }
    if (e.key.length !== 1) return;   // ignore Shift/Enter/arrows/etc.

    buffer = (buffer + e.key.toLowerCase()).slice(-WORD.length);
    if (buffer === WORD && !overlayEl.classList.contains('qs-td-open')) {
      buffer = '';
      _openGame();
    }
  });
}

function _createOverlay() {
  overlayEl = document.createElement('div');
  overlayEl.className = 'qs-td-overlay';
  overlayEl.innerHTML = `
    <div class="qs-td-panel">
      <div class="qs-td-header">
        <span class="qs-td-title">🏰 Shelf Defense</span>
        <button type="button" class="qs-td-close" id="qs-td-close">✕</button>
      </div>
      <div class="qs-td-hud">
        <span>💰 <span id="qs-td-currency">${START_CURRENCY}</span></span>
        <span>❤️ <span id="qs-td-lives">0</span></span>
        <span class="qs-td-lo">🌊 Welle <span id="qs-td-wave">0</span></span>
      </div>
      <div class="qs-td-canvas-wrap">
        <canvas class="qs-td-canvas" width="${CANVAS_W}" height="${CANVAS_H}"></canvas>
        <div class="qs-td-toast" id="qs-td-toast"></div>
        <div class="qs-td-gameover" id="qs-td-gameover">
          <p>Game Over</p>
          <p id="qs-td-gameover-stats"></p>
          <button type="button" class="qs-td-btn" id="qs-td-restart">🔄 Neu starten</button>
        </div>
      </div>
      <div class="qs-td-controls">
        <button type="button" class="qs-td-btn" id="qs-td-buy-obstacle">🧱 Hindernis (${OBSTACLE_COST})</button>
        <button type="button" class="qs-td-btn" id="qs-td-buy-tower">🗼 Turm (${TOWER_COST})</button>
        <span class="qs-td-hint">Roboter stehlen ein Leben und tragen es zum Versand rechts — stoppe sie unterwegs!</span>
      </div>
    </div>
  `;
  document.body.appendChild(overlayEl);

  canvas          = overlayEl.querySelector('canvas');
  ctx             = canvas.getContext('2d');
  toastEl         = overlayEl.querySelector('#qs-td-toast');
  hudCurrencyEl   = overlayEl.querySelector('#qs-td-currency');
  hudLivesEl      = overlayEl.querySelector('#qs-td-lives');
  hudWaveEl       = overlayEl.querySelector('#qs-td-wave');
  gameOverEl      = overlayEl.querySelector('#qs-td-gameover');
  gameOverStatsEl = overlayEl.querySelector('#qs-td-gameover-stats');
  obstacleBtn     = overlayEl.querySelector('#qs-td-buy-obstacle');
  towerBtn        = overlayEl.querySelector('#qs-td-buy-tower');
  hintEl          = overlayEl.querySelector('.qs-td-hint');

  overlayEl.querySelector('#qs-td-close').addEventListener('click', _closeGame);
  overlayEl.querySelector('#qs-td-restart').addEventListener('click', _resetGame);
  obstacleBtn.addEventListener('click', () => _selectPlaceMode('obstacle'));
  towerBtn.addEventListener('click', () => _selectPlaceMode('tower'));

  canvas.addEventListener('click', _onCanvasClick);
  canvas.addEventListener('mousemove', _onCanvasHover);
  canvas.addEventListener('mouseleave', () => { hoverTile = null; });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlayEl.classList.contains('qs-td-open')) _closeGame();
  });
}

// ══════════════════════════════════════════════════════════════════════════
// Open / close / reset
// ══════════════════════════════════════════════════════════════════════════

function _openGame() {
  overlayEl.classList.add('qs-td-open');
  _resetGame();
}

function _closeGame() {
  overlayEl.classList.remove('qs-td-open');
  running = false;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
}

function _resetGame() {
  shelves = SLOT_DEFS.map(def => {
    const { x, y } = slotPos(def);
    return {
      label: def.label,
      x, y,
      gx0: Math.round(x / TILE),
      gy0: Math.round(y / TILE),
      lives: START_LIVES_PER_SHELF,
      docks: [],
    };
  });
  shelfTileSet = new Set();
  for (const s of shelves) {
    const tw = SLOT_W / TILE, th = SLOT_H / TILE;
    for (let dx = 0; dx < tw; dx++) {
      for (let dy = 0; dy < th; dy++) {
        shelfTileSet.add(`${s.gx0 + dx},${s.gy0 + dy}`);
      }
    }
    s.docks = _shelfDockTiles(s);
  }

  enemies      = [];
  towers       = [];
  obstacles    = new Set();
  projectiles  = [];
  currency     = START_CURRENCY;
  wave         = 0;
  waveTimer    = 800;   // short delay before wave 1
  spawnsLeft   = 0;
  spawnTimer   = 0;
  gameOver     = false;
  placeMode    = null;
  hoverTile    = null;

  gameOverEl.classList.remove('qs-td-show');
  obstacleBtn.classList.remove('qs-td-active');
  towerBtn.classList.remove('qs-td-active');
  canvas.style.cursor = 'default';
  _updateHud();

  running = true;
  lastTs  = performance.now();
  if (rafId) cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(_loop);
}

// ══════════════════════════════════════════════════════════════════════════
// Grid / pathfinding (small, self-contained — no relation to robot.js)
// ══════════════════════════════════════════════════════════════════════════

function _shelfDockTiles(shelf) {
  const tw = SLOT_W / TILE, th = SLOT_H / TILE;
  const docks = [];
  for (let dx = -1; dx <= tw; dx++) {
    for (let dy = -1; dy <= th; dy++) {
      const onPerimeter = dx === -1 || dx === tw || dy === -1 || dy === th;
      if (!onPerimeter) continue;
      const gx = shelf.gx0 + dx, gy = shelf.gy0 + dy;
      if (gx < 0 || gy < 0 || gx >= GRID_W || gy >= GRID_H) continue;
      docks.push({ gx, gy });
    }
  }
  return docks;
}

function _isBlockedTile(gx, gy) {
  const key = `${gx},${gy}`;
  if (shelfTileSet.has(key)) return true;
  if (obstacles.has(key)) return true;
  if (towers.some(t => t.gx === gx && t.gy === gy)) return true;
  return false;
}

/** BFS from (startGX,startGY) to the nearest of any tile in `targets` (Set of "gx,gy"). */
function _bfsPathToAny(startGX, startGY, targets) {
  const startKey = `${startGX},${startGY}`;
  if (targets.has(startKey)) return [{ gx: startGX, gy: startGY }];

  const visited = new Set([startKey]);
  const parent  = new Map();
  const queue   = [{ gx: startGX, gy: startGY }];
  const DIRS    = [[0, -1], [0, 1], [-1, 0], [1, 0]];
  let qi = 0;

  while (qi < queue.length) {
    const { gx, gy } = queue[qi++];
    for (const [dx, dy] of DIRS) {
      const nx = gx + dx, ny = gy + dy;
      if (nx < 0 || ny < 0 || nx >= GRID_W || ny >= GRID_H) continue;
      const key = `${nx},${ny}`;
      if (visited.has(key) || _isBlockedTile(nx, ny)) continue;
      visited.add(key);
      parent.set(key, `${gx},${gy}`);
      if (targets.has(key)) {
        const path = [{ gx: nx, gy: ny }];
        let cur = key;
        while (cur !== startKey) {
          cur = parent.get(cur);
          const [pgx, pgy] = cur.split(',').map(Number);
          path.unshift({ gx: pgx, gy: pgy });
        }
        return path;
      }
      queue.push({ gx: nx, gy: ny });
    }
  }
  return null;
}

/** Flood-fill from spawn; returns the Set of alive shelf labels reachable. */
function _reachableAliveShelves() {
  const visited = new Set([`${SPAWN_GX},${SPAWN_GY}`]);
  const queue   = [[SPAWN_GX, SPAWN_GY]];
  const DIRS    = [[0, -1], [0, 1], [-1, 0], [1, 0]];
  let qi = 0;

  while (qi < queue.length) {
    const [gx, gy] = queue[qi++];
    for (const [dx, dy] of DIRS) {
      const nx = gx + dx, ny = gy + dy;
      if (nx < 0 || ny < 0 || nx >= GRID_W || ny >= GRID_H) continue;
      const key = `${nx},${ny}`;
      if (visited.has(key) || _isBlockedTile(nx, ny)) continue;
      visited.add(key);
      queue.push([nx, ny]);
    }
  }

  const reachable = new Set();
  for (const s of shelves) {
    if (s.lives <= 0) continue;
    if (s.docks.some(d => visited.has(`${d.gx},${d.gy}`))) reachable.add(s.label);
  }
  return reachable;
}

function _canPlaceAt(gx, gy) {
  if (gx < 0 || gy < 0 || gx >= GRID_W || gy >= GRID_H) return false;
  if (gx === SPAWN_GX && gy === SPAWN_GY) return false;
  if (gx === EXIT_GX && gy === EXIT_GY) return false;
  if (_isBlockedTile(gx, gy)) return false;

  // Tentatively place, verify at least one alive shelf stays reachable, revert.
  const key = `${gx},${gy}`;
  obstacles.add(key);
  const stillOk = _reachableAliveShelves().size > 0;
  obstacles.delete(key);
  return stillOk;
}

// ══════════════════════════════════════════════════════════════════════════
// Placement (obstacles / towers)
// ══════════════════════════════════════════════════════════════════════════

function _selectPlaceMode(mode) {
  const cost = mode === 'tower' ? TOWER_COST : OBSTACLE_COST;
  if (currency < cost) { _showToast('Nicht genug Münzen!'); return; }
  placeMode = placeMode === mode ? null : mode;
  obstacleBtn.classList.toggle('qs-td-active', placeMode === 'obstacle');
  towerBtn.classList.toggle('qs-td-active', placeMode === 'tower');
  canvas.style.cursor = placeMode ? 'crosshair' : 'default';
}

function _pixelToGrid(px, py) {
  return { gx: Math.floor(px / TILE), gy: Math.floor(py / TILE) };
}

function _canvasEventToPixel(e) {
  const r  = canvas.getBoundingClientRect();
  const sx = canvas.width  / r.width;
  const sy = canvas.height / r.height;
  return { px: (e.clientX - r.left) * sx, py: (e.clientY - r.top) * sy };
}

function _onCanvasHover(e) {
  if (!placeMode) { hoverTile = null; return; }
  const { px, py } = _canvasEventToPixel(e);
  hoverTile = _pixelToGrid(px, py);
}

function _onCanvasClick(e) {
  if (gameOver || !placeMode) return;
  const { px, py } = _canvasEventToPixel(e);
  const { gx, gy } = _pixelToGrid(px, py);

  if (!_canPlaceAt(gx, gy)) {
    _showToast('Kann hier nicht bauen — würde alle Regale abschneiden!');
    return;
  }

  const cost = placeMode === 'tower' ? TOWER_COST : OBSTACLE_COST;
  if (currency < cost) { _showToast('Nicht genug Münzen!'); placeMode = null; return; }

  currency -= cost;
  if (placeMode === 'tower') {
    towers.push({ gx, gy, cooldown: 0 });
  } else {
    obstacles.add(`${gx},${gy}`);
  }

  _repathEnemiesIfNeeded();
  _updateHud();

  placeMode = null;
  obstacleBtn.classList.remove('qs-td-active');
  towerBtn.classList.remove('qs-td-active');
  canvas.style.cursor = 'default';
  hoverTile = null;
}

function _repathEnemiesIfNeeded() {
  for (const en of enemies) {
    const remaining = en.path.slice(en.pathIdx);
    const blocked = remaining.some(c => _isBlockedTile(c.gx, c.gy));
    if (!blocked) continue;

    const curGX = Math.round(en.x / TILE), curGY = Math.round(en.y / TILE);

    if (en.carrying) {
      // Already holding a life — just needs a new way to the (fixed) exit.
      const path = _bfsPathToAny(curGX, curGY, new Set([`${EXIT_GX},${EXIT_GY}`]));
      if (path) { en.path = path; en.pathIdx = 0; }
      continue;
    }

    const reachable = _reachableAliveShelves();
    let target = reachable.has(en.targetLabel) ? en.targetLabel : [...reachable][0];
    if (!target) continue;   // nothing reachable at all — shouldn't happen; enemy just stalls

    const shelf = shelves.find(s => s.label === target);
    const dockKeys = new Set(shelf.docks.map(d => `${d.gx},${d.gy}`));
    const path = _bfsPathToAny(curGX, curGY, dockKeys);
    if (path) {
      en.path = path;
      en.pathIdx = 0;
      en.targetLabel = target;
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Waves / spawning
// ══════════════════════════════════════════════════════════════════════════

function _spawnEnemy() {
  const reachable = _reachableAliveShelves();
  if (!reachable.size) return;   // nothing reachable — skip this spawn

  const label = [...reachable][Math.floor(Math.random() * reachable.size)];
  const shelf = shelves.find(s => s.label === label);
  const dockKeys = new Set(shelf.docks.map(d => `${d.gx},${d.gy}`));
  const path = _bfsPathToAny(SPAWN_GX, SPAWN_GY, dockKeys);
  if (!path) return;

  // Higher base HP than a simple one-way trip would need — enemies now have
  // to survive a full round trip (shelf AND back to Versand) under tower
  // fire, so they need more cushion than before to still pose a threat.
  const hp = Math.min(5 + Math.floor((wave - 1) * 0.6), 14);
  enemies.push({
    x: SPAWN_GX * TILE + TILE / 2,
    y: SPAWN_GY * TILE + TILE / 2,
    path,
    pathIdx: 0,
    targetLabel: label,
    carrying: false,   // true once it has grabbed the life and is heading for Versand
    hp,
    maxHp: hp,
  });
}

function _startNextWave() {
  wave += 1;
  spawnsLeft = 3 + wave;
  spawnTimer = 0;
  if (wave % 5 === 0) _showToast(`Welle ${wave} geschafft! 🎉`, 1800);
}

// ══════════════════════════════════════════════════════════════════════════
// Update
// ══════════════════════════════════════════════════════════════════════════

function _update(dtMs) {
  if (gameOver) return;

  // Waves
  if (spawnsLeft > 0) {
    spawnTimer += dtMs;
    if (spawnTimer >= SPAWN_GAP_MS) {
      spawnTimer = 0;
      spawnsLeft -= 1;
      _spawnEnemy();
    }
  } else if (enemies.length === 0) {
    waveTimer += dtMs;
    if (waveTimer >= WAVE_GAP_MS) {
      waveTimer = 0;
      _startNextWave();
    }
  }

  _updateEnemies(dtMs / 1000);
  _updateTowers(dtMs);
  _updateProjectiles(dtMs);
  _checkGameOver();
  _updateHud();
}

function _updateEnemies(dtSec) {
  const stepPx = ENEMY_SPEED_PX * dtSec;

  for (let i = enemies.length - 1; i >= 0; i--) {
    const en = enemies[i];
    if (en.pathIdx >= en.path.length) { enemies.splice(i, 1); continue; }

    const cell = en.path[en.pathIdx];
    const tx = cell.gx * TILE + TILE / 2;
    const ty = cell.gy * TILE + TILE / 2;
    const dx = tx - en.x, dy = ty - en.y;
    const dist = Math.hypot(dx, dy);

    if (dist <= stepPx) {
      en.x = tx; en.y = ty;
      en.pathIdx += 1;
      if (en.pathIdx >= en.path.length) {
        if (!en.carrying) {
          // Arrived at the shelf — grab the life, then turn around for
          // Versand. Nothing is lost yet; only a successful delivery counts.
          const exitPath = _bfsPathToAny(cell.gx, cell.gy, new Set([`${EXIT_GX},${EXIT_GY}`]));
          if (exitPath) {
            en.carrying = true;
            en.path = exitPath;
            en.pathIdx = 0;
          } else {
            // No route out at all (shouldn't normally happen) — harmless despawn.
            enemies.splice(i, 1);
          }
        } else {
          // Made it to Versand with the stolen life — NOW it's actually lost.
          const shelf = shelves.find(s => s.label === en.targetLabel);
          if (shelf) shelf.lives = Math.max(0, shelf.lives - 1);
          enemies.splice(i, 1);
        }
      }
    } else {
      en.x += (dx / dist) * stepPx;
      en.y += (dy / dist) * stepPx;
    }
  }
}

function _updateTowers(dtMs) {
  for (const t of towers) {
    t.cooldown = Math.max(0, t.cooldown - dtMs);
    if (t.cooldown > 0) continue;

    const tx = t.gx * TILE + TILE / 2, ty = t.gy * TILE + TILE / 2;
    let bestEnemy = null, bestDist = Infinity;
    for (const en of enemies) {
      const d = Math.hypot(en.x - tx, en.y - ty);
      if (d <= TOWER_RANGE_PX && d < bestDist) { bestDist = d; bestEnemy = en; }
    }
    if (!bestEnemy) continue;

    t.cooldown = TOWER_FIRE_MS;
    projectiles.push({ fromX: tx, fromY: ty, target: bestEnemy, t: 0, dur: PROJECTILE_MS });
  }
}

function _updateProjectiles(dtMs) {
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const p = projectiles[i];
    p.t += dtMs;
    if (p.t >= p.dur) {
      // Land the hit, if the target is still around.
      if (enemies.includes(p.target)) {
        p.target.hp -= TOWER_DAMAGE;
        if (p.target.hp <= 0) {
          enemies.splice(enemies.indexOf(p.target), 1);
          currency += 20 + wave * 2;
        }
      }
      projectiles.splice(i, 1);
    }
  }
}

function _checkGameOver() {
  const totalLives = shelves.reduce((sum, s) => sum + s.lives, 0);
  if (totalLives <= 0 && !gameOver) {
    gameOver = true;
    gameOverStatsEl.textContent = `Welle ${wave} überlebt · ${currency} Münzen verdient`;
    gameOverEl.classList.add('qs-td-show');
  }
}

function _updateHud() {
  hudCurrencyEl.textContent = currency;
  hudLivesEl.textContent    = shelves.reduce((sum, s) => sum + s.lives, 0);
  hudWaveEl.textContent     = wave;
  obstacleBtn.disabled = currency < OBSTACLE_COST;
  towerBtn.disabled    = currency < TOWER_COST;
}

function _showToast(text, ms = 1400) {
  toastEl.textContent = text;
  toastEl.classList.add('qs-td-show');
  toastUntil = performance.now() + ms;
  window.setTimeout(() => {
    if (performance.now() >= toastUntil - 5) toastEl.classList.remove('qs-td-show');
  }, ms);
}

// ══════════════════════════════════════════════════════════════════════════
// Render
// ══════════════════════════════════════════════════════════════════════════

function _draw() {
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
  ctx.fillStyle = '#0F1520';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  _drawSpawn();
  _drawExit();
  _drawShelves();
  _drawObstacles();
  _drawTowers();
  _drawPlacementPreview();
  _drawProjectiles();
  _drawEnemies();
}

function _drawSpawn() {
  const x = SPAWN_GX * TILE + TILE / 2, y = SPAWN_GY * TILE + TILE / 2;
  ctx.fillStyle = 'rgba(90, 180, 255, 0.25)';
  ctx.beginPath(); ctx.arc(x, y, TILE * 0.9, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(90, 180, 255, 0.7)';
  ctx.font = '600 8px monospace';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('BASIS', x, y);
}

/** The goal enemies are actually running for — a life is only lost if one reaches this. */
function _drawExit() {
  const x = EXIT_GX * TILE + TILE / 2, y = EXIT_GY * TILE + TILE / 2;
  ctx.fillStyle = 'rgba(220, 38, 38, 0.22)';
  ctx.beginPath(); ctx.arc(x, y, TILE * 0.9, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(220, 38, 38, 0.75)';
  ctx.font = '600 8px monospace';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('VERSAND', x, y);
}

function _drawShelves() {
  for (const s of shelves) {
    const dead = s.lives <= 0;
    const pct  = s.lives / START_LIVES_PER_SHELF;
    const color = dead ? '#2A2F3A' : pct >= 1 ? '#1E5C38' : pct >= 0.5 ? '#8A6A1A' : '#7A1E1E';

    ctx.fillStyle = color;
    _rrect(s.x, s.y, SLOT_W, SLOT_H, 4);
    ctx.fill();

    ctx.fillStyle = dead ? '#5A6070' : '#E2E8F0';
    ctx.font = '700 9px monospace';
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText(s.label, s.x + 4, s.y + 3);

    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '700 10px monospace';
    ctx.fillText(dead ? '✕' : '❤'.repeat(s.lives), s.x + SLOT_W / 2, s.y + SLOT_H / 2 + 3);
  }
}

function _drawObstacles() {
  const inset = 4, size = TILE - inset * 2;
  for (const key of obstacles) {
    const [gx, gy] = key.split(',').map(Number);
    const x = gx * TILE + inset, y = gy * TILE + inset;
    ctx.fillStyle = '#8B6239';
    _rrect(x, y, size, size, 2); ctx.fill();
    ctx.strokeStyle = '#5C4023'; ctx.lineWidth = 1.5; ctx.stroke();

    // Packing-tape cross — same detail as the real warehouse's obstacles.
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x + 2, y + 2);
    ctx.lineTo(x + size - 2, y + size - 2);
    ctx.moveTo(x + size - 2, y + 2);
    ctx.lineTo(x + 2, y + size - 2);
    ctx.stroke();
  }
}

function _drawTowers() {
  for (const t of towers) {
    const x = t.gx * TILE + TILE / 2, y = t.gy * TILE + TILE / 2;
    ctx.fillStyle = '#3A70A8';
    ctx.beginPath(); ctx.arc(x, y, TILE * 0.34, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#BFE0FF';
    ctx.beginPath(); ctx.arc(x, y, TILE * 0.14, 0, Math.PI * 2); ctx.fill();
  }
}

function _drawPlacementPreview() {
  if (!placeMode || !hoverTile) return;
  const { gx, gy } = hoverTile;
  const ok = _canPlaceAt(gx, gy);
  const x = gx * TILE, y = gy * TILE;

  ctx.fillStyle = ok ? 'rgba(74, 222, 128, 0.28)' : 'rgba(248, 113, 113, 0.32)';
  ctx.fillRect(x, y, TILE, TILE);

  if (placeMode === 'tower') {
    ctx.strokeStyle = ok ? 'rgba(74,222,128,0.5)' : 'rgba(248,113,113,0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x + TILE / 2, y + TILE / 2, TOWER_RANGE_PX, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function _drawProjectiles() {
  for (const p of projectiles) {
    const frac = Math.min(p.t / p.dur, 1);
    const x = p.fromX + (p.target.x - p.fromX) * frac;
    const y = p.fromY + (p.target.y - p.fromY) * frac;
    ctx.fillStyle = '#FDE68A';
    ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill();
  }
}

function _drawEnemies() {
  for (const en of enemies) _drawEnemyRobot(en);
}

/**
 * Same body plan as the real robot in warehouse.js's _drawRobot() — shadow,
 * wheels, body, highlight strip, head, pulsing status light, corner dot —
 * just recolored red (instead of the real robot's amber) so it always reads
 * as hostile. The status light doubles as a "carrying" indicator: dim red
 * while still hunting for a shelf, pulsing gold once it has actually grabbed
 * a life and is running it back to Versand — worth focusing fire on.
 */
function _drawEnemyRobot(en) {
  const x = en.x, y = en.y;
  const BW = 14, BH = 11, HW = 10, HH = 7, WR = 3;

  ctx.save(); ctx.globalAlpha = 0.2; ctx.fillStyle = '#000';
  ctx.beginPath(); ctx.ellipse(x, y + BH / 2 + WR + 1, BW / 2 + 2, 2.5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();

  ctx.fillStyle = '#1A1F2E';
  ctx.beginPath(); ctx.arc(x - BW / 2 + WR, y + BH / 2, WR, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(x + BW / 2 - WR, y + BH / 2, WR, 0, Math.PI * 2); ctx.fill();

  ctx.fillStyle = en.carrying ? '#B91C1C' : '#DC2626';
  _rrect(x - BW / 2, y - BH / 2, BW, BH, 3); ctx.fill();

  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  _rrect(x - BW / 2 + 2, y - BH / 2 + 2, BW - 4, 4, 2); ctx.fill();

  ctx.fillStyle = '#8B1A1A';
  _rrect(x - HW / 2, y - BH / 2 - HH, HW, HH, 2); ctx.fill();

  const pulse = Math.sin(performance.now() / 125);
  const lightColor = en.carrying ? (pulse > 0 ? '#FDE047' : '#F59E0B') : '#7F1D1D';
  ctx.fillStyle = lightColor;
  ctx.beginPath(); ctx.arc(x, y - BH / 2 - HH / 2, 2, 0, Math.PI * 2); ctx.fill();

  if (en.carrying) {
    ctx.save(); ctx.globalAlpha = 0.22 + 0.14 * pulse; ctx.fillStyle = '#FDE047';
    ctx.beginPath(); ctx.arc(x, y - BH / 2 - HH / 2, 5, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  ctx.fillStyle = en.carrying ? '#FDE047' : '#7F1D1D';
  ctx.beginPath(); ctx.arc(x + BW / 2 - 2, y + BH / 2 - 2, 1.5, 0, Math.PI * 2); ctx.fill();

  // Health bar, above the head so it never overlaps the status light.
  const barY = y - BH / 2 - HH - 6;
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.fillRect(x - 8, barY, 16, 3);
  ctx.fillStyle = '#4ADE80';
  ctx.fillRect(x - 8, barY, 16 * Math.max(en.hp, 0) / en.maxHp, 3);
}

function _rrect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ══════════════════════════════════════════════════════════════════════════
// Loop
// ══════════════════════════════════════════════════════════════════════════

function _loop(ts) {
  if (!running) return;
  const dtMs = Math.min(ts - lastTs, 100);   // clamp to avoid huge jumps on tab-switch
  lastTs = ts;

  _update(dtMs);
  _draw();

  rafId = requestAnimationFrame(_loop);
}
