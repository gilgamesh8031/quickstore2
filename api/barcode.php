<?php
header('Content-Type: application/json');
require_once 'config.php';

if (empty($_GET['gtin'])) {
    http_response_code(400);
    echo json_encode(['error' => 'gtin parameter is required']);
    exit;
}

$stmt = $pdo->prepare('SELECT * FROM products WHERE gtin = ?');
$stmt->execute([$_GET['gtin']]);
$product = $stmt->fetch(PDO::FETCH_ASSOC);

if (!$product) {
    http_response_code(404);
    echo json_encode(['error' => 'Product not found']);
    exit;
}

echo json_encode($product);
