/**
 * inventory.js
 * Fetches and normalises data from the PHP API.
 * All fetch() calls live here — nothing else calls the API directly.
 */

const API = '/quickstore/api';

// ── Normalisation ─────────────────────────────────────────────────────────────

function normaliseSlot(row) {
  return {
    id:           parseInt(row.id),
    label:        row.label,
    row_num:      parseInt(row.row_num),
    col_num:      parseInt(row.col_num),
    storage_type: row.storage_type,
    temp_celsius: row.temp_celsius !== null ? parseFloat(row.temp_celsius) : null,
    product_name: row.product_name ?? null,
    best_before:  row.best_before  ?? null,
    quantity:     row.quantity !== null ? parseInt(row.quantity) : null,
  };
}

function normaliseProduct(row) {
  return {
    id:               parseInt(row.id),
    name:             row.name,
    gtin:             row.gtin,
    description:      row.description ?? '',
    perishable:       row.perishable === '1' || row.perishable === true,
    max_temp_celsius: row.max_temp_celsius !== null ? parseFloat(row.max_temp_celsius) : null,
    max_quantity:     parseInt(row.max_quantity),
    reorder_level:    parseInt(row.reorder_level),
  };
}

// ── API calls ─────────────────────────────────────────────────────────────────

export async function loadInventory() {
  const res = await fetch(`${API}/inventory.php`);
  if (!res.ok) throw new Error(`inventory.php returned ${res.status}`);
  const data = await res.json();
  return data.map(normaliseSlot);
}

export async function loadProducts() {
  const res = await fetch(`${API}/products.php`);
  if (!res.ok) throw new Error(`products.php returned ${res.status}`);
  const data = await res.json();
  return data.map(normaliseProduct);
}

/**
 * Submit a delivery to receive.php.
 * Returns the parsed JSON response on success, or throws the error object.
 *
 * @param {object} params
 * @param {string} params.gtin
 * @param {number} params.quantity
 * @param {string|null} params.best_before  — 'YYYY-MM-DD' or null
 * @param {string|null} params.batch_ref
 * @param {number[]}    [params.excluded_slot_ids] — slot ids to skip when
 *   picking a target (e.g. ones currently blocked by an obstacle), so the
 *   backend never assigns stock to a slot the robot can't reach.
 * @param {number|null} [params.slot_id] — store here specifically instead of
 *   letting the backend auto-pick a slot (used by the slot-panel "Einlagern"
 *   flow, where the user has already chosen the exact slot on the canvas).
 */
export async function receiveDelivery({ gtin, quantity, best_before, batch_ref, excluded_slot_ids, slot_id }) {
  const res = await fetch(`${API}/receive.php`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ gtin, quantity, best_before, batch_ref, excluded_slot_ids, slot_id }),
  });
  const data = await res.json();
  if (!res.ok) throw data;   // caller handles error objects
  return data;
}

/**
 * Retrieve stock via retrieve.php. Two modes:
 *
 *   - { slot_id, quantity } — retrieve from one exact, hand-picked slot
 *     (slot detail panel, demo order). FEFO within that slot only.
 *   - { gtin, quantity, excluded_slot_ids } — retrieve a product without
 *     specifying a slot (Warenausgabe tab); the backend picks the slot(s)
 *     itself: FEFO first, then smallest-current-quantity slot first,
 *     spilling into further slots as needed.
 *
 * @param {object} params
 * @param {number} [params.slot_id]
 * @param {string} [params.gtin]
 * @param {number} params.quantity — how many units to take
 * @param {number[]} [params.excluded_slot_ids] — slots to skip (only used
 *   in gtin mode; slot mode's reachability is checked by the caller)
 */
export async function retrieveStock({ slot_id, gtin, quantity, excluded_slot_ids }) {
  const res = await fetch(`${API}/retrieve.php`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ slot_id, gtin, quantity, excluded_slot_ids }),
  });
  const data = await res.json();
  if (!res.ok) throw data;
  return data;
}

/**
 * Load all batches currently stored in a single slot, ordered FEFO.
 * Called on demand when the user clicks a slot — not part of the bulk
 * inventory load so the canvas stays fast.
 *
 * @param {number} slotId
 * @returns {Promise<Array>}
 */
export async function loadSlotBatches(slotId) {
  const res = await fetch(`${API}/slot_batches.php?slot_id=${encodeURIComponent(slotId)}`);
  if (!res.ok) throw new Error(`slot_batches.php returned ${res.status}`);
  const rows = await res.json();
  return rows.map(r => ({
    stock_id:     parseInt(r.stock_id),
    batch_id:     parseInt(r.batch_id),
    batch_ref:    r.batch_ref    ?? null,
    best_before:  r.best_before  ?? null,
    received_at:  r.received_at,
    quantity:     parseInt(r.quantity),
    product_name: r.product_name,
  }));
}

/**
 * Load all in-stock batches expiring within the next N days.
 * Includes already-expired items (days_remaining may be negative).
 * Sorted soonest-expiry first.
 *
 * @param {number} daysAhead
 * @returns {Promise<Array>}
 */
export async function loadExpiryAlerts(daysAhead = 30) {
  const res = await fetch(`${API}/expiry.php?days=${encodeURIComponent(daysAhead)}`);
  if (!res.ok) throw new Error(`expiry.php returned ${res.status}`);
  const rows = await res.json();
  return rows.map(r => ({
    product_name:   r.product_name,
    slot_label:     r.slot_label,
    batch_ref:      r.batch_ref ?? null,
    best_before:    r.best_before,
    quantity:       parseInt(r.quantity),
    days_remaining: parseInt(r.days_remaining),
  }));
}

export function computeAlerts(inventory, products) {
  const totals = {};
  for (const slot of inventory) {
    if (!slot.product_name || slot.quantity === null) continue;
    totals[slot.product_name] = (totals[slot.product_name] ?? 0) + slot.quantity;
  }

  const alerts = [];
  for (const product of products) {
    const qty = totals[product.name] ?? 0;
    if (qty <= product.reorder_level) {
      alerts.push({ product, currentQty: qty, type: 'reorder' });
    } else if (qty >= product.max_quantity) {
      alerts.push({ product, currentQty: qty, type: 'full' });
    }
  }

  alerts.sort((a, b) => (a.type === 'reorder' ? -1 : 1));
  return alerts;
}
