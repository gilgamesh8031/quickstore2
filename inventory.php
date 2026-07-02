<?php
/**
 * inventory.php
 * Returns all slots with their current aggregate stock.
 * Uses GROUP BY so that a slot holding multiple batches of the same
 * product shows as a single row (total quantity, earliest MHD).
 */
header('Content-Type: application/json');
require_once 'config.php';

$stmt = $pdo->query('
    SELECT
      sl.id,
      sl.label,
      sl.row_num,
      sl.col_num,
      sl.storage_type,
      sl.temp_celsius,
      MAX(p.name)            AS product_name,
      MIN(b.best_before)     AS best_before,
      COALESCE(SUM(st.quantity), NULL) AS quantity
    FROM slots sl
    LEFT JOIN stock   st ON st.slot_id  = sl.id
    LEFT JOIN batches b  ON b.id        = st.batch_id
    LEFT JOIN products p ON p.id        = b.product_id
    GROUP BY sl.id, sl.label, sl.row_num, sl.col_num, sl.storage_type, sl.temp_celsius
    ORDER BY sl.row_num, sl.col_num
');

echo json_encode($stmt->fetchAll(PDO::FETCH_ASSOC));
