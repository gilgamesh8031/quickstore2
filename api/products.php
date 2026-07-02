<?php
header('Content-Type: application/json');
require_once 'config.php';

$stmt = $pdo->query('SELECT * FROM products');
$items = $stmt->fetchAll(PDO::FETCH_ASSOC);

echo json_encode($items);
