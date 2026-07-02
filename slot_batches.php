<?php
/**
 * slot_batches.php
 * Returns every batch currently in stock for a single slot,
 * ordered FEFO (earliest best_before first, NULL dates last,
 * ties broken by received_at ascending).
 *
 * GET /api/slot_batches.php?slot_id=11
 */
header('Content-Type: application/json');
require_once 'config.php';

if (empty($_GET['slot_id'])) {
    http_response_code(400);
    echo json_encode(['error' => 'slot_id ist erforderlich']);
    exit;
}

$slotId = (int)$_GET['slot_id'];

$stmt = $pdo->prepare('
    SELECT
      st.id          AS stock_id,
      st.quantity,
      b.id           AS batch_id,
      b.batch_ref,
      b.best_before,
      b.received_at,
      p.name         AS product_name
    FROM  stock   st
    JOIN  batches b  ON b.id  = st.batch_id
    JOIN  products p ON p.id  = b.product_id
    WHERE st.slot_id = ?
    ORDER BY
        CASE WHEN b.best_before IS NULL THEN 1 ELSE 0 END,
        b.best_before ASC,
        b.received_at ASC
');
$stmt->execute([$slotId]);

echo json_encode($stmt->fetchAll(PDO::FETCH_ASSOC));
