"""Python 3.10+; server-side only. 服务端运行。
Default: list invoices. --create creates one invoice without automatic retries.
"""
import json
import os
import re
import sys
from urllib.request import Request, build_opener, HTTPRedirectHandler

BASE = "https://api.jangopay.org"

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def request(path, method, authorization, body=None):
    headers = {"Accept": "application/json", "Authorization": authorization}
    payload = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        payload = json.dumps(body).encode("utf-8")
    req = Request(BASE + path, data=payload, headers=headers, method=method)
    with build_opener(NoRedirect()).open(req, timeout=15) as response:
        data = json.load(response)
    if data.get("success") is False or ("code" in data and data["code"] != "0000"):
        raise RuntimeError("API rejected request")
    return data

def main():
    key = os.environ.get("JANGOPAY_API_KEY", "")
    if not key.startswith("JangoPay_"):
        raise ValueError("Set JANGOPAY_API_KEY")
    tokens = request("/api/v1/auth/apikey/token", "POST", "Basic " + key, {})
    token = tokens.get("data", {}).get("accessToken")
    if not isinstance(token, str) or not token:
        raise RuntimeError("Missing access token")
    authorization = "Bearer " + token
    if "--create" in sys.argv:
        order_id = os.environ.get("JANGOPAY_ORDER_ID")
        amount = os.environ.get("JANGOPAY_AMOUNT", "")
        asset = os.environ.get("JANGOPAY_ALLOWED_ASSET", "")
        if not order_id or not re.fullmatch(r"\d+(\.\d+)?", amount) or ":" not in asset:
            raise ValueError("Set order ID, USD amount and asset/network pair")
        result = request("/api/v1/invoice/create", "POST", authorization, {
            "currencyCode": "USD", "amount": amount, "orderId": order_id,
            "allowedCurrency": [asset], "coverPct": 100, "mixPay": False,
            "autoToU": False, "autoWithdraw": False,
        })
        invoice_id = result.get("invoice", {}).get("invoiceId")
        if not invoice_id:
            raise RuntimeError("Missing invoice ID")
        print("invoiceId:", invoice_id)
        # Persist the order/invoice mapping in the application's database.
    else:
        result = request("/api/v1/invoice/list?page=1&pageSize=20", "GET", authorization)
        invoices = result.get("invoices")
        if not isinstance(invoices, list):
            raise RuntimeError("Unexpected invoice list")
        print("invoiceCount:", len(invoices))

if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("Request failed. Check configuration, permissions and redacted logs.", file=sys.stderr)
        sys.exit(1)
