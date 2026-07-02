<?php
/**
 * expiry.php
 * Returns every in-stock batch whose best_before date falls within
 * the next N days (default 30), including already-expired items.
 * Results are ordered soonest-expiry first.
 *
 * GET /api/expiry.php
 * GET /api/expiry.php?days=14
 */
header('Content-Type: application/json');
require_once 'config.php';

$days = max(1, (int)($_GET['days'] ?? 30));

$stmt = $pdo->prepare('
    SELECT
      p.name                                    AS product_name,
      sl.label                                  AS slot_label,
      b.batch_ref,
      b.best_before,
      st.quantity,
      DATEDIFF(b.best_before, CURDATE())        AS days_remaining
    FROM  stock    st
    JOIN  batches  b  ON b.id  = st.batch_id
    JOIN  products p  ON p.id  = b.product_id
    JOIN  slots    sl ON sl.id = st.slot_id
    WHERE b.best_before IS NOT NULL
      AND b.best_before <= DATE_ADD(CURDATE(), INTERVAL ? DAY)
    ORDER BY b.best_before ASC, sl.label ASC
');
$stmt->execute([$days]);

echo json_encode($stmt->fetchAll(PDO::FETCH_ASSOC));
