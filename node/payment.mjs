// Node.js 20+; server-side only. 服务端运行。
// Default: read invoice list. --create creates one invoice; no automatic retries.
const base = "https://api.jangopay.org";
async function request(path, method, headers, body) {
  const response = await fetch(base + path, {
    method, headers: { Accept: "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  });
  const data = await response.json();
  if (!response.ok || data.success === false || (data.code !== undefined && data.code !== "0000")) {
    throw new Error("JangoPay request failed; HTTP " + response.status);
  }
  return data;
}
async function main() {
  const key = process.env.JANGOPAY_API_KEY;
  if (!key || !key.startsWith("JangoPay_")) throw new Error("Set JANGOPAY_API_KEY");
  const tokens = await request("/api/v1/auth/apikey/token", "POST",
    { Authorization: "Basic " + key, "Content-Type": "application/json" }, {});
  const token = tokens.data?.accessToken;
  if (typeof token !== "string" || !token) throw new Error("Missing access token");
  const headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
  if (process.argv.includes("--create")) {
    const orderId = process.env.JANGOPAY_ORDER_ID;
    const amount = process.env.JANGOPAY_AMOUNT;
    const asset = process.env.JANGOPAY_ALLOWED_ASSET;
    if (!orderId || !amount || !asset || !/^\d+(\.\d+)?$/.test(amount) || !asset.includes(":")) {
      throw new Error("Set JANGOPAY_ORDER_ID, JANGOPAY_AMOUNT and JANGOPAY_ALLOWED_ASSET");
    }
    const data = await request("/api/v1/invoice/create", "POST", headers, {
      currencyCode: "USD", amount, orderId, allowedCurrency: [asset],
      coverPct: 100, mixPay: false, autoToU: false, autoWithdraw: false,
    });
    if (!data.invoice?.invoiceId) throw new Error("Missing invoice ID");
    console.log("invoiceId:", data.invoice.invoiceId);
    // Persist the local order/invoice mapping in your application's database.
  } else {
    const data = await request("/api/v1/invoice/list?page=1&pageSize=20", "GET", headers);
    if (!Array.isArray(data.invoices)) throw new Error("Unexpected invoice list");
    console.log("invoiceCount:", data.invoices.length);
  }
}
main().catch(() => {
  console.error("Request failed. Check configuration, permissions and redacted server logs.");
  process.exitCode = 1;
});
