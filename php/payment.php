<?php
// PHP 8.1+ with cURL; server-side only. 服务端运行。
// Default: list invoices. --create creates one invoice; no automatic retries.
function requestApi(string $path, string $method, string $authorization, ?array $body = null): array {
    $handle = curl_init('https://api.jangopay.org' . $path);
    $headers = ['Accept: application/json', 'Authorization: ' . $authorization];
    if ($body !== null) $headers[] = 'Content-Type: application/json';
    curl_setopt_array($handle, [
        CURLOPT_CUSTOMREQUEST => $method, CURLOPT_HTTPHEADER => $headers,
        CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 15,
        CURLOPT_FOLLOWLOCATION => false,
    ]);
    if ($body !== null) curl_setopt($handle, CURLOPT_POSTFIELDS, json_encode($body, JSON_THROW_ON_ERROR));
    $response = curl_exec($handle);
    $status = curl_getinfo($handle, CURLINFO_HTTP_CODE);
    curl_close($handle);
    if ($response === false || $status < 200 || $status >= 300) throw new RuntimeException('HTTP error');
    $data = json_decode($response, true, 512, JSON_THROW_ON_ERROR);
    if (!is_array($data) || ($data['success'] ?? null) === false
        || (array_key_exists('code', $data) && $data['code'] !== '0000')) throw new RuntimeException('API error');
    return $data;
}
try {
    $key = getenv('JANGOPAY_API_KEY') ?: '';
    if (!str_starts_with($key, 'JangoPay_')) throw new RuntimeException('Set API Key');
    $tokens = requestApi('/api/v1/auth/apikey/token', 'POST', 'Basic ' . $key);
    $token = $tokens['data']['accessToken'] ?? '';
    if (!is_string($token) || $token === '') throw new RuntimeException('Missing token');
    if (in_array('--create', $argv, true)) {
        $orderId = getenv('JANGOPAY_ORDER_ID') ?: '';
        $amount = getenv('JANGOPAY_AMOUNT') ?: '';
        $asset = getenv('JANGOPAY_ALLOWED_ASSET') ?: '';
        if (!$orderId || !preg_match('/^\d+(\.\d+)?$/D', $amount) || !str_contains($asset, ':')) {
            throw new RuntimeException('Set order ID, USD amount and asset/network pair');
        }
        $data = requestApi('/api/v1/invoice/create', 'POST', 'Bearer ' . $token, [
            'currencyCode' => 'USD', 'amount' => $amount, 'orderId' => $orderId,
            'allowedCurrency' => [$asset], 'coverPct' => 100, 'mixPay' => false,
            'autoToU' => false, 'autoWithdraw' => false,
        ]);
        $invoiceId = $data['invoice']['invoiceId'] ?? '';
        if (!$invoiceId) throw new RuntimeException('Missing invoice ID');
        echo 'invoiceId: ' . $invoiceId . PHP_EOL;
        // Persist the order/invoice mapping in the application's database.
    } else {
        $data = requestApi('/api/v1/invoice/list?page=1&pageSize=20', 'GET', 'Bearer ' . $token);
        if (!isset($data['invoices']) || !is_array($data['invoices'])) throw new RuntimeException('Unexpected response');
        echo 'invoiceCount: ' . count($data['invoices']) . PHP_EOL;
    }
} catch (Throwable $error) {
    fwrite(STDERR, "Request failed. Check configuration, permissions and redacted logs.\n");
    exit(1);
}
