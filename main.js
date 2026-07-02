/**
 * main.js — Einstiegspunkt
 * Verbindet alle Module, baut die UI-Panels auf und verdrahtet
 * Lieferformular, Roboteranimation und Datenbank.
 */

import { loadInventory, loadProducts, computeAlerts, receiveDelivery, retrieveStock, loadSlotBatches, loadExpiryAlerts }
  from './modules/inventory.js';
import { initWarehouse, renderWarehouse, setShowGrid } from './modules/warehouse.js';
import { initRobot, animateRobot, isRobotBusy, canReachSlot,
         animateMultiRetrieve, animateMultiStore,
         toggleObstacle, clearObstacles, getObstacles, pixelToGrid }
  from './modules/robot.js';
import { parseGS1, buildGS1 } from './modules/gs1.js';
import { renderBarcodeSVG, renderBarcodeInto } from './modules/barcode.js';

// Hidden easter egg — fully self-contained (own canvas, own state, own
// pathfinding). Only reads read-only layout geometry from warehouse.js;
// never touches real inventory, obstacles, or the real canvas. See the
// file itself for details.
import './modules/towerdefense.js';

// ── DOM-Referenzen ────────────────────────────────────────────────────────────

const warehouseCanvas = document.getElementById('warehouse-canvas');
const statusDot       = document.getElementById('status-dot');
const statusLabel     = document.getElementById('status-label');
const slotCard        = document.getElementById('slot-card');
const deliveryCard    = document.getElementById('delivery-card');
const retrieveCard    = document.getElementById('retrieve-card');
const alertsBody      = document.getElementById('alerts-body');

// ── Anwendungszustand ─────────────────────────────────────────────────────────

let _inventory     = [];
let _products      = [];
let _expiryItems   = [];
let _selectedSlot  = null;
let _pendingBarcode = null;   // parsed GS1 data awaiting user confirmation
let _scanState       = 'idle'; // 'idle' | 'scanning' | 'done' — gates the tap-to-scan flow
let _obstacleMode   = false;  // when true, canvas clicks place/remove obstacles
let _demoOrder      = null;   // { id, createdAt, items[], status } — active demo order, if any

// ── Statusleiste ──────────────────────────────────────────────────────────────

function setStatus(state, text) {
  statusDot.className     = `status-dot ${state}`;
  statusLabel.textContent = text;
}

// ── Tab-Navigation (Lieferung / Ausgabe / Bestellung / Alarme) ────────────────

const _TAB_PANEL_IDS = {
  delivery: 'delivery-card',
  retrieve: 'retrieve-card',
  order:    'demo-order-card',
  alerts:   'alerts-card',
};

window.switchTab = function (tabName) {
  const targetId = _TAB_PANEL_IDS[tabName];
  if (!targetId) return;

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('tab-btn--active', btn.dataset.tab === tabName);
  });
  document.querySelectorAll('.tab-panel').forEach(panel => {
    panel.classList.toggle('tab-panel--active', panel.id === targetId);
  });
};

// ── Stellplatz-Detailpanel ────────────────────────────────────────────────────

function showSlotDetail(slot) {
  _selectedSlot = slot;
  const belegt = slot.quantity !== null && slot.quantity > 0;

  const zonenName = {
    ambient: 'Trockenware',
    chilled: 'Kühlung',
    frozen:  'Tiefkühl',
    fresh:   'Frische / Obst',
  };

  // ── Render basic info synchronously ──────────────────────────────────────
  slotCard.innerHTML = `
    <p class="card-eyebrow">Stellplatz-Info</p>
    <p class="slot-id">${slot.label}</p>

    <div class="detail-row">
      <span class="detail-key">Lagerzone</span>
      <span class="badge badge-${slot.storage_type}">
        ${zonenName[slot.storage_type] ?? slot.storage_type}
      </span>
    </div>

    ${slot.temp_celsius !== null ? `
    <div class="detail-row">
      <span class="detail-key">Max. Temperatur</span>
      <span class="detail-val">${slot.temp_celsius} °C</span>
    </div>` : ''}

    <div class="detail-row">
      <span class="detail-key">Status</span>
      <span class="badge ${belegt ? 'badge-full' : 'badge-empty'}">
        ${belegt ? 'Belegt' : 'Leer'}
      </span>
    </div>

    ${belegt ? `
    <div class="detail-row">
      <span class="detail-key">Produkt</span>
      <span class="detail-val">${slot.product_name}</span>
    </div>
    <div class="detail-row">
      <span class="detail-key">Gesamt</span>
      <span class="detail-val">${slot.quantity} Stk.</span>
    </div>

    <div id="slot-batches">
      <p class="card-empty batch-loading">Lädt Chargen…</p>
    </div>
    <div id="slot-retrieve"></div>
    ` : _renderSlotStoreForm(slot)}
  `;

  // ── Async: load and render batch breakdown ────────────────────────────────
  if (!belegt) return;

  const capturedId = slot.id;
  const totalQty   = slot.quantity;

  loadSlotBatches(slot.id)
    .then(batches => {
      // Guard: user may have clicked a different slot while fetching
      if (_selectedSlot?.id !== capturedId) return;

      const batchesEl  = document.getElementById('slot-batches');
      const retrieveEl = document.getElementById('slot-retrieve');
      if (!batchesEl) return;

      batchesEl.innerHTML  = _renderBatchList(batches);
      if (retrieveEl) retrieveEl.innerHTML = _renderRetrieveSection(totalQty);
    })
    .catch(err => {
      if (_selectedSlot?.id !== capturedId) return;
      console.error('[QuickStore] Chargen konnten nicht geladen werden:', err);

      const batchesEl  = document.getElementById('slot-batches');
      const retrieveEl = document.getElementById('slot-retrieve');
      if (batchesEl)  batchesEl.innerHTML  = '<p class="card-empty">Chargen nicht verfügbar.</p>';
      // Still allow retrieval even if batch detail failed
      if (retrieveEl) retrieveEl.innerHTML = _renderRetrieveSection(totalQty);
    });
}

// ── Charge-Liste rendern ──────────────────────────────────────────────────────

function _renderBatchList(batches) {
  if (!batches.length) return '';

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const items = batches.map((b, i) => {
    const mhdStr = b.best_before ? _fmtDate(b.best_before) : null;
    const days   = b.best_before
      ? Math.ceil((new Date(b.best_before) - today) / 86_400_000)
      : null;

    // Urgency class: red ≤7 days, amber ≤14 days, normal otherwise
    const urgency = days === null  ? ''
                  : days <= 7     ? 'batch-mhd--critical'
                  : days <= 14    ? 'batch-mhd--warn'
                  : '';

    const mhdLabel = mhdStr
      ? `<span class="batch-mhd ${urgency}">MHD ${mhdStr}${days !== null && days <= 14 ? ` (${days}d)` : ''}</span>`
      : '';

    return `
      <div class="batch-item">
        <span class="batch-rank">${i + 1}</span>
        <div class="batch-body">
          <div class="batch-top">
            <span class="batch-ref">${b.batch_ref ?? '—'}</span>
            <span class="batch-qty">×${b.quantity}</span>
          </div>
          ${mhdLabel}
        </div>
      </div>`;
  }).join('');

  return `
    <p class="batch-list-label">Chargen (FEFO)</p>
    ${items}`;
}

// ── Entnahme-Bereich rendern (nach Chargen-Load) ──────────────────────────────

function _renderRetrieveSection(totalQty) {
  return `
    <div class="detail-row detail-row--top-border">
      <span class="detail-key">Entnahmemenge</span>
      <input type="number"
             id="retrieve-qty"
             class="form-input retrieve-qty-input"
             value="${totalQty}"
             min="1"
             max="${totalQty}">
    </div>
    <div class="detail-row slot-actions">
      <button class="btn btn-retrieve" onclick="window.triggerRetrieve()">
        ↑ Entnehmen
      </button>
    </div>`;
}

/**
 * Renders an inline product picker for an empty slot — a second, direct
 * way to store goods besides the Einlagern tab. Lists every product,
 * same as the Einlagern tab's own dropdown; the zone check happens
 * server-side in receive.php (it already rejects a mismatched slot_id
 * with a clear "wrong_zone" error), so there's no need to re-derive zone
 * compatibility client-side here too.
 */
function _renderSlotStoreForm(slot) {
  const options = [..._products]
    .sort((a, b) => a.name.localeCompare(b.name, 'de'))
    .map(p => `<option value="${p.gtin}">${p.name}</option>`)
    .join('');

  return `
    <div class="form-field detail-row--top-border">
      <label class="form-label" for="slot-store-product">Produkt</label>
      <select id="slot-store-product" class="form-select"
              onchange="window.onSlotStoreProductChange()">
        <option value="">— Bitte wählen —</option>
        ${options}
      </select>
    </div>

    <div class="form-field">
      <label class="form-label" for="slot-store-qty">Menge</label>
      <input type="number" id="slot-store-qty" class="form-input"
             value="1" min="1" max="9999">
    </div>

    <p class="delivery-msg" id="slot-store-msg"></p>

    <div class="detail-row slot-actions">
      <button class="btn btn-store" id="slot-store-submit"
              onclick="window.triggerStore()" disabled>
        ↓ Einlagern
      </button>
    </div>`;
}

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────

function _fmtDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

function _fmtDateTime(date) {
  const d  = String(date.getDate()).padStart(2, '0');
  const m  = String(date.getMonth() + 1).padStart(2, '0');
  const y  = date.getFullYear();
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${d}.${m}.${y}, ${hh}:${mm} Uhr`;
}

/**
 * Reloads inventory + expiry alerts from the DB and refreshes every view
 * that depends on current stock: the warehouse canvas, the alert panel,
 * and the Warenausgabe product dropdown. Called after every action that
 * changes stock (delivery, manual retrieval, barcode scan, demo order).
 */
async function _reloadInventory() {
  [_inventory, _expiryItems] = await Promise.all([
    loadInventory(),
    loadExpiryAlerts(),
  ]);
  renderWarehouse(_inventory);
  renderAlerts(computeAlerts(_inventory, _products), _expiryItems);
  _refreshRetrieveOptions();
}

/**
 * Runs whichever robot trip a receive.php response calls for. Most
 * deliveries fit in one slot and just need the plain single-stop 'store'
 * trip; when receive.php had to split a delivery across multiple slots
 * (per-slot capacity limit), this chains through all of them in one
 * continuous animateMultiStore trip instead.
 *
 * @param {Array<{slot_id:number}>} allocations — from a receive.php response
 * @param {(success: boolean) => void} onComplete
 */
function _animateStoreDelivery(allocations, onComplete) {
  const slots = allocations
    .map(a => _inventory.find(s => s.id === a.slot_id))
    .filter(Boolean);

  if (slots.length !== allocations.length) {
    console.error('[QuickStore] Zielstellplatz nicht in der Inventarliste gefunden.', allocations);
    onComplete(false);
    return;
  }

  if (slots.length === 1) {
    animateRobot(slots[0], 'store', _inventory, onComplete);
  } else {
    animateMultiStore(slots, _inventory, { onComplete: (success) => onComplete(success) });
  }
}

/** Human-readable summary of where a delivery landed — one or several slots. */
function _describeAllocations(allocations) {
  if (allocations.length === 1) {
    const a = allocations[0];
    return a.is_new_slot
      ? `Neuer Stellplatz: ${a.slot_label}`
      : `Bestand in ${a.slot_label} aufgestockt`;
  }
  const parts = allocations.map(a => `${a.quantity}× ${a.slot_label}`).join(', ');
  return `Aufgeteilt auf ${allocations.length} Stellplätze (Kapazitätslimit): ${parts}`;
}

/**
 * Runs whichever robot trip a product-based retrieve.php response calls
 * for (see triggerRetrieveForm). A single-slot result uses the plain
 * single-stop 'retrieve' trip; a multi-slot one — the product's stock was
 * spread across several shelves — chains through all of them in one
 * continuous animateMultiRetrieve trip, same as the demo order feature.
 *
 * @param {Array<{slot_id:number}>} allocations
 * @param {(success: boolean) => void} onComplete
 */
function _animateRetrieveAllocations(allocations, onComplete) {
  const slots = allocations
    .map(a => _inventory.find(s => s.id === a.slot_id))
    .filter(Boolean);

  if (slots.length !== allocations.length) {
    console.error('[QuickStore] Zielstellplatz nicht in der Inventarliste gefunden.', allocations);
    onComplete(false);
    return;
  }

  if (slots.length === 1) {
    animateRobot(slots[0], 'retrieve', _inventory, onComplete);
  } else {
    animateMultiRetrieve(slots, _inventory, { onComplete: (success) => onComplete(success) });
  }
}

// ── Lieferformular aufbauen ───────────────────────────────────────────────────

function buildDeliveryForm(products) {
  const options = [...products]
    .sort((a, b) => a.name.localeCompare(b.name, 'de'))
    .map(p => `
      <option value="${p.gtin}"
              data-perishable="${p.perishable}"
              data-name="${p.name}"
              data-max-temp="${p.max_temp_celsius ?? ''}">
        ${p.name}
      </option>`)
    .join('');

  deliveryCard.innerHTML = `
    <details class="scanner-section" open>
      <summary class="scanner-summary">
        📷 Barcode scannen
      </summary>
      <p class="scanner-hint">Demo-Barcodes antippen zum Scannen</p>
      <div id="scanner-demos"></div>
    </details>

    <p class="form-divider">oder manuell erfassen</p>

    <form class="delivery-form" onsubmit="return false">

      <div class="form-field">
        <label class="form-label" for="del-product">Produkt</label>
        <select id="del-product" class="form-select"
                onchange="window.onProductChange()">
          <option value="">— Bitte wählen —</option>
          ${options}
        </select>
      </div>

      <div class="form-field">
        <label class="form-label" for="del-qty">Menge</label>
        <input type="number" id="del-qty" class="form-input"
               value="1" min="1" max="9999">
      </div>

      <div class="form-field" id="del-mhd-wrap">
        <label class="form-label" for="del-mhd">MHD</label>
        <input type="date" id="del-mhd" class="form-input">
      </div>

      <div class="form-field">
        <label class="form-label" for="del-charge">Chargennr.</label>
        <input type="text" id="del-charge" class="form-input"
               placeholder="wird automatisch vergeben">
      </div>

      <button type="button" class="btn btn-store" id="del-submit"
              onclick="window.triggerDelivery()" disabled>
        ↓ Einlagern
      </button>

      <p class="delivery-msg" id="del-msg"></p>
    </form>
  `;

  // Render demo barcodes after the DOM update
  _buildScannerDemos();
}

// ── Produktauswahl-Handler ────────────────────────────────────────────────────

window.onProductChange = function () {
  const select   = document.getElementById('del-product');
  const mhdWrap  = document.getElementById('del-mhd-wrap');
  const mhdInput = document.getElementById('del-mhd');
  const btn      = document.getElementById('del-submit');
  const chargeEl = document.getElementById('del-charge');
  const msgEl    = document.getElementById('del-msg');

  // Reset message
  msgEl.textContent = '';
  msgEl.className   = 'delivery-msg';

  if (!select.value) {
    mhdWrap.style.display = 'none';
    btn.disabled = true;
    return;
  }

  const opt      = select.selectedOptions[0];

  // MHD immer anzeigen und automatisch berechnen (alle Produkte haben ein MHD)
  mhdInput.value = _calcMHD(opt.dataset.maxTemp);

  btn.disabled = false;

  // Chargenreferenz automatisch generieren
  const name   = opt.dataset.name ?? '';
  const prefix = name.replace(/[^a-zA-ZÄÖÜäöü]/g, '')
                     .toUpperCase()
                     .slice(0, 2)
                 || 'CH';
  const today  = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand   = String(Math.floor(Math.random() * 900) + 100);
  chargeEl.value = `CH-${prefix}-${today}-${rand}`;
};

// ── Lieferung einlagern ───────────────────────────────────────────────────────

window.triggerDelivery = async function () {
  if (isRobotBusy()) return;

  const gtin     = document.getElementById('del-product').value;
  const quantity = parseInt(document.getElementById('del-qty').value);
  const mhd      = document.getElementById('del-mhd')?.value    || null;
  const charge   = document.getElementById('del-charge')?.value.trim() || null;
  const btn      = document.getElementById('del-submit');
  const msgEl    = document.getElementById('del-msg');
  const opt      = document.getElementById('del-product').selectedOptions[0];
  const isPerish = opt?.dataset.perishable === 'true';

  // Validierung
  if (!gtin) {
    _setDeliveryMsg(msgEl, 'Bitte ein Produkt auswählen.', 'error');
    return;
  }
  if (!quantity || quantity < 1) {
    _setDeliveryMsg(msgEl, 'Ungültige Menge.', 'error');
    return;
  }
  // MHD ist für Frischware immer vorbelegt — keine manuelle Pflicht mehr

  // UI sperren
  btn.disabled = true;
  _setDeliveryMsg(msgEl, 'Prüfe verfügbare Stellplätze…', '');
  setStatus('working', 'Lieferung wird eingelagert…');

  try {
    // Stellplätze ausschließen, die der Roboter aktuell nicht erreichen kann
    // (Hindernisse) — verhindert, dass der Server Ware einem Stellplatz
    // zuweist, den der Roboter gar nicht anfahren kann.
    const excludedSlotIds = _inventory.filter(s => !canReachSlot(s)).map(s => s.id);

    // Datenbank zuerst aktualisieren
    const result = await receiveDelivery({
      gtin,
      quantity,
      best_before: mhd,
      batch_ref:   charge,
      excluded_slot_ids: excludedSlotIds,
    });

    // Zielstellplätze in der aktuellen Inventarliste suchen (können mehrere sein,
    // wenn receive.php die Lieferung wegen der Kapazitätsgrenze aufgeteilt hat)
    const hinweis = _describeAllocations(result.allocations);
    _setDeliveryMsg(msgEl, `→ ${hinweis}`, '');

    // Roboter fährt die Zielstellplätze an; nach Rückkehr Inventar neu laden
    _animateStoreDelivery(result.allocations, async (success) => {
      try {
        await _reloadInventory();
        if (success) {
          setStatus('ready', `${result.product_name} eingelagert ✓`);
          _setDeliveryMsg(msgEl, `✓ ${hinweis}`, 'success');
        } else {
          // Shouldn't happen now that receive.php excludes blocked slots —
          // but if it somehow does (e.g. an obstacle placed in the split
          // second between the request and the animation), don't claim success.
          setStatus('error', 'Roboter konnte nicht alle Stellplätze erreichen');
          _setDeliveryMsg(msgEl, `⚠ Ware verbucht, aber nicht alle Stellplätze waren für den Roboter erreichbar.`, 'error');
        }
      } catch (reloadErr) {
        console.error('[QuickStore] Inventar-Reload fehlgeschlagen:', reloadErr);
        setStatus('ready', 'System bereit');
      }
      btn.disabled = false;
    });

  } catch (err) {
    const msg = err.error_type === 'no_space'
      ? err.error
      : (err.error ?? err.message ?? 'Unbekannter Fehler');
    _setDeliveryMsg(msgEl, `✕ ${msg}`, 'error');
    setStatus('error', 'Einlagern fehlgeschlagen');
    btn.disabled = false;
  }
};

/**
 * Berechnet ein realistisches MHD anhand der Lagertemperatur des Produkts.
 *
 *   Trockenware     (kein max_temp)   →  +730 Tage (2 Jahre)
 *   Frische / Obst  (max_temp ~10 °C) →  +5 Tage
 *   Kühlung         (max_temp ~ 4 °C) →  +10 Tage
 *   Tiefkühl        (max_temp −18 °C) →  +365 Tage
 *
 * @param {string} maxTempStr — data-max-temp attribute (leer für Trockenware)
 * @returns {string} Datum im Format YYYY-MM-DD
 */
function _calcMHD(maxTempStr) {
  const t = parseFloat(maxTempStr);
  let days;
  if (isNaN(t))      days = 730;   // ambient / Trockenware
  else if (t <= -10) days = 365;   // frozen
  else if (t <=   5) days = 10;    // chilled
  else               days = 5;     // fresh

  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function _setDeliveryMsg(el, text, type) {
  el.textContent = text;
  el.className   = type
    ? `delivery-msg delivery-msg--${type}`
    : 'delivery-msg';
}

// ── Stellplatz-Aktionen ───────────────────────────────────────────────────────

window.triggerRetrieve = async function () {
  if (!_selectedSlot || isRobotBusy()) return;

  const qtyEl  = document.getElementById('retrieve-qty');
  const qty    = parseInt(qtyEl?.value ?? _selectedSlot.quantity);
  const maxQty = _selectedSlot.quantity;

  // Guard — shouldn't trigger due to min/max on the input, but just in case
  if (!qty || qty < 1 || qty > maxQty) return;

  const productName = _selectedSlot.product_name;
  const slotLabel   = _selectedSlot.label;
  const slotId      = _selectedSlot.id;

  if (!canReachSlot(_selectedSlot)) {
    setStatus('error', `${slotLabel} ist momentan durch ein Hindernis blockiert`);
    return;
  }

  setStatus('working', `Entnehme ${qty} × ${productName} aus ${slotLabel}…`);

  try {
    // Update DB first, then animate (canvas still shows old state during animation)
    await retrieveStock({ slot_id: slotId, quantity: qty });

    animateRobot(_selectedSlot, 'retrieve', _inventory, async (success) => {
      try {
        await _reloadInventory();

        // Refresh slot detail to reflect new quantity (or empty)
        const updated = _inventory.find(s => s.id === slotId);
        if (updated && updated.quantity > 0) {
          showSlotDetail(updated);
          _selectedSlot = updated;
        } else {
          slotCard.innerHTML = `
            <p class="card-eyebrow">Stellplatz-Info</p>
            <p class="card-empty">Stellplatz anklicken für Details.</p>`;
          _selectedSlot = null;
        }

        if (success) {
          setStatus('ready', `${qty} × ${productName} aus ${slotLabel} entnommen ✓`);
        } else {
          setStatus('error', `Roboter konnte ${slotLabel} nicht erreichen — Entnahme dennoch verbucht`);
        }
      } catch (reloadErr) {
        console.error('[QuickStore] Reload nach Entnahme fehlgeschlagen:', reloadErr);
        setStatus('ready', 'System bereit');
      }
    });

  } catch (err) {
    const msg = err.error ?? err.message ?? 'Unbekannter Fehler';
    setStatus('error', `Entnahme fehlgeschlagen: ${msg}`);
    console.error('[QuickStore] Entnahme fehlgeschlagen:', err);
  }
};

// Manuelles Einlagern über Stellplatz-Panel (ohne Formular)
window.onSlotStoreProductChange = function () {
  const select = document.getElementById('slot-store-product');
  const btn    = document.getElementById('slot-store-submit');
  const msgEl  = document.getElementById('slot-store-msg');
  if (msgEl) { msgEl.textContent = ''; msgEl.className = 'delivery-msg'; }
  if (btn) btn.disabled = !select?.value;
};

/**
 * Manuelles Einlagern über das Stellplatz-Panel: lagert das im Mini-Formular
 * gewählte Produkt tatsächlich GENAU in diesem Stellplatz ein (statt nur den
 * Roboter ohne Datenbankänderung hinfahren zu lassen). Übergibt slot_id an
 * receive.php, damit die sonst automatische Stellplatzwahl hier übersteuert wird.
 */
window.triggerStore = async function () {
  if (!_selectedSlot || isRobotBusy()) return;

  const slot   = _selectedSlot;   // capture now — _selectedSlot may change during the trip
  const select = document.getElementById('slot-store-product');
  const qtyEl  = document.getElementById('slot-store-qty');
  const btn    = document.getElementById('slot-store-submit');
  const msgEl  = document.getElementById('slot-store-msg');

  const gtin     = select?.value;
  const quantity = parseInt(qtyEl?.value, 10);

  if (!gtin) {
    _setDeliveryMsg(msgEl, 'Bitte ein Produkt auswählen.', 'error');
    return;
  }
  if (!quantity || quantity < 1) {
    _setDeliveryMsg(msgEl, 'Ungültige Menge.', 'error');
    return;
  }
  if (!canReachSlot(slot)) {
    _setDeliveryMsg(msgEl, `✕ ${slot.label} ist momentan durch ein Hindernis blockiert.`, 'error');
    return;
  }

  btn.disabled = true;
  _setDeliveryMsg(msgEl, 'Lagere ein…', '');
  setStatus('working', `Roboter fährt zu ${slot.label}…`);

  try {
    const excludedSlotIds = _inventory.filter(s => !canReachSlot(s)).map(s => s.id);

    const result = await receiveDelivery({
      gtin,
      quantity,
      best_before: null,
      batch_ref:   null,
      slot_id:     slot.id,
      excluded_slot_ids: excludedSlotIds,
    });

    animateRobot(slot, 'store', _inventory, async (success) => {
      try {
        await _reloadInventory();

        if (success) {
          setStatus('ready', `${result.product_name} in ${slot.label} eingelagert ✓`);
          const updated = _inventory.find(s => s.id === slot.id);
          if (updated) {
            showSlotDetail(updated);
            _selectedSlot = updated;
          }
        } else {
          setStatus('error', `Roboter konnte ${slot.label} nicht erreichen`);
          _setDeliveryMsg(msgEl, `⚠ Ware verbucht, aber ${slot.label} war für den Roboter nicht erreichbar.`, 'error');
          btn.disabled = false;
        }
      } catch (reloadErr) {
        console.error('[QuickStore] Inventar-Reload fehlgeschlagen:', reloadErr);
        setStatus('ready', 'System bereit');
        btn.disabled = false;
      }
    });

  } catch (err) {
    const msg = err.error ?? err.message ?? 'Unbekannter Fehler';
    _setDeliveryMsg(msgEl, `✕ ${msg}`, 'error');
    setStatus('error', 'Einlagern fehlgeschlagen');
    btn.disabled = false;
  }
};

// ── Warenausgabe (Seitenmenü) ─────────────────────────────────────────────────
// Alternative zur Entnahme per Stellplatz-Klick: Produkt wählen, Menge angeben —
// der Roboter sucht den passenden Stellplatz selbst und entnimmt wie gewohnt.

function buildRetrieveForm() {
  if (!retrieveCard) return;

  retrieveCard.innerHTML = `
    <form class="delivery-form" onsubmit="return false">

      <div class="form-field">
        <label class="form-label" for="ret-product">Produkt</label>
        <select id="ret-product" class="form-select"
                onchange="window.onRetrieveProductChange()">
          <option value="">— Bitte wählen —</option>
        </select>
      </div>

      <div class="form-field">
        <label class="form-label" for="ret-qty">Menge</label>
        <input type="number" id="ret-qty" class="form-input"
               value="1" min="1" max="1" disabled>
      </div>

      <p class="delivery-msg" id="ret-avail"></p>

      <button type="button" class="btn btn-retrieve" id="ret-submit"
              onclick="window.triggerRetrieveForm()" disabled>
        ↑ Entnehmen
      </button>

      <p class="delivery-msg" id="ret-msg"></p>
    </form>
  `;

  _refreshRetrieveOptions();
}

/**
 * Repopulates just the product <select> from current stock, preserving the
 * selection where possible. Called after every stock-changing action —
 * cheaper than rebuilding the whole card, and doesn't wipe out an in-flight
 * status message the way a full rebuild would.
 */
function _refreshRetrieveOptions() {
  const select = document.getElementById('ret-product');
  if (!select) return;

  const prevValue = select.value;

  // Aggregate by product across all slots — the user only picks a PRODUCT
  // here, not a location; the backend decides which slot(s) to draw from
  // (FEFO first, then smallest-slot-first — see retrieve.php).
  const totals = new Map();   // gtin -> { name, gtin, qty }
  for (const s of _inventory) {
    if (!s.product_name || !s.quantity) continue;
    const product = _products.find(p => p.name === s.product_name);
    if (!product) continue;
    const entry = totals.get(product.gtin) ?? { name: product.name, gtin: product.gtin, qty: 0 };
    entry.qty += s.quantity;
    totals.set(product.gtin, entry);
  }

  const stocked = [...totals.values()].sort((a, b) => a.name.localeCompare(b.name, 'de'));

  const options = stocked.map(p => `
    <option value="${p.gtin}" data-max="${p.qty}">
      ${p.name} — ${p.qty} Stk.
    </option>`).join('');

  select.innerHTML = `<option value="">— Bitte wählen —</option>${options}`;

  // Vorherige Auswahl (Produkt) beibehalten, sofern noch Bestand vorhanden ist
  select.value = stocked.some(p => p.gtin === prevValue) ? prevValue : '';
  window.onRetrieveProductChange();
}

window.onRetrieveProductChange = function () {
  const select  = document.getElementById('ret-product');
  const qtyEl   = document.getElementById('ret-qty');
  const availEl = document.getElementById('ret-avail');
  const btn     = document.getElementById('ret-submit');
  const msgEl   = document.getElementById('ret-msg');
  if (!select || !qtyEl || !availEl || !btn) return;

  if (msgEl) { msgEl.textContent = ''; msgEl.className = 'delivery-msg'; }

  if (!select.value) {
    qtyEl.disabled     = true;
    qtyEl.value        = 1;
    qtyEl.max          = 1;
    availEl.textContent = '';
    btn.disabled        = true;
    return;
  }

  const opt = select.selectedOptions[0];
  const max = parseInt(opt.dataset.max, 10) || 1;

  qtyEl.disabled      = false;
  qtyEl.max           = max;
  qtyEl.value         = Math.min(parseInt(qtyEl.value, 10) || 1, max);
  availEl.textContent = `${max} Stk. verfügbar`;
  btn.disabled         = false;
};

window.triggerRetrieveForm = async function () {
  if (isRobotBusy()) return;

  const select = document.getElementById('ret-product');
  const qtyEl  = document.getElementById('ret-qty');
  const btn    = document.getElementById('ret-submit');
  const msgEl  = document.getElementById('ret-msg');

  const gtin     = select.value;
  const quantity = parseInt(qtyEl.value, 10);

  if (!gtin) {
    _setDeliveryMsg(msgEl, 'Bitte ein Produkt auswählen.', 'error');
    return;
  }
  if (!quantity || quantity < 1) {
    _setDeliveryMsg(msgEl, 'Ungültige Menge.', 'error');
    return;
  }

  const product     = _products.find(p => p.gtin === gtin);
  const productName = product?.name ?? gtin;

  btn.disabled = true;
  _setDeliveryMsg(msgEl, `Entnehme ${quantity} × ${productName}…`, '');
  setStatus('working', `Entnehme ${quantity} × ${productName}…`);

  try {
    // Nur Hindernisse ausschließen — welcher/welche Stellplätze tatsächlich
    // angefahren werden, entscheidet retrieve.php (FEFO, dann kleinste
    // Stellplätze zuerst leeren, ggf. über mehrere Stellplätze verteilt).
    const excludedSlotIds = _inventory.filter(s => !canReachSlot(s)).map(s => s.id);

    const result = await retrieveStock({ gtin, quantity, excluded_slot_ids: excludedSlotIds });

    _animateRetrieveAllocations(result.allocations, async (success) => {
      try {
        await _reloadInventory();
        if (success) {
          setStatus('ready', `${quantity} × ${productName} entnommen ✓`);
          _setDeliveryMsg(msgEl, `✓ ${quantity} × ${productName} entnommen`, 'success');
        } else {
          setStatus('error', 'Roboter konnte nicht alle Stellplätze erreichen');
          _setDeliveryMsg(msgEl, '✕ Roboter konnte nicht alle Stellplätze erreichen', 'error');
        }
      } catch (reloadErr) {
        console.error('[QuickStore] Inventar-Reload fehlgeschlagen:', reloadErr);
        setStatus('ready', 'System bereit');
      }
      btn.disabled = false;
    });

  } catch (err) {
    const msg = err.error ?? err.message ?? 'Unbekannter Fehler';
    _setDeliveryMsg(msgEl, `✕ ${msg}`, 'error');
    setStatus('error', 'Entnahme fehlgeschlagen');
    btn.disabled = false;
  }
};

// ── Demo-Bestellung ────────────────────────────────────────────────────────────
// Simuliert eine Online-Bestellung: mehrere Artikel in kleinen Mengen werden
// nacheinander vom Roboter kommissioniert und zum Versand gebracht — wie bei
// einer echten automatisierten Lebensmittel-Lieferung.

/**
 * Generates a new demo order: 3–5 distinct in-stock products, each in a
 * small realistic quantity (1–4 units, never more than currently available).
 * Only builds the receipt — picking starts separately, on confirmation.
 */
window.generateDemoOrder = function () {
  if (_demoOrder?.status === 'picking') return;   // don't interrupt an active run

  // Nach PRODUKT aggregieren, nicht nach Stellplatz — ein Artikel kann jetzt
  // über mehrere Stellplätze verteilt sein (Kapazitätslimit). Welche(r)
  // Stellplatz/Stellplätze beim Kommissionieren tatsächlich angefahren
  // werden, entscheidet retrieve.php: FEFO zuerst, dann kleinste Stellplätze
  // zuerst leeren — dieselbe Logik wie im Warenausgabe-Tab.
  const totals = new Map();   // gtin -> { name, gtin, qty }
  for (const s of _inventory) {
    if (!s.product_name || !s.quantity) continue;
    const product = _products.find(p => p.name === s.product_name);
    if (!product) continue;
    const entry = totals.get(product.gtin) ?? { name: product.name, gtin: product.gtin, qty: 0 };
    entry.qty += s.quantity;
    totals.set(product.gtin, entry);
  }

  const candidates = [...totals.values()];

  if (!candidates.length) {
    _demoOrder = null;
    _renderDemoOrder('Kein Bestand vorhanden — aktuell kann keine Bestellung simuliert werden.');
    return;
  }

  const itemCount = Math.min(candidates.length, 3 + Math.floor(Math.random() * 3));  // 3–5 Artikel
  const picked    = [...candidates].sort(() => Math.random() - 0.5).slice(0, itemCount);

  const items = picked.map(p => {
    const maxQty = Math.min(p.qty, 4);
    const qty    = 1 + Math.floor(Math.random() * maxQty);
    return {
      productName:  p.name,
      gtin:         p.gtin,
      requestedQty: qty,
      status:       'pending',   // pending | picking | done | failed
    };
  });

  const now     = new Date();
  const orderNo = `WEB-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`
                + `${String(now.getDate()).padStart(2, '0')}-${Math.floor(1000 + Math.random() * 9000)}`;

  _demoOrder = { id: orderNo, createdAt: now, items, status: 'draft' };
  _renderDemoOrder();
};

/** Renders the receipt + picking progress into #demo-order-body. */
function _renderDemoOrder(emptyMessage) {
  const body  = document.getElementById('demo-order-body');
  const btn   = document.getElementById('demo-order-btn');
  const hint  = document.getElementById('demo-order-empty');
  const badge = document.getElementById('order-badge');
  if (!body) return;

  if (badge) {
    if (_demoOrder?.status === 'draft') {
      badge.textContent   = '!';
      badge.style.display = '';
    } else if (_demoOrder?.status === 'picking') {
      badge.textContent   = '…';
      badge.style.display = '';
    } else {
      badge.style.display = 'none';
    }
  }

  if (!_demoOrder) {
    body.innerHTML = '';
    if (hint) {
      hint.textContent = emptyMessage
        || 'Simuliert eine Online-Bestellung: mehrere Artikel in kleinen Mengen werden automatisch kommissioniert und zum Versand gebracht.';
      hint.style.display = '';
    }
    if (btn) { btn.disabled = false; btn.textContent = '🧾 Demo-Bestellung erzeugen'; }
    return;
  }

  if (hint) hint.style.display = 'none';

  const { id, createdAt, items, status } = _demoOrder;

  const rows = items.map(item => {
    const icon = item.status === 'done'    ? '✓'
               : item.status === 'picking' ? '…'
               : item.status === 'failed'  ? '✕'
               : '';
    return `
      <div class="receipt-row receipt-row--${item.status}">
        <span class="receipt-qty">${item.requestedQty}×</span>
        <span class="receipt-name">${item.productName}</span>
        <span class="receipt-status">${icon}</span>
      </div>`;
  }).join('');

  const anyFailed = items.some(i => i.status === 'failed');
  let footer;

  if (status === 'done') {
    footer = anyFailed
      ? `<p class="receipt-footer receipt-footer--warn">⚠ Teilweise kommissioniert — nicht alle Artikel waren erreichbar.</p>`
      : `<p class="receipt-footer receipt-footer--success">✓ Vollständig kommissioniert und am Versand bereitgestellt.</p>`;
  } else if (status === 'picking') {
    const doneCount = items.filter(i => i.status === 'done' || i.status === 'failed').length;
    footer = `<p class="receipt-footer">Kommissioniere Artikel ${Math.min(doneCount + 1, items.length)} von ${items.length}…</p>`;
  } else {
    const totalUnits = items.reduce((sum, i) => sum + i.requestedQty, 0);
    footer = `<p class="receipt-footer">${totalUnits} Artikel gesamt · bereit zur Kommissionierung</p>`;
  }

  body.innerHTML = `
    <div class="demo-receipt">
      <p class="receipt-head">Bestellung ${id}</p>
      <p class="receipt-sub">${_fmtDateTime(createdAt)}</p>
      <div class="receipt-divider"></div>
      ${rows}
      <div class="receipt-divider"></div>
      ${footer}
    </div>
    ${status === 'draft' ? `
      <button type="button" class="btn btn-store" id="demo-order-start-btn"
              onclick="window.startDemoOrderPicking()">
        Kommissionierung starten →
      </button>` : ''}
  `;

  if (btn) {
    btn.disabled    = status === 'picking';
    btn.textContent = status === 'done' ? '🧾 Neue Demo-Bestellung' : '🧾 Demo-Bestellung erzeugen';
  }
}

/**
 * Runs the whole pick list as ONE continuous robot trip: resolve every
 * item's slot, deduct stock for everything that's reachable, then send the
 * robot shelf-to-shelf (no detour home between items) before it drops
 * everything off at the Versand exit and returns — instead of a separate
 * home → shelf → exit → home round trip per item.
 */
/**
 * Runs the whole order as ONE continuous robot trip. Each item is retrieved
 * via the same product-based retrieve.php mode as the Warenausgabe tab —
 * FEFO first, then smallest-current-quantity slot first, spilling across
 * slots if one isn't enough — so a demo order behaves exactly like a real
 * pick list instead of grabbing from a random shelf.
 */
window.startDemoOrderPicking = async function () {
  if (!_demoOrder || _demoOrder.status !== 'draft' || isRobotBusy()) return;

  _demoOrder.status = 'picking';
  _renderDemoOrder();
  setStatus('working', 'Kommissioniere Bestellung…');

  const excludedSlotIds = _inventory.filter(s => !canReachSlot(s)).map(s => s.id);

  // Jeden Artikel einzeln bei retrieve.php anfragen — das übernimmt FEFO +
  // "kleinste Stellplätze zuerst leeren" und liefert zurück, welche(r)
  // Stellplatz/Stellplätze dafür tatsächlich angefahren werden müssen
  // (kann bei knappem Bestand auch mehr als einer sein).
  const stops = [];   // { slot, item } — ein Eintrag pro nötigem Roboter-Stopp

  for (const item of _demoOrder.items) {
    item.status = 'picking';
    _renderDemoOrder();

    try {
      const result = await retrieveStock({
        gtin:              item.gtin,
        quantity:          item.requestedQty,
        excluded_slot_ids: excludedSlotIds,
      });

      item.pendingStops = result.allocations.length;
      item.doneStops     = 0;

      for (const alloc of result.allocations) {
        const slot = _inventory.find(s => s.id === alloc.slot_id);
        if (slot) stops.push({ slot, item });
      }
    } catch (err) {
      console.error('[QuickStore] Demo-Bestellung — Entnahme fehlgeschlagen für', item.productName, err);
      item.status = 'failed';
      _renderDemoOrder();
    }
  }

  if (!stops.length) {
    _demoOrder.status = 'done';
    setStatus('error', 'Kein Artikel der Bestellung konnte entnommen werden');
    _renderDemoOrder();
    return;
  }

  await new Promise(resolve => {
    animateMultiRetrieve(stops.map(s => s.slot), _inventory, {
      onStop: (slot) => {
        const stop = stops.find(s => s.slot.id === slot.id);
        if (stop) {
          stop.item.doneStops++;
          if (stop.item.doneStops >= stop.item.pendingStops) {
            stop.item.status = 'done';
          }
          _renderDemoOrder();
        }
      },
      onComplete: () => resolve(),
    });
  });

  try {
    await _reloadInventory();
  } catch (reloadErr) {
    console.error('[QuickStore] Inventar-Reload fehlgeschlagen:', reloadErr);
  }

  _demoOrder.status = 'done';
  const anyFailed = _demoOrder.items.some(i => i.status === 'failed');
  setStatus('ready', anyFailed ? 'Demo-Bestellung teilweise abgeschlossen' : 'Demo-Bestellung abgeschlossen ✓');
  _renderDemoOrder();
};

// ── Lageralarme ───────────────────────────────────────────────────────────────

function renderAlerts(stockAlerts, expiryItems) {
  let html = '';
  const busy = isRobotBusy();

  // ── Bestandsalarme ──────────────────────────────────────────────────────────
  if (stockAlerts.length) {
    html += `<p class="alert-section-label">Bestand</p>`;
    html += stockAlerts.map(({ product, currentQty, type }) => {
      const dotClass = type === 'reorder' ? 'alert-dot-red' : 'alert-dot-amber';
      const sub = type === 'reorder'
        ? `${currentQty} vorrätig — Grenze: ${product.reorder_level}`
        : `${currentQty} vorrätig — Maximum: ${product.max_quantity}`;

      // Nur bei Unterschreitung der Nachbestellgrenze ergibt eine Schnellbestellung
      // Sinn — bei Überbestand würde sie das Problem nur verschärfen.
      // +1, nicht bis genau an die Grenze — der Alarm feuert bei "<= Grenze",
      // also würde ein Ziel von exakt reorder_level den Alarm sofort wieder auslösen.
      const restockQty = Math.max(product.reorder_level - currentQty + 1, 1);
      const restockBtn = type === 'reorder'
        ? `<button type="button" class="alert-action-btn" ${busy ? 'disabled' : ''}
             onclick="window.quickRestock('${product.gtin}', ${restockQty})">
             ↓ ${restockQty}× nachbestellen
           </button>`
        : '';

      return `
        <div class="alert-item">
          <span class="alert-dot ${dotClass}"></span>
          <div class="alert-body">
            <div class="alert-name">${product.name}</div>
            <div class="alert-sub">${sub}</div>
            ${restockBtn}
          </div>
        </div>`;
    }).join('');
  }

  // ── MHD-Alarme ──────────────────────────────────────────────────────────────
  if (expiryItems.length) {
    if (stockAlerts.length) html += `<div class="alert-section-divider"></div>`;
    html += `<p class="alert-section-label">Ablaufdaten</p>`;
    html += expiryItems.map(item => {
      const d = item.days_remaining;
      const dotClass = d <= 7 ? 'alert-dot-red' : 'alert-dot-amber';
      const daysLabel = d < 0  ? `${Math.abs(d)}d abgelaufen`
                      : d === 0 ? 'läuft heute ab'
                      : `noch ${d} Tage`;

      // Nur bereits abgelaufene Ware (MHD -1 oder früher) bekommt den
      // Schnell-Entfernen-Button — alles andere ist noch verkaufsfähig.
      const nameEsc    = item.product_name.replace(/'/g, "\\'");
      const slotEsc    = item.slot_label.replace(/'/g, "\\'");
      const removeBtn = d <= -1
        ? `<button type="button" class="alert-action-btn alert-action-btn--danger" ${busy ? 'disabled' : ''}
             onclick="window.quickRemoveExpired('${slotEsc}', ${item.quantity}, '${nameEsc}')">
             ✕ ${item.quantity}× entfernen
           </button>`
        : '';

      return `
        <div class="alert-item">
          <span class="alert-dot ${dotClass}"></span>
          <div class="alert-body">
            <div class="alert-name">${item.product_name}</div>
            <div class="alert-sub">
              ${item.slot_label} · ×${item.quantity} · ${daysLabel}
            </div>
            ${removeBtn}
          </div>
        </div>`;
    }).join('');
  }

  if (!stockAlerts.length && !expiryItems.length) {
    html = '<p class="card-empty">Keine Alarme.</p>';
  }

  alertsBody.innerHTML = html;

  const badge = document.getElementById('alerts-badge');
  if (badge) {
    const count = stockAlerts.length + expiryItems.length;
    if (count > 0) {
      badge.textContent   = count > 9 ? '9+' : String(count);
      badge.style.display = '';
    } else {
      badge.style.display = 'none';
    }
  }
}

/**
 * Quick-order from a "Bestand" alert: delivers exactly enough of the given
 * product to bring stock back up to its reorder level, using the same
 * store flow (obstacle-aware slot exclusion, robot animation) as the
 * regular delivery form — just without the user having to open the form,
 * pick the product, and fill in the quantity by hand.
 */
window.quickRestock = async function (gtin, quantity) {
  if (isRobotBusy()) return;

  const product = _products.find(p => p.gtin === gtin);
  if (!product) return;

  setStatus('working', `Bestelle ${quantity} × ${product.name} nach…`);

  try {
    const excludedSlotIds = _inventory.filter(s => !canReachSlot(s)).map(s => s.id);

    const result = await receiveDelivery({
      gtin,
      quantity,
      best_before: null,   // receive.php berechnet ein passendes MHD automatisch
      batch_ref:   null,
      excluded_slot_ids: excludedSlotIds,
    });

    _animateStoreDelivery(result.allocations, async (success) => {
      try {
        await _reloadInventory();
        if (success) {
          setStatus('ready', `${quantity} × ${result.product_name} nachbestellt ✓`);
        } else {
          setStatus('error', `Roboter konnte nicht alle Stellplätze erreichen`);
        }
      } catch (reloadErr) {
        console.error('[QuickStore] Inventar-Reload fehlgeschlagen:', reloadErr);
        setStatus('ready', 'System bereit');
      }
    });

  } catch (err) {
    const msg = err.error_type === 'no_space' || err.error_type === 'blocked'
      ? err.error
      : (err.error ?? err.message ?? 'Unbekannter Fehler');
    setStatus('error', `Nachbestellung fehlgeschlagen: ${msg}`);
  }
};

/**
 * Quick-remove from an "Ablaufdaten" alert: retrieves the expired quantity
 * straight out of its slot and has the robot carry it to the Versand exit,
 * same as any other retrieval — just pre-filled from the alert row instead
 * of going through the slot panel or Warenausgabe form.
 *
 * Note: retrieval is FEFO per slot, not per exact batch — if a slot somehow
 * holds more than one expired batch at once, this removes the most-overdue
 * one first regardless of which row was clicked. Fine for the common case
 * of one expired batch per slot.
 */
window.quickRemoveExpired = async function (slotLabel, quantity, productName) {
  if (isRobotBusy()) return;

  const slot = _inventory.find(s => s.label === slotLabel);
  if (!slot || slot.quantity < quantity) {
    setStatus('error', `${productName} in ${slotLabel} ist nicht mehr auf Lager.`);
    await _reloadInventory();
    return;
  }

  if (!canReachSlot(slot)) {
    setStatus('error', `${slotLabel} ist momentan durch ein Hindernis blockiert.`);
    return;
  }

  setStatus('working', `Entferne ${quantity} × ${productName} (abgelaufen) aus ${slotLabel}…`);

  try {
    await retrieveStock({ slot_id: slot.id, quantity });

    animateRobot(slot, 'retrieve', _inventory, async (success) => {
      try {
        await _reloadInventory();
        if (success) {
          setStatus('ready', `${quantity} × ${productName} entsorgt ✓`);
        } else {
          setStatus('error', `Roboter konnte ${slotLabel} nicht erreichen`);
        }
      } catch (reloadErr) {
        console.error('[QuickStore] Inventar-Reload fehlgeschlagen:', reloadErr);
        setStatus('ready', 'System bereit');
      }
    });

  } catch (err) {
    const msg = err.error ?? err.message ?? 'Unbekannter Fehler';
    setStatus('error', `Entfernen fehlgeschlagen: ${msg}`);
  }
};

// ── Barcode-Scanner Demo ──────────────────────────────────────────────────────

/**
 * Generates four demo GS1-128 barcodes covering each storage zone and
 * renders them via JsBarcode inside #scanner-demos.
 * Each barcode represents a realistic new delivery with a computed MHD.
 */
function _buildScannerDemos() {
  const container = document.getElementById('scanner-demos');
  if (!container) return;

  // Specs: GTIN · units per delivery · shelf life in days · batch suffix
  const specs = [
    { gtin: '04000417023400', qty: 24, shelfDays: 730, suffix: '003' },  // Mineralwasser
    { gtin: '04010000006210', qty: 20, shelfDays: 10,  suffix: '043' },  // Vollmilch
    { gtin: '04003437008100', qty: 15, shelfDays: 365, suffix: '210' },  // TK-Pizza
    { gtin: '04000538200200', qty: 20, shelfDays: 5,   suffix: '002' },  // Paprika-Mix
  ];

  const demos = specs.map(({ gtin, qty, shelfDays, suffix }, i) => {
    const product = _products.find(p => p.gtin === gtin);
    if (!product) return null;

    const bb = new Date();
    bb.setDate(bb.getDate() + shelfDays);
    const bbISO = bb.toISOString().slice(0, 10);

    const prefix   = product.name.replace(/[^A-Za-zÄÖÜäöü]/g, '').toUpperCase().slice(0, 2) || 'CH';
    const batchRef = `CH-${prefix}-${suffix}`;
    const gs1      = buildGS1(gtin, bbISO, qty, batchRef);

    return { product, gs1, qty, bbISO, id: `bc-demo-${i}` };
  }).filter(Boolean);

  // Render list items — barcode SVG inline, no element IDs needed
  container.innerHTML = demos.map(d => `
    <div class="scanner-item" onclick="window.scanBarcode('${d.gs1.replace(/'/g, "\\'")}')">
      <div class="scanner-barcode">${
        renderBarcodeSVG(d.gs1, { height: 36, scale: 1, barColor: '#1A1F2E', bgColor: '#ffffff' })
      }</div>
      <div class="scanner-meta">
        <span class="scanner-name">${d.product.name}</span>
        <span class="scanner-badge">×${d.qty}</span>
      </div>
    </div>`).join('');
}

// ── Barcode-Handler ───────────────────────────────────────────────────────────

/**
 * Kurzer, synthetischer Scanner-Piepton via Web Audio API.
 * Keine externe Audiodatei nötig — funktioniert offline.
 */
function _playScanBeep() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx  = new Ctx();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type            = 'square';
    osc.frequency.value = 1800;

    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.13);

    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.14);
    osc.onended = () => ctx.close();
  } catch (err) {
    console.warn('[QuickStore] Scanner-Ton konnte nicht abgespielt werden:', err);
  }
}

/**
 * Called when a demo barcode is clicked.
 * Opens the confirmation modal with the GS1-128 barcode rendered and ready,
 * but does NOT scan it yet — the user has to tap the barcode itself
 * (see triggerScan) to actually trigger the read, just like picking up a
 * handheld scanner and aiming it.
 *
 * @param {string} gs1String — e.g. "(01)04000417023400(17)280629(37)24(10)CH-MW-003"
 */
window.scanBarcode = function (gs1String) {
  const modal = document.getElementById('barcode-modal');
  if (modal.open) return;   // a scan is already in progress / awaiting confirmation

  const parsed  = parseGS1(gs1String);
  const product = _products.find(p => p.gtin === parsed.gtin);

  if (!product) {
    console.warn('[QuickStore] Unbekannter GTIN im Barcode:', parsed.gtin);
    return;
  }

  _pendingBarcode = { parsed, product, gs1String };
  _scanState      = 'idle';

  const eyebrow  = document.getElementById('modal-eyebrow');
  const reveal   = document.getElementById('modal-reveal');
  const laser    = document.getElementById('scan-laser');
  const hint     = document.getElementById('scan-hint');
  const wrap     = document.getElementById('modal-barcode-wrap');
  const svgWrap  = document.getElementById('modal-barcode-svg');
  const storeBtn = document.getElementById('modal-store-btn');

  // Render the barcode right away — it's what gets tapped/scanned
  if (svgWrap) {
    svgWrap.innerHTML = renderBarcodeSVG(gs1String, {
      height:   64,
      scale:    1.5,
      barColor: '#111827',
      bgColor:  '#ffffff',
    });
  }

  // "Awaiting scan" state — nothing happens until the barcode is tapped
  eyebrow.textContent = 'Bereit zum Scannen';
  eyebrow.classList.remove('scanning');
  reveal.classList.remove('visible');
  laser.classList.remove('active');
  hint.classList.remove('hidden');
  wrap.classList.add('awaiting-scan');
  storeBtn.disabled = true;

  modal.showModal();
};

/**
 * Called when the user taps the large barcode inside the popup.
 * Runs the actual "scan": red laser sweep + beep, then — after a short
 * delay, simulating a real read — reveals the parsed delivery data.
 */
window.triggerScan = function () {
  if (!_pendingBarcode || _scanState !== 'idle') return;
  _scanState = 'scanning';

  const { parsed, product, gs1String } = _pendingBarcode;

  const eyebrow  = document.getElementById('modal-eyebrow');
  const reveal   = document.getElementById('modal-reveal');
  const laser    = document.getElementById('scan-laser');
  const hint     = document.getElementById('scan-hint');
  const wrap     = document.getElementById('modal-barcode-wrap');
  const storeBtn = document.getElementById('modal-store-btn');

  hint.classList.add('hidden');
  wrap.classList.remove('awaiting-scan');
  eyebrow.textContent = 'Scanne…';
  eyebrow.classList.add('scanning');
  laser.classList.add('active');

  _playScanBeep();

  window.setTimeout(() => {
    if (!_pendingBarcode) return;   // user cancelled mid-scan
    _scanState = 'done';

    laser.classList.remove('active');
    eyebrow.textContent = 'Lieferung gescannt';
    eyebrow.classList.remove('scanning');

    document.getElementById('modal-gs1-string').textContent = gs1String;
    document.getElementById('modal-product').textContent     = product.name;
    document.getElementById('modal-qty').textContent         = parsed.quantity ?? '—';
    document.getElementById('modal-mhd').textContent         = parsed.best_before
      ? _fmtDate(parsed.best_before)
      : '—';
    document.getElementById('modal-batch').textContent       = parsed.batch_ref ?? '—';

    reveal.classList.add('visible');
    storeBtn.disabled = false;
  }, 950);
};

/**
 * User confirmed the scanned delivery — store it immediately: write to the
 * DB, then send the robot to the assigned slot, exactly like the manual
 * delivery form does. No extra click in a separate form required.
 */
window.confirmBarcode = async function () {
  if (!_pendingBarcode || _scanState !== 'done' || isRobotBusy()) return;

  const { parsed, product } = _pendingBarcode;
  const modal     = document.getElementById('barcode-modal');
  const storeBtn  = document.getElementById('modal-store-btn');
  const cancelBtn = modal.querySelector('.btn-cancel');

  const quantity   = parsed.quantity ?? 1;
  const bestBefore = parsed.best_before || null;
  const batchRef   = parsed.batch_ref   || null;

  storeBtn.disabled    = true;
  cancelBtn.disabled   = true;
  storeBtn.textContent = 'Lagere ein…';
  setStatus('working', `${product.name} wird eingelagert…`);

  try {
    const excludedSlotIds = _inventory.filter(s => !canReachSlot(s)).map(s => s.id);

    const result = await receiveDelivery({
      gtin:        product.gtin,
      quantity,
      best_before: bestBefore,
      batch_ref:   batchRef,
      excluded_slot_ids: excludedSlotIds,
    });

    const hinweis = _describeAllocations(result.allocations);

    _pendingBarcode = null;
    _scanState      = 'idle';
    modal.close();

    _animateStoreDelivery(result.allocations, async (success) => {
      try {
        await _reloadInventory();
        if (success) {
          setStatus('ready', `${result.product_name} eingelagert ✓ (${hinweis})`);
        } else {
          setStatus('error', 'Roboter konnte nicht alle Stellplätze erreichen');
        }
      } catch (reloadErr) {
        console.error('[QuickStore] Inventar-Reload fehlgeschlagen:', reloadErr);
        setStatus('ready', 'System bereit');
      }
      storeBtn.disabled    = false;
      cancelBtn.disabled   = false;
      storeBtn.textContent = 'Jetzt einlagern →';
    });

  } catch (err) {
    const msg = err.error_type === 'no_space'
      ? err.error
      : (err.error ?? err.message ?? 'Unbekannter Fehler');
    setStatus('error', `Einlagern fehlgeschlagen: ${msg}`);
    storeBtn.disabled    = false;
    cancelBtn.disabled   = false;
    storeBtn.textContent = 'Jetzt einlagern →';
  }
};

/** User cancelled — close dialog without touching the form or the DB. */
window.cancelBarcode = function () {
  _pendingBarcode = null;
  _scanState      = 'idle';
  const laser = document.getElementById('scan-laser');
  if (laser) laser.classList.remove('active');
  document.getElementById('barcode-modal').close();
};

// ── Hindernis-Modus ───────────────────────────────────────────────────────────

/**
 * Toggle obstacle-placement mode. While active, clicking a corridor cell
 * on the canvas places or removes an obstacle there instead of opening
 * the slot detail panel.
 */
window.toggleObstacleMode = function () {
  _obstacleMode = !_obstacleMode;

  const btn  = document.getElementById('obstacle-toggle');
  const hint = document.getElementById('obstacle-hint');

  btn.classList.toggle('btn-toggle--active', _obstacleMode);
  hint.style.display = _obstacleMode ? 'block' : 'none';
  warehouseCanvas.classList.toggle('obstacle-cursor', _obstacleMode);

  // Show a faint tile-grid overlay while placing obstacles, so the user
  // can see exactly which tile a click will affect.
  setShowGrid(_obstacleMode);
  renderWarehouse(_inventory);
};

window.clearAllObstacles = function () {
  clearObstacles();
  _updateObstacleCount();
};

function _updateObstacleCount() {
  const el = document.getElementById('obstacle-count');
  const n  = getObstacles().size;
  el.textContent = n > 0 ? `${n} Hindernis${n === 1 ? '' : 'se'} aktiv` : '';
}

/**
 * Capture-phase listener — fires BEFORE warehouse.js's own bubble-phase
 * click handler, so we can intercept clicks while obstacle mode is active
 * and prevent the slot-detail panel from also opening.
 */
warehouseCanvas.addEventListener('click', (e) => {
  if (!_obstacleMode) return;
  e.stopImmediatePropagation();

  const r  = warehouseCanvas.getBoundingClientRect();
  const sx = warehouseCanvas.width  / r.width;
  const sy = warehouseCanvas.height / r.height;
  const px = (e.clientX - r.left) * sx;
  const py = (e.clientY - r.top)  * sy;

  const { gx, gy } = pixelToGrid(px, py);
  toggleObstacle(gx, gy);
  _updateObstacleCount();
}, true);  // capture: true — runs before warehouse.js's bubble-phase listener

// ── Initialisierung ───────────────────────────────────────────────────────────

async function init() {
  setStatus('', 'Lädt…');
  try {
    initWarehouse(warehouseCanvas, showSlotDetail);
    await document.fonts.ready;

    const [inventory, products, expiryItems] = await Promise.all([
      loadInventory(),
      loadProducts(),
      loadExpiryAlerts(),
    ]);

    _inventory   = inventory;
    _products    = products;
    _expiryItems = expiryItems;

    renderWarehouse(inventory);
    renderAlerts(computeAlerts(inventory, products), expiryItems);
    buildDeliveryForm(products);
    buildRetrieveForm();
    _renderDemoOrder();

    // Roboter zuletzt initialisieren (zeichnet sich auf dem Warehouse-Canvas)
    initRobot(inventory);

    setStatus('ready', 'System bereit');
  } catch (err) {
    setStatus('error', 'Verbindungsfehler');
    console.error('[QuickStore]', err);
  }
}

init();
