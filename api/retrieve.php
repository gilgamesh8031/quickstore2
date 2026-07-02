<?php
/**
 * retrieve.php
 * Retrieves stock from the warehouse — two modes:
 *
 *   1. By product (gtin) — used by the Warenausgabe tab. The caller only
 *      picks a product and a quantity; this endpoint decides which slot(s)
 *      to draw from, in this order:
 *        a. FEFO — earliest best_before first, across every slot that
 *           currently holds this product.
 *        b. Among candidates with the same priority so far, prefer the
 *           slot with the SMALLEST current quantity, to fully empty small
 *           shelves first and free them up for other products.
 *        c. If one slot doesn't have enough on its own, the remainder is
 *           drawn from the next slot(s) in that same order.
 *      If the total reachable stock for this product is less than the
 *      requested quantity, the whole request is rejected up front — no
 *      partial retrieval, nothing written to the DB.
 *
 *   2. By slot (slot_id) — used by the slot detail panel and the demo
 *      order feature, where the target slot is hand-picked by the user (or
 *      already resolved to one specific slot elsewhere). Consumption
 *      within that slot is FEFO across its own batches. Unchanged.
 *
 * Mode 1 respects `excluded_slot_ids` — slots the robot currently can't
 * path to (obstacles) — the same way receive.php does for deliveries, so
 * a product-based retrieval never targets a slot the robot can't reach.
 * Mode 2 deliberately does NOT apply this: the caller already picked that
 * exact slot, and reachability for it is checked client-side before this
 * endpoint is ever called.
 */
header('Content-Type: application/json');
require_once 'config.php';

$input = json_decode(file_get_contents('php://input'), true);

// ── Modus 1: Produktbasierte Entnahme (Warenausgabe-Tab) ────────────────────

if (!empty($input['gtin'])) {
    $gtin = $input['gtin'];

    $stmt = $pdo->prepare('SELECT * FROM products WHERE gtin = ?');
    $stmt->execute([$gtin]);
    $product = $stmt->fetch(PDO::FETCH_ASSOC);

    if (!$product) {
        http_response_code(404);
        echo json_encode(['error' => 'Produkt nicht gefunden']);
        exit;
    }

    $quantityToRetrieve = isset($input['quantity']) ? (int)$input['quantity'] : 0;
    if ($quantityToRetrieve < 1) {
        http_response_code(400);
        echo json_encode(['error' => 'Entnahmemenge muss mindestens 1 betragen']);
        exit;
    }

    $excludedSlotIds = [];
    if (!empty($input['excluded_slot_ids']) && is_array($input['excluded_slot_ids'])) {
        $excludedSlotIds = array_values(array_unique(array_map('intval', $input['excluded_slot_ids'])));
    }
    $excludeClause = '';
    $excludeParams = [];
    if (!empty($excludedSlotIds)) {
        $placeholders  = implode(',', array_fill(0, count($excludedSlotIds), '?'));
        $excludeClause = "AND st.slot_id NOT IN ($placeholders)";
        $excludeParams = $excludedSlotIds;
    }

    // Every stock row of this product, across every slot, each tagged with
    // its slot's TOTAL quantity of this product — that total is what "closest
    // to 0" is measured against.
    $stmt = $pdo->prepare("
        SELECT
            st.id AS stock_id,
            st.slot_id,
            sl.label AS slot_label,
            st.quantity,
            b.best_before,
            b.received_at,
            slot_totals.slot_total
        FROM   stock   st
        JOIN   batches b  ON b.id  = st.batch_id
        JOIN   slots   sl ON sl.id = st.slot_id
        JOIN (
            SELECT st2.slot_id, SUM(st2.quantity) AS slot_total
            FROM   stock   st2
            JOIN   batches b2 ON b2.id = st2.batch_id
            WHERE  b2.product_id = ?
            GROUP BY st2.slot_id
        ) AS slot_totals ON slot_totals.slot_id = st.slot_id
        WHERE  b.product_id = ?
          $excludeClause
        ORDER BY
            CASE WHEN b.best_before IS NULL THEN 1 ELSE 0 END,
            b.best_before           ASC,
            slot_totals.slot_total  ASC,
            b.received_at           ASC
    ");
    $stmt->execute(array_merge([$product['id'], $product['id']], $excludeParams));
    $candidates = $stmt->fetchAll(PDO::FETCH_ASSOC);

    $totalAvailable = array_sum(array_column($candidates, 'quantity'));

    if ($totalAvailable < $quantityToRetrieve) {
        http_response_code(409);
        echo json_encode([
            'error' => $totalAvailable > 0
                ? "Nicht genügend erreichbarer Bestand: nur {$totalAvailable} von {$quantityToRetrieve} Einheiten {$product['name']} verfügbar."
                : "Kein erreichbarer Bestand von {$product['name']} verfügbar.",
            'error_type' => 'insufficient_stock',
        ]);
        exit;
    }

    // Plan the consumption (FEFO, then smallest-slot-first, spilling across
    // slots as needed) before writing anything, and aggregate it per slot —
    // several batch-rows in the same slot only need ONE robot stop.
    $remaining      = $quantityToRetrieve;
    $stockUpdates   = [];
    $allocationPlan = [];
    $slotIndex      = [];

    foreach ($candidates as $row) {
        if ($remaining <= 0) break;
        $take = min((int)$row['quantity'], $remaining);
        if ($take <= 0) continue;

        $stockUpdates[] = [
            'stock_id'     => (int)$row['stock_id'],
            'take'         => $take,
            'row_quantity' => (int)$row['quantity'],
        ];

        $slotId = (int)$row['slot_id'];
        if (!isset($slotIndex[$slotId])) {
            $slotIndex[$slotId] = count($allocationPlan);
            $allocationPlan[]   = [
                'slot_id'    => $slotId,
                'slot_label' => $row['slot_label'],
                'quantity'   => 0,
            ];
        }
        $allocationPlan[$slotIndex[$slotId]]['quantity'] += $take;

        $remaining -= $take;
    }

    try {
        $pdo->beginTransaction();

        $delStmt = $pdo->prepare('DELETE FROM stock WHERE id = ?');
        $updStmt = $pdo->prepare('UPDATE stock SET quantity = quantity - ? WHERE id = ?');

        foreach ($stockUpdates as $u) {
            if ($u['take'] >= $u['row_quantity']) {
                $delStmt->execute([$u['stock_id']]);
            } else {
                $updStmt->execute([$u['take'], $u['stock_id']]);
            }
        }

        $pdo->commit();

        echo json_encode([
            'success'            => true,
            'product_name'       => $product['name'],
            'quantity_retrieved' => $quantityToRetrieve,
            'allocations'        => $allocationPlan,
        ]);

    } catch (Exception $e) {
        $pdo->rollBack();
        http_response_code(500);
        echo json_encode(['error' => 'Datenbankfehler: ' . $e->getMessage()]);
    }

    exit;
}

// ── Modus 2: Stellplatzbasierte Entnahme (Detailansicht, Demo-Bestellung) ───
// Unverändert — der Ziel-Stellplatz wird vom Aufrufer bereits exakt vorgegeben.

if (empty($input['slot_id'])) {
    http_response_code(400);
    echo json_encode(['error' => 'gtin oder slot_id ist erforderlich']);
    exit;
}

$slotId = (int)$input['slot_id'];

// Fetch ALL stock entries for this slot, ordered by FEFO then FIFO.
// Items with a best_before date are consumed earliest-expiry-first.
// Items without a date (ambient) are consumed in receipt order.
$stmt = $pdo->prepare('
    SELECT st.id, st.quantity, b.best_before, b.received_at
    FROM   stock   st
    JOIN   batches b ON b.id = st.batch_id
    WHERE  st.slot_id = ?
    ORDER BY
        CASE WHEN b.best_before IS NULL THEN 1 ELSE 0 END,
        b.best_before   ASC,
        b.received_at   ASC
');
$stmt->execute([$slotId]);
$stocks = $stmt->fetchAll(PDO::FETCH_ASSOC);

if (empty($stocks)) {
    http_response_code(404);
    echo json_encode(['error' => 'Kein Bestand in diesem Stellplatz']);
    exit;
}

$totalQty = array_sum(array_column($stocks, 'quantity'));

// If quantity not specified, retrieve everything
$quantityToRetrieve = isset($input['quantity'])
    ? (int)$input['quantity']
    : $totalQty;

if ($quantityToRetrieve < 1) {
    http_response_code(400);
    echo json_encode(['error' => 'Entnahmemenge muss mindestens 1 betragen']);
    exit;
}

if ($quantityToRetrieve > $totalQty) {
    http_response_code(400);
    echo json_encode(['error' => "Angeforderte Menge ({$quantityToRetrieve}) übersteigt verfügbaren Bestand ({$totalQty})"]);
    exit;
}

try {
    $pdo->beginTransaction();

    // Consume batches FEFO-first until the requested quantity is fulfilled
    $remaining = $quantityToRetrieve;
    foreach ($stocks as $stock) {
        if ($remaining <= 0) break;

        if ($remaining >= $stock['quantity']) {
            // Entire batch consumed — remove stock row
            $stmt = $pdo->prepare('DELETE FROM stock WHERE id = ?');
            $stmt->execute([$stock['id']]);
            $remaining -= $stock['quantity'];
        } else {
            // Partial batch — decrement quantity
            $stmt = $pdo->prepare('UPDATE stock SET quantity = quantity - ? WHERE id = ?');
            $stmt->execute([$remaining, $stock['id']]);
            $remaining = 0;
        }
    }

    $pdo->commit();

    echo json_encode([
        'success'            => true,
        'slot_id'            => $slotId,
        'quantity_retrieved' => $quantityToRetrieve,
        'quantity_remaining' => $totalQty - $quantityToRetrieve,
    ]);

} catch (Exception $e) {
    $pdo->rollBack();
    http_response_code(500);
    echo json_encode(['error' => 'Datenbankfehler: ' . $e->getMessage()]);
}
