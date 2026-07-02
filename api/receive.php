<?php
/**
 * receive.php
 * Stores a delivery into the warehouse.
 *
 * Every slot has a fixed capacity ($slotCapacity, 100 units). When no
 * explicit slot_id is given, the delivery is allocated across as many
 * slots as it takes to fit:
 *   1. Top up any slot(s) already holding this product first (fullest first,
 *      to minimise fragmentation), up to their remaining capacity.
 *   2. Spill any remainder into empty slots of the correct storage type,
 *      one per 100 units.
 *   3. If the total available capacity across all eligible, reachable
 *      slots is less than the requested quantity, the whole delivery is
 *      rejected up front with a 409 — nothing is written to the DB, and
 *      the frontend is told exactly how much (if anything) could actually
 *      be placed.
 *
 * If the caller passes an explicit slot_id (used by the slot-panel
 * "Einlagern" flow, where the user already picked an exact empty slot on
 * the canvas), that ONE slot is used directly instead — after validating
 * it matches the product's zone, isn't blocked, isn't already holding a
 * different product, and has enough remaining capacity for the full
 * requested quantity (no splitting in this path, since the user asked for
 * this specific slot).
 *
 * The frontend tracks obstacle placement client-side only (it's a canvas
 * overlay, not DB state), so this endpoint has no idea a slot is currently
 * unreachable unless told. The client passes `excluded_slot_ids` — every
 * slot it currently can't path to — and every slot-selection query and the
 * explicit slot_id check skip/reject them. This guarantees the transaction
 * below never commits stock into a slot the robot can't actually reach.
 *
 * A new batches row is ALWAYS created (each delivery is a distinct lot),
 * even when its stock ends up split across multiple slots — the batch
 * represents one incoming shipment; the stock rows record where it
 * physically landed.
 */
header('Content-Type: application/json');
require_once 'config.php';

// A single slot can hold at most this many units of one product.
$slotCapacity = 100;

// ── Read and validate input ───────────────────────────────────────────────────

$input = json_decode(file_get_contents('php://input'), true);

if (empty($input['gtin']) || empty($input['quantity'])) {
    http_response_code(400);
    echo json_encode(['error' => 'gtin und quantity sind erforderlich']);
    exit;
}

$gtin       = $input['gtin'];
$quantity   = (int)$input['quantity'];
$bestBefore = $input['best_before'] ?? null;
$batchRef   = $input['batch_ref']   ?? null;

$excludedSlotIds = [];
if (!empty($input['excluded_slot_ids']) && is_array($input['excluded_slot_ids'])) {
    $excludedSlotIds = array_values(array_unique(array_map('intval', $input['excluded_slot_ids'])));
}

$explicitSlotId = isset($input['slot_id']) && $input['slot_id'] !== null && $input['slot_id'] !== ''
    ? (int)$input['slot_id']
    : null;

if ($quantity <= 0) {
    http_response_code(400);
    echo json_encode(['error' => 'Menge muss größer als 0 sein']);
    exit;
}

// ── Look up product ───────────────────────────────────────────────────────────

$stmt = $pdo->prepare('SELECT * FROM products WHERE gtin = ?');
$stmt->execute([$gtin]);
$product = $stmt->fetch(PDO::FETCH_ASSOC);

if (!$product) {
    http_response_code(404);
    echo json_encode(['error' => 'Produkt nicht gefunden']);
    exit;
}

// ── Determine required storage type ──────────────────────────────────────────

function requiredStorageType($product) {
    if (!$product['perishable'] || $product['max_temp_celsius'] === null) {
        return 'ambient';
    }
    $t = (float)$product['max_temp_celsius'];
    if ($t <= -10) return 'frozen';
    if ($t <=   5) return 'chilled';
    return 'fresh';
}

$storageType = requiredStorageType($product);

// ── Auto-calculate MHD if not supplied ───────────────────────────────────────
// Every product gets a best_before — ambient goods have long shelf lives.
// Mirrors _calcMHD() in main.js so frontend and backend always agree.

if (empty($bestBefore)) {
    $daysMap = [
        'frozen'  => 365,   // Tiefkühlware   ~1 Jahr
        'chilled' => 10,    // Kühlware        ~10 Tage
        'fresh'   => 5,     // Frische / Obst  ~5 Tage
        'ambient' => 730,   // Trockenware     ~2 Jahre
    ];
    $days       = $daysMap[$storageType] ?? 730;
    $bestBefore = date('Y-m-d', strtotime("+{$days} days"));
}

// ── Build the "exclude blocked slots" SQL fragment ────────────────────────────

$excludeClause = '';
$excludeParams = [];
if (!empty($excludedSlotIds)) {
    $placeholders  = implode(',', array_fill(0, count($excludedSlotIds), '?'));
    $excludeClause = "AND sl.id NOT IN ($placeholders)";
    $excludeParams = $excludedSlotIds;
}

// ── Build the allocation plan: [{slot_id, slot_label, quantity, is_new_slot}, …] ─

$allocationPlan = [];

if ($explicitSlotId !== null) {
    // Caller already picked an exact slot (the slot-panel "Einlagern" flow) —
    // use it directly instead of spreading across multiple slots, but still
    // validate zone, obstacles, occupancy, AND capacity the same way the
    // automatic path would.

    $stmt = $pdo->prepare('SELECT id, label, storage_type FROM slots WHERE id = ?');
    $stmt->execute([$explicitSlotId]);
    $targetSlot = $stmt->fetch(PDO::FETCH_ASSOC);

    if (!$targetSlot) {
        http_response_code(404);
        echo json_encode(['error' => 'Stellplatz nicht gefunden']);
        exit;
    }

    if ($targetSlot['storage_type'] !== $storageType) {
        http_response_code(409);
        echo json_encode([
            'error'      => "{$targetSlot['label']} ist ein {$targetSlot['storage_type']}-Stellplatz — {$product['name']} benötigt aber {$storageType}.",
            'error_type' => 'wrong_zone',
        ]);
        exit;
    }

    if (in_array($explicitSlotId, $excludedSlotIds, true)) {
        http_response_code(409);
        echo json_encode([
            'error'      => "{$targetSlot['label']} ist aktuell durch ein Hindernis blockiert.",
            'error_type' => 'blocked',
        ]);
        exit;
    }

    // What's already in this slot (if anything) — determines both whether a
    // DIFFERENT product blocks it outright, and how much room is left.
    $stmt = $pdo->prepare('
        SELECT b.product_id, SUM(st.quantity) AS qty
        FROM   stock   st
        JOIN   batches b ON b.id = st.batch_id
        WHERE  st.slot_id = ? AND st.quantity > 0
        GROUP BY b.product_id
    ');
    $stmt->execute([$explicitSlotId]);
    $existingRow       = $stmt->fetch(PDO::FETCH_ASSOC);
    $existingProductId = $existingRow ? (int)$existingRow['product_id'] : null;
    $currentQtyInSlot  = $existingRow ? (int)$existingRow['qty'] : 0;

    if ($existingProductId !== null && $existingProductId !== (int)$product['id']) {
        http_response_code(409);
        echo json_encode([
            'error'      => "{$targetSlot['label']} ist bereits mit einem anderen Produkt belegt.",
            'error_type' => 'occupied',
        ]);
        exit;
    }

    $roomLeft = $slotCapacity - $currentQtyInSlot;
    if ($quantity > $roomLeft) {
        http_response_code(409);
        echo json_encode([
            'error'      => $roomLeft > 0
                ? "{$targetSlot['label']} hat nur noch Platz für {$roomLeft} von {$quantity} Stk. (Limit {$slotCapacity} je Stellplatz)."
                : "{$targetSlot['label']} hat bereits die maximale Kapazität von {$slotCapacity} Stk. erreicht.",
            'error_type' => 'no_capacity',
        ]);
        exit;
    }

    $allocationPlan[] = [
        'slot_id'     => (int)$targetSlot['id'],
        'slot_label'  => $targetSlot['label'],
        'quantity'    => $quantity,
        'is_new_slot' => ($existingProductId === null),
    ];

} else {
    // Automatic allocation, potentially spread across multiple slots.

    // Tier 1: slot(s) already holding this product, with room to spare —
    // fullest first, so partially-used slots get topped up before a fresh
    // one is opened (minimises how many slots end up only half-used).
    $stmt = $pdo->prepare("
        SELECT sl.id, sl.label, COALESCE(SUM(st.quantity), 0) AS current_qty
        FROM   slots sl
        JOIN   stock   st ON st.slot_id  = sl.id
        JOIN   batches b  ON b.id        = st.batch_id
        WHERE  b.product_id    = ?
          AND  sl.storage_type = ?
          AND  st.quantity     > 0
          $excludeClause
        GROUP BY sl.id, sl.label
        HAVING current_qty < $slotCapacity
        ORDER BY current_qty DESC
    ");
    $stmt->execute(array_merge([$product['id'], $storageType], $excludeParams));
    $topUpCandidates = $stmt->fetchAll(PDO::FETCH_ASSOC);

    // Tier 2: completely empty slots of the correct storage type, as backup
    // capacity once every existing slot for this product is full.
    $stmt = $pdo->prepare("
        SELECT sl.id, sl.label
        FROM   slots sl
        LEFT JOIN stock st ON st.slot_id = sl.id
        WHERE  sl.storage_type = ?
          AND  st.id IS NULL
          $excludeClause
        ORDER BY sl.id ASC
    ");
    $stmt->execute(array_merge([$storageType], $excludeParams));
    $emptyCandidates = $stmt->fetchAll(PDO::FETCH_ASSOC);

    $remaining = $quantity;

    foreach ($topUpCandidates as $slot) {
        if ($remaining <= 0) break;
        $room = $slotCapacity - (int)$slot['current_qty'];
        $take = min($room, $remaining);
        if ($take <= 0) continue;
        $allocationPlan[] = [
            'slot_id'     => (int)$slot['id'],
            'slot_label'  => $slot['label'],
            'quantity'    => $take,
            'is_new_slot' => false,
        ];
        $remaining -= $take;
    }

    foreach ($emptyCandidates as $slot) {
        if ($remaining <= 0) break;
        $take = min($slotCapacity, $remaining);
        $allocationPlan[] = [
            'slot_id'     => (int)$slot['id'],
            'slot_label'  => $slot['label'],
            'quantity'    => $take,
            'is_new_slot' => true,
        ];
        $remaining -= $take;
    }

    if ($remaining > 0) {
        // Couldn't fully place the delivery anywhere reachable — reject up
        // front. Nothing has been written to the DB at this point.
        $placeable = $quantity - $remaining;
        http_response_code(409);
        echo json_encode([
            'error' => $placeable > 0
                ? "Nicht genügend Kapazität: nur {$placeable} von {$quantity} Einheiten könnten aktuell auf {$storageType}-Stellplätzen untergebracht werden (Limit {$slotCapacity}/Stellplatz)."
                : "Keine Kapazität auf {$storageType}-Stellplätzen verfügbar (alle voll, blockiert oder belegt; Limit {$slotCapacity}/Stellplatz).",
            'error_type' => 'no_capacity',
        ]);
        exit;
    }
}

// ── Insert batch + stock in a transaction ─────────────────────────────────────
// Only reached once a fully-fitting, reachable allocation plan has been
// confirmed above — the DB is never touched for a delivery that couldn't be
// placed in full.

try {
    $pdo->beginTransaction();

    $stmt = $pdo->prepare('
        INSERT INTO batches (product_id, best_before, batch_ref, quantity_total)
        VALUES (?, ?, ?, ?)
    ');
    $stmt->execute([$product['id'], $bestBefore ?: null, $batchRef, $quantity]);
    $batchId = $pdo->lastInsertId();

    $stockStmt = $pdo->prepare('
        INSERT INTO stock (batch_id, slot_id, quantity)
        VALUES (?, ?, ?)
    ');
    foreach ($allocationPlan as $alloc) {
        $stockStmt->execute([$batchId, $alloc['slot_id'], $alloc['quantity']]);
    }

    $pdo->commit();

    $first = $allocationPlan[0];
    echo json_encode([
        'success'      => true,
        'batch_id'     => (int)$batchId,
        'product_name' => $product['name'],
        'storage_type' => $storageType,
        // Top-level fields mirror the pre-split response shape (first
        // allocation) so any caller only reading these still works;
        // 'allocations' carries the full split for multi-slot trips.
        'slot_id'      => $first['slot_id'],
        'slot_label'   => $first['slot_label'],
        'is_new_slot'  => $first['is_new_slot'],
        'allocations'  => $allocationPlan,
    ]);

} catch (Exception $e) {
    $pdo->rollBack();
    http_response_code(500);
    echo json_encode(['error' => 'Datenbankfehler: ' . $e->getMessage()]);
}
