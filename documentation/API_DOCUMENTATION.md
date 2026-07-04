# User Order Service — API Reference

**Base URL:** `http://localhost:5003` (local) or your deployed domain

This service handles customer checkout/order creation, order lookup, manual bank-transfer
payment capture, the Klyme and AabanPay payment gateways, the wallet/store-credit +
affiliate program, customer auth, anti-fraud tooling (blacklist, fingerprinting,
seal-number verification), product-authenticity crowdsourcing uploads, an AI support
chatbot, and newsletter signup.

Almost every numeric monetary field (`total`, `subtotal`, `amount`, `balance`, `price`,
`unit_price`, etc.) is returned as a **string** (e.g. `"49.99"`), not a JSON number —
this is how the Postgres driver returns `NUMERIC`/`DECIMAL` columns. Booleans stored in
the DB (`promo_valid`, `is_active`, `webhook_received`, `cookies_enabled`, etc.) come back
as **`1` / `0`**, not `true`/`false`. Timestamps are ISO 8601 strings.

---

## Authentication

Two different auth schemes are used in this service.

**1. Customer JWT (`requireUserAuth`)** — used by `/api/wallet`, `/api/affiliate/*`:

```
Authorization: Bearer <token>
```

The token is issued by `POST /api/auth/login` or `POST /api/auth/register` and is valid
for **30 days**. The decoded payload must contain a numeric `id`; `email`/`role` are
carried through as `req.user`.

- Missing header -> `401 { "error": "Missing token" }`
- Malformed/expired/invalid signature -> `401 { "error": "Invalid token" }`


---

## Health

### GET `/health`

**Response `200`:**
```json
{ "ok": true, "service": "user-order-creation", "db": "connected" }
```

**Response `500`** (DB unreachable):
```json
{ "ok": false, "service": "user-order-creation", "db": "disconnected", "error": "..." }
```

---

### GET `/api/user-orders/health`

Identical shape to `GET /health`.

---

### GET `/api/user-orders` 

Explicit guard so clients don't accidentally `GET` the order-creation route.

**Response `405`:**
```json
{
  "ok": false,
  "error": "Method Not Allowed. Use POST /api/user-orders to create an order.",
  "service": "user-order-creation"
}
```
Also sets header `Allow: POST`.

---

## Auth

### POST `/api/auth/register`

Registers a new user, **or silently upserts** an existing user found by email (no
"already exists" error — it just updates their record and logs them in).

**Request:**
```json
{
  "name": "Jane Doe",
  "email": "jane@example.com",
  "password": "hunter2",
  "date_of_birth": "1995-06-01",
  "nationality": "British",
  "country_of_residence": "United Kingdom"
}
```
All six fields are required.

**Response `201`:**
```json
{
  "success": true,
  "token": "<jwt>",
  "user": {
    "id": 1,
    "name": "Jane Doe",
    "email": "jane@example.com",
    "phone": null,
    "date_of_birth": "1995-06-01",
    "nationality": "British",
    "country_of_residence": "United Kingdom",
    "role": "user"
  }
}
```

**Errors:** `400` missing `name`/`email`/`password`, or missing `date_of_birth`/`nationality`/`country_of_residence` · `500` on failure

---

### POST `/api/auth/login`

**Request:**
```json
{ "email": "jane@example.com", "password": "hunter2" }
```

**Response `200`:**
```json
{
  "success": true,
  "token": "<jwt>",
  "user": {
    "id": 1,
    "name": "Jane Doe",
    "email": "jane@example.com",
    "phone": null,
    "date_of_birth": "1995-06-01",
    "nationality": "British",
    "country_of_residence": "United Kingdom",
    "role": "user"
  }
}
```

Token expires in **30 days**.

**Errors:** `400` missing email/password · `401` invalid credentials · `503` `{ "error": "Login temporarily unavailable. Please try again." }` if the DB/bcrypt check times out

---

### GET `/api/auth/verify`

Validates the bearer JWT and returns the current user's profile (used to hydrate
session state on page load). Requires `Authorization: Bearer <token>` (checked inline,
not via `requireUserAuth`, but same format/errors).

**Response `200`:**
```json
{
  "success": true,
  "user": {
    "id": 1,
    "name": "Jane Doe",
    "email": "jane@example.com",
    "phone": null,
    "date_of_birth": "1995-06-01",
    "nationality": "British",
    "country_of_residence": "United Kingdom",
    "role": "user"
  }
}
```

**Errors:** `401` missing/invalid token, user not found, or email in token no longer matches the user record

---

### POST `/api/auth/forgot-password`

**Request:** `{ "email": "jane@example.com" }`

Always returns success even if the email doesn't exist (no account enumeration). Sends
a reset link (valid 1 hour) via Gmail SMTP if the account exists.

**Response `200`:**
```json
{ "success": true, "message": "Password reset link has been sent to your email." }
```
or, if the email doesn't match any account:
```json
{ "success": true, "message": "If an account exists with this email, a password reset link has been sent." }
```

**Errors:** `400` missing email · `500` on send failure

---

### POST `/api/auth/reset-password`

**Request:** `{ "token": "<reset-token-from-email-link>", "password": "newpassword123" }`

**Response `200`:**
```json
{ "success": true, "message": "Password has been reset successfully" }
```

**Errors:** `400` missing token/password · `400` password under 6 characters · `400` `{ "error": "Invalid or expired reset token" }`

---

## Wallet & Affiliate

### GET `/api/wallet` (+ `/api/auth/wallet`, `/api/user-orders/wallet`)

Auth: `requireUserAuth`

Returns the user's store-credit balance and their last 50 `credit_ledger` entries.

**Response `200`:**
```json
{
  "success": true,
  "balance": 40,
  "ledger": [
    {
      "amount": 40,
      "source": "affiliate_reward",
      "order_number": "ORD-20250101-120000000-ABC123",
      "admin_username": null,
      "note": null,
      "created_at": "2025-01-01T12:00:00.000Z"
    }
  ]
}
```
`amount`/`balance` here are JS numbers (explicitly `Number(...)`-cast in code), unlike
most other money fields in this service.

**Errors:** `401` missing/invalid token · `500` on failure

---

### POST `/api/promos/validate` (+ `/api/auth/promos/validate`)

Public — no auth. Validates a promo code before order submission. Checks a hardcoded
static map (`SAVE10`, `PETER10`, `DAVID10` -> 10% off) first, then the `promo_codes` table.

**Request:** `{ "code": "SAVE10" }` (also accepts `promoCode` as the key)

**Response `200`:**
```json
{ "ok": true, "valid": true, "percent": 10 }
```

**Errors:** `400` `{ "ok": false, "error": "code is required" }` · `404` `{ "ok": false, "valid": false }` if invalid/inactive · `500` on failure

---

### GET `/api/affiliate/status` (+ `/api/auth/affiliate/status`)

Auth: `requireUserAuth`

**Response `200`** (no request yet):
```json
{ "ok": true, "hasRequest": false }
```

**Response `200`** (request exists):
```json
{
  "ok": true,
  "hasRequest": true,
  "request": {
    "id": 1,
    "status": "approved",
    "promo_code": "AJANE10",
    "promo_percent": 10,
    "created_at": "2025-01-01T12:00:00.000Z",
    "decided_at": "2025-01-01T12:00:00.000Z"
  }
}
```

**Errors:** `401` missing/invalid token · `500` on failure

---

### POST `/api/affiliate/request` (+ `/api/auth/affiliate/request`)

Auth: `requireUserAuth`

Self-serve affiliate signup — **auto-approves** immediately (default 10% discount / £40
reward), generates a unique promo code, sends a welcome email. Idempotent: calling again
after already requesting just returns the existing state.

**Request:**
```json
{
  "first_name": "Jane",
  "last_name": "Doe",
  "tiktok_link": "https://tiktok.com/@jane"
}
```
`tiktok_link` must contain `tiktok.com` or start with `@`.

**Response `200`** (newly approved):
```json
{
  "ok": true,
  "approved": true,
  "status": "approved",
  "promo_code": "AJANE10",
  "promo_percent": 10,
  "reward_amount": 40
}
```

**Response `200`** (already requested previously):
```json
{
  "ok": true,
  "alreadyRequested": true,
  "status": "approved",
  "promo_code": "AJANE10",
  "promo_percent": 10,
  "reward_amount": 40
}
```

**Errors:** `401` missing/invalid token · `400` missing user email on token, missing `first_name`/`last_name`/`tiktok_link`, or invalid TikTok link format · `500` on failure

---

### GET `/api/affiliate/dashboard` (+ `/api/auth/affiliate/dashboard`)

Auth: `requireUserAuth`

**Response `200`** (not an affiliate):
```json
{ "ok": true, "is_affiliate": false }
```

**Response `200`** (is an affiliate):
```json
{
  "ok": true,
  "is_affiliate": true,
  "promo_code": "AJANE10",
  "promo_percent": 10,
  "reward_amount": 40,
  "status": "approved",
  "first_name": "Jane",
  "last_name": "Doe",
  "tiktok_link": "https://tiktok.com/@jane",
  "wallet_balance": 40,
  "total_earned": 40,
  "unique_customers": 1,
  "recent_redemptions": [
    {
      "order_number": "ORD-20250101-120000000-ABC123",
      "customer_email_masked": "j***@example.com",
      "reward_amount": 40,
      "created_at": "2025-01-01T12:00:00.000Z"
    }
  ]
}
```
`status` can also be `"revoked"` if the affiliate's promo code was deactivated.
`recent_redemptions` is capped at the 10 most recent, with customer emails masked.

**Errors:** `401` missing/invalid token · `500` on failure

---

## Products

### POST `/api/products/klyme-status`

Public — no auth. Bulk-checks which products are Klyme (BNPL)-enabled, by numeric/string product ID.

**Request:** `{ "product_ids": [1, 2, 3] }`

**Response `200`:**
```json
{ "klyme_settings": { "1": false, "2": false, "3": true } }
```
Response is an **object keyed by the ID string you sent**, not an array. A hardcoded
allowlist (e.g. `retatrutide-20mg`, `glow-70mg`) force-enables Klyme regardless of the
DB value. IDs with no `product_config` row default to `false`.

**Errors:** `400` `{ "error": "Product IDs array is required" }` if missing/empty · `500` on failure

---

### POST `/api/products/klyme-status-by-sku`

Same behavior, keyed by SKU (uppercased).

**Request:** `{ "product_skus": ["SKU-001", "SKU-002"] }`

**Response `200`:**
```json
{ "klyme_settings": { "SKU-001": false, "SKU-002": false } }
```

**Errors:** `400` `{ "error": "Product SKUs array is required" }` · `500` on failure

---

### POST `/api/products/klyme-status-by-name`

Same behavior, keyed by lowercased/whitespace-normalized product name.

**Request:** `{ "product_names": ["Retatrutide 20mg"] }`

**Response `200`:**
```json
{ "klyme_settings": { "retatrutide 20mg": true } }
```

**Errors:** `400` `{ "error": "Product names array is required" }` · `500` on failure

---

## Orders

### POST `/api/user-orders` (+ `/api/user-orders/`)

**The primary checkout endpoint.** Accepts `application/json` or
`multipart/form-data` (optional file field `paymentScreenshot`). Runs the whole
order-creation transaction, then — unless the order routes through Klyme or another
payment processor — creates a payment-capture link/token and fires order-confirmation +
payment-reminder emails (non-fatal on email failure).

**Request** (JSON body — all of these are read; only `email` is strictly required, everything else has fallbacks/defaults):
```json
{
  "email": "jane@example.com",
  "firstName": "Jane",
  "lastName": "Doe",
  "customerName": "Jane Doe",
  "phone": "+441234567890",
  "address": "123 Main St",
  "city": "London",
  "postcode": "SW1A 1AA",
  "country": "United Kingdom",
  "orderId": "",
  "promoCode": "SAVE10",
  "promoDiscount": 10,
  "subtotal": 99.99,
  "discountAmount": 10.00,
  "total": 89.99,
  "createdAtIso": "2025-01-01T12:00:00.000Z",
  "items": [
    {
      "productId": 1,
      "name": "Product A",
      "sku": "SKU-001",
      "quantity": 2,
      "unitPrice": 44.99
    }
  ],
  "paymentMethod": "manual"
}
```

Notes on field aliasing (the code accepts either name):
- `email` or `customerEmail`
- `phone` or `customerPhone`
- `address`/`shippingAddress`, `city`/`shippingCity`, `postcode`/`shippingZip`, `country`/`shippingCountry`
- `orderId` or `orderNumber` — if provided and unused by another customer, it's kept; otherwise a new one is generated (`ORD-YYYYMMDD-HHMMSSmmm-XXXXXX`)
- `promoCode` or `promo_code`; `promoDiscount` or `promo_discount_percent`; `discountAmount` or `discount_amount`
- `items` (or `itemsArray`) — array of `{ productId|product_id|id, name|title, sku|id, quantity, unitPrice|priceNumber|price }`. If omitted, falls back to parsing a legacy pipe-delimited `itemsText` string.
- `payment_method`/`paymentMethod`/`provider`/`payment_provider` — a value of `"manual"` forces the manual/payment-capture flow even if the order would otherwise route through a processor.

**Response `200`:**
```json
{
  "success": true,
  "orderId": "ORD-20250101-120000000-ABC123",
  "orderNumber": "ORD-20250101-120000000-ABC123",
  "email_debug": {
    "paymentLinkCreated": true,
    "orderConfirmation": { "attempted": true, "ok": true, "error": null },
    "paymentCapture": { "attempted": true, "ok": true, "error": null }
  }
}
```
> Despite the field name, `orderId` here is the **order number string**, not a numeric database ID (`out` = `{ orderId, orderNumber }`, both set to the same order-number value).

**Errors:**
- `403` `{ "success": false, "error": "..." }` if the customer's email/address is on the blacklist
- `500` `{ "success": false, "error": "Missing/invalid required field: email" }` if email is missing/invalid — **note this is a 500, not a 400**, because the underlying error is a generic thrown `Error`, not a validated 400 path.
- `500` `{ "success": false, "error": "..." }` for any other failure

*(Verified live: missing `email` -> `500 {"success":false,"error":"Missing/invalid required field: email"}`.)*

---

### GET `/api/user-orders/by-email`

**Query params:** `email` (required)

**Response `200`:**
```json
{ "orders": [ "full orders table rows, newest first, max 200 - see the orders table shape section below" ] }
```

**Errors:** `400` `{ "error": "Valid email is required" }` · `500` on failure

---

### GET `/api/user-orders/:orderNumber`

**Response `200`:**
```json
{
  "order": { "...": "full orders row" },
  "items": [ "...full order_items rows" ],
  "payments": [ "...full payments rows" ]
}
```

**Errors:** `400` missing order number (won't normally trigger via the URL param) · `404` `{ "error": "Order not found" }` · `500` on failure

*(Verified live: unknown order number -> `404 {"error":"Order not found"}`.)*

---

### PUT `/api/user-orders/:orderNumber`

Limited field update — only `status`, `payment_status`, `tracking_number` can be set (whichever keys are present in the body are updated; omitted keys are left alone).

**Request:**
```json
{
  "status": "processing",
  "payment_status": "received",
  "tracking_number": "TRK123456"
}
```

**Response `200`:** `{ "success": true }`

**Errors:** `400` `{ "error": "No updatable fields provided" }` if body has none of the three fields · `404` `{ "error": "Order not found" }` · `500` on failure

---

### DELETE `/api/user-orders/:orderNumber`

**Response `200`:** `{ "success": true }`

**Errors:** `404` `{ "error": "Order not found" }` · `500` on failure

---

### `orders` table shape (referenced by several endpoints above)

```json
{
  "id": 1,
  "order_number": "ORD-20250101-120000000-ABC123",
  "user_id": 1,
  "customer_email": "jane@example.com",
  "customer_name": "Jane Doe",
  "customer_phone": "+441234567890",
  "shipping_address": "123 Main St",
  "shipping_city": "London",
  "shipping_state": null,
  "shipping_zip": "SW1A 1AA",
  "shipping_country": "United Kingdom",
  "tracking_number": null,
  "currency": "GBP",
  "subtotal": "99.99",
  "shipping": "0.00",
  "total": "89.99",
  "status": "pending",
  "payment_status": "pending",
  "payment_method": "Manual",
  "promo_code": "SAVE10",
  "promo_discount": null,
  "discount_amount": "10.00",
  "payment_rejection_reason": null,
  "admin_payment_remark": null,
  "admin_payment_screenshot_filename": null,
  "admin_payment_screenshot_url": null,
  "ibalticx_invoice_sent_at": null,
  "ibalticx_invoice_to": null,
  "ibalticx_invoice_message_id": null,
  "bank_account_used": "ibalticx",
  "created_at": "2025-01-01T12:00:00.000Z",
  "updated_at": "2025-01-01T12:00:00.000Z",
  "total_before_discount": "99.99",
  "total_after_discount": "89.99",
  "promo_discount_percent": "10",
  "promo_valid": 1,
  "items_text": null,
  "payment_screenshot_filename": null,
  "payment_screenshot_url": null,
  "reserved_at": null,
  "submitted_at": null,
  "credits_applied": "0.00",
  "total_before_credits": "89.99",
  "credits_reserved": "0.00"
}
```

### `order_items` row shape

```json
{
  "id": 1,
  "order_id": 1,
  "product_id": 1,
  "name": "Product A",
  "sku": "SKU-001",
  "quantity": 2,
  "unit_price": "44.99",
  "line_total": "89.98"
}
```

### `payments` row shape

```json
{
  "id": 1,
  "order_id": 1,
  "user_id": null,
  "provider": "Manual",
  "provider_id": "ADMIN-ORD-20250101-120000000-ABC123",
  "amount": "89.99",
  "currency": "GBP",
  "status": "pending",
  "webhook_received": 0,
  "final_status": null,
  "status_checked_at": null,
  "bank_name": null,
  "raw_response": null,
  "created_at": "2025-01-01T12:00:00.000Z",
  "updated_at": null
}
```

---

## Payment Capture (manual bank-transfer flow)

Flow: order created -> capture-link email sent -> customer opens link -> validates token ->
(optionally applies a promo) -> uploads bank-transfer screenshot -> external
payment-verification service checks it -> order marked paid/rejected -> emails sent.

### POST `/api/payment-capture/validate`

**Request:** `{ "token": "<token-from-email-link>" }`

**Response `200`:**
```json
{
  "ok": true,
  "order": { "...": "full orders row" },
  "items": [ "...order_items rows" ],
  "payments": [ "...payments rows" ],
  "allowPromo": true,
  "bank": {
    "payeeName": "1066 Detailing Ltd",
    "sortCode": "60-83-82",
    "accountNumber": "46672542",
    "reference": "Beauty"
  }
}
```
`allowPromo` is `false` if the order already has a promo code or contains a
non-discountable "bundle" product.

**Errors:** `400` `{ "ok": false, "error": "token is required" }` / `"Link expired"` / `"Invalid link"` · `404` `{ "ok": false, "error": "Invalid or expired link" }` or `"Order not found"` · `500` on failure

---

### POST `/api/payment-capture/apply-promo`

**Request:** `{ "token": "<token>", "promoCode": "SAVE10" }`

**Response `200`:**
```json
{
  "ok": true,
  "promoCode": "SAVE10",
  "promoDiscountPercent": 10,
  "discountAmount": 10.00,
  "total": 89.99
}
```
(`discountAmount`/`total` here are JS numbers, not strings.)

**Errors:** `400` missing `token`/`promoCode`, `"Invalid promo code"`, `"Promo codes cannot be applied to bundle products"`, `"Promo already applied"`, or an invalid/expired token error · `500` on failure

---

### POST `/api/payment-capture/upload`

`Content-Type: multipart/form-data`

| Field | Required | Type | Notes |
|---|---|---|---|
| `token` | Yes | string | from the email link |
| `paymentScreenshot` | Yes | file | the uploaded screenshot |

Saves the file, emails "screenshot received", then forwards it to the external
payment-verification microservice for OCR-based approve/reject scoring.

**Response `200`** (verification service reachable):
```json
{
  "ok": true,
  "screenshotUrl": "https://yourdomain.com/uploads/JaneDoeORD-20250101-120000000-ABC123.jpg",
  "screenshotFilename": "JaneDoeORD-20250101-120000000-ABC123.jpg",
  "verification": { "...": "raw response body from the payment-verification service" },
  "payment_status": "received"
}
```
`payment_status` is `"received"` (approved) or `"rejected"`.

**Response `200`** (verification service unreachable — fails open):
```json
{
  "ok": true,
  "screenshotUrl": "...",
  "screenshotFilename": "...",
  "verification": null,
  "verification_error": "Verification request failed (503)",
  "payment_status": "pending"
}
```

**Errors:** `400` `{ "ok": false, "error": "token is required" }` or `"paymentScreenshot file is required"` · `400`/`404` from an invalid capture token (same as `/validate`) · `500` on failure

---

## Klyme (BNPL/card payment gateway)

Klyme lifecycle: **create-payment** -> customer redirected to Klyme -> **webhook** (Klyme
calls back, possibly AES-256-CTR encrypted) -> frontend also actively polls
**verify-payment**.

### POST `/api/klyme/create-payment`

**Request:** `{ "orderId": "ORD-20250101-120000000-ABC123", "amount": 89.99, "currency": "GBP" }`
(`currency` optional, defaults to `"GBP"`; `orderId` here is the **order number string**.)

If the customer's store credit fully covers the order, Klyme is skipped entirely and the
order is finalized immediately:

**Response `200`** (paid entirely by credits):
```json
{ "ok": true, "paidByCredits": true, "orderId": "ORD-20250101-120000000-ABC123", "klymeEnv": "production" }
```

**Response `200`** (normal Klyme flow):
```json
{
  "ok": true,
  "paymentUuid": "b3f1...",
  "orderId": "ORD-20250101-120000000-ABC123",
  "klymeEnv": "production"
}
```
The frontend redirects the customer using `paymentUuid` per the Klyme widget/redirect integration.

**Errors:** `500` `{ "ok": false, "error": "Klyme credentials not configured (production)" }` if env vars missing · `400` `{ "ok": false, "error": "Missing required fields: orderId, amount", "klymeEnv": "..." }` · `404` `{ "ok": false, "error": "Order not found", "klymeEnv": "..." }` · `500` on a Klyme API error or unexpected failure (`klymeEnv` included where available)

*(Verified live: missing fields -> `400 {"ok":false,"error":"Missing required fields: orderId, amount","klymeEnv":"production"}`.)*

---

### POST `/api/klyme/webhook`

**Provider-to-server only** — Klyme calls this, the frontend never should. Body shape
varies (may be AES-256-CTR encrypted using `KLYME_WEBHOOK_SECRET`; decrypted internally).
**Always responds `200`**, even on internal error or an unrecognized payload, per Klyme's
retry semantics — do not treat a `200` here as confirmation that anything actually changed.

**Response `200`** (e.g. missing UUID): `{ "ok": true, "ignored": true, "reason": "Missing payment UUID" }`

---

### GET `/api/klyme/verify-payment/:uuid`

Frontend polling/redirect-landing endpoint. Queries Klyme directly as the source of
truth; can reconstruct a missing local session by matching the Klyme reference back to
an order (self-healing against missed webhooks).

**Response `200`:**
```json
{
  "ok": true,
  "session": { "uuid": "b3f1...", "status": "success", "orderId": 1 },
  "payment": { "status": "success", "finalStatus": "ACSP", "amount": "89.99", "currency": "GBP" },
  "klyme": { "...": "raw pass-through from Klyme's own status API - shape not fully pinned down, varies by Klyme response version" }
}
```
`session.status`/`payment.status` are normalized to `"success"` / `"failed"` / `"pending"`.
`payment` is `null` if no local payment row exists yet. **`klyme` is a raw pass-through
of Klyme's API response and its exact shape is not guaranteed by this service** — treat
it as opaque/debug data, don't build UI logic directly on its fields.

**Errors:** `400` `{ "ok": false, "error": "Missing payment UUID" }` · `500` on failure

---

## AabanPay (card payment gateway)

Simpler lifecycle than Klyme — no encryption, no built-in retry/backoff. Restricted to a
specific product allowlist (test product id `32`, `retatrutide-20mg`, `retatrutide-40mg`).

### POST `/api/aabanpay/create-payment` (+ `/api/user-orders/aabanpay/create-payment`)

**Request:**
```json
{
  "orderId": "ORD-20250101-120000000-ABC123",
  "amount": 89.99,
  "currency": "GBP",
  "returnUrl": "https://yourfrontend.com/success",
  "cancelUrl": "https://yourfrontend.com/cancelled"
}
```
`currency` optional (default `GBP`); `returnUrl`/`cancelUrl` optional (default to a `/checkout/aabanpay-callback` URL on `FRONTEND_URL`).

**Response `200`:**
```json
{
  "ok": true,
  "sessionId": "sess_abc123",
  "paymentUrl": "https://aabanpay.example.com/pay/sess_abc123",
  "orderId": "ORD-20250101-120000000-ABC123"
}
```

**Errors:** `500` `{ "ok": false, "error": "AabanPay API key not configured" }` (`AABANPAY_API_KEY` unset) · `400` missing `orderId`/`amount`, or `"Order not eligible for AabanPay"` · `404` `{ "ok": false, "error": "Order not found" }` · `500` on an AabanPay API error or unexpected failure

*(Verified live in this environment — `AABANPAY_API_KEY` is currently unset, so this always returns `500 "AabanPay API key not configured"` regardless of input.)*

---

### POST `/api/aabanpay/webhook` (+ `/api/user-orders/aabanpay/webhook`)

**Provider-to-server only.** Always responds `200`.

---

### GET `/api/aabanpay/verify-payment/:sessionId` (+ `/api/user-orders/aabanpay/verify-payment/:sessionId`)

Frontend polling endpoint; actively queries AabanPay's `/payment/status` and syncs local records.

**Response `200`:**
```json
{
  "ok": true,
  "session": { "sessionId": "sess_abc123", "status": "success", "orderId": 1 },
  "payment": { "status": "success", "finalStatus": "completed" },
  "aabanpay": { "...": "raw pass-through from AabanPay's status API" }
}
```

**Errors:** `400` `{ "ok": false, "error": "Missing session ID" }` · `500` `{ "ok": false, "error": "AabanPay API key not configured" }` · `404` `{ "ok": false, "error": "Payment session not found" }` · `500` on AabanPay API error

---

### POST `/api/user-orders/aabanpay/charge`

Direct card-charge flow (plugin-style — the frontend collects raw card data and sends it
here). **Restricted to the AabanPay test-product flow only.**

**Request:**
```json
{
  "orderId": "ORD-20250101-120000000-ABC123",
  "cardNumber": "4111111111111111",
  "cardType": "visa",
  "expMonth": "12",
  "expYear": "2027",
  "cvv": "123"
}
```
`cardType` must be one of `visa` / `mastercard` / `amex` / `discover`. `expYear` accepts either 2-digit or 4-digit format.

**Response `200`** (approved):
```json
{ "ok": true, "status": "APPROVED", "transactionId": "txn_123", "descriptor": "ALLUVI*ORDER" }
```

**Response `200`** (3DS challenge required):
```json
{ "ok": true, "status": "3DS", "transactionId": "txn_123", "descriptor": "ALLUVI*ORDER", "threeDsUrl": "https://..." }
```

**Response `400`** (declined):
```json
{ "ok": false, "status": "DECLINED", "error": "Insufficient funds", "provider": { "...": "raw AabanPay response" } }
```

**Errors:** `500` `{ "ok": false, "error": "AabanPay API key not configured" }` · `400` missing `orderId` or card fields, invalid `cardType`, `"Order not eligible for AabanPay"`, or a decline · `404` `{ "ok": false, "error": "Order not found" }` · `502` on an unreachable AabanPay API · `500` on unexpected failure

Warning: Card data (`cardNumber`, `cvv`) is sent directly to AabanPay in the request body — never logged, but also never tokenized client-side first. Treat this endpoint as PCI-sensitive.

---

### GET `/api/user-orders/aabanpay/callback`

3DS redirect landing point. **This is not a JSON API — it's a browser redirect.** AabanPay
redirects the customer's browser here after a 3DS challenge; this handler looks up the
transaction, updates order/payment state, then issues an HTTP redirect to one of:
- `{FRONTEND_URL}/payment-completed?order=...&amount=...` (success)
- `{FRONTEND_URL}/payment-review?order=...&amount=...&reason=...` (pending/failed)

**Query params:** `order_id` (required — the order number)

Non-redirect error responses (plain text, not JSON): `400 "Missing order_id"` · `502 "Failed to fetch transaction"` · `404 "Transaction not found"` / `"Order not found"` · `500 "Callback failed"`

---

## Uploads & Product Verification

### GET `/api/user-orders/spot-a-fake/submissions`

Admin listing of counterfeit-report submissions (latest 200).

**Response `200`:**
```json
{
  "submissions": [
    {
      "id": 1,
      "submission_id": "SAF-1735000000000-AB12CD",
      "latitude": 51.5074,
      "longitude": -0.1278,
      "accuracy": 20.5,
      "location_timestamp": 1735000000000,
      "user_agent": "Mozilla/5.0...",
      "image_paths": ["1735000000000-ab12cd.jpg"],
      "ip_address": "1.2.3.4",
      "created_at": "2025-01-01T12:00:00.000Z"
    }
  ]
}
```

**Errors:** `500` `{ "message": "Failed to fetch submissions." }`

---

### POST `/api/user-orders/spot-a-fake/submit`

`Content-Type: multipart/form-data`

| Field | Required | Notes |
|---|---|---|
| `latitude` | Yes | string/number |
| `longitude` | Yes | string/number |
| `accuracy` | No | GPS accuracy in meters |
| `timestamp` | No | unix ms |
| `userAgent` | No | |
| `existingSubmissionId` | No | append photos to an existing submission instead of creating a new one |
| `images` | No | up to **10 files**, field name `images` |

**Response `200`** (new submission):
```json
{ "success": true, "submissionId": "SAF-1735000000000-AB12CD" }
```

**Response `200`** (appended to existing):
```json
{ "success": true, "submissionId": "SAF-1735000000000-AB12CD" }
```

**Errors:** `400` `{ "message": "Location data is required." }` if `latitude`/`longitude` missing · `500` `{ "message": "Submission failed." }`

*(Verified live: missing location -> `400 {"message":"Location data is required."}`.)*

---

### POST `/api/user-orders/train-model/upload`

`Content-Type: multipart/form-data`

| Field | Required | Notes |
|---|---|---|
| `photos` | Yes | up to **50 files**, 15MB/file, field name `photos` |
| `email` | No | |
| `userAgent` | No | |

**Response `200`:**
```json
{ "success": true, "sessionId": "TM-1735000000000-AB12CD", "count": 3 }
```

**Errors:** `400` `{ "message": "No photos uploaded." }` · `500` `{ "message": "Upload failed. Please try again." }`

---

### POST `/api/user-orders/verify-product/upload`

`Content-Type: multipart/form-data`

| Field | Required | Notes |
|---|---|---|
| `photo` | Yes | single file, 15MB max, field name `photo` |
| `email` | No | |
| `userAgent` | No | |
| `latitude` / `longitude` / `accuracy` / `locationTimestamp` | No | GPS metadata |

**Response `200`:**
```json
{ "success": true, "submissionId": "VP-1735000000000-AB12CD" }
```

**Errors:** `400` `{ "message": "No image uploaded." }` · `500` `{ "message": "Upload failed. Please try again." }`

---

### GET `/api/user-orders/verify-product/submissions`

Admin listing (latest 200). **Always returns `200`**, even on DB error (returns an empty list instead of an error status).

**Response `200`:**
```json
{
  "submissions": [
    {
      "id": 1,
      "submission_id": "VP-1735000000000-AB12CD",
      "email": "jane@example.com",
      "image_filename": "1735000000000-ab12cd.jpg",
      "latitude": 51.5074,
      "longitude": -0.1278,
      "accuracy": 20.5,
      "location_timestamp": 1735000000000,
      "user_agent": "Mozilla/5.0...",
      "ip_address": "1.2.3.4",
      "created_at": "2025-01-01T12:00:00.000Z"
    }
  ]
}
```

---

### POST `/api/user-orders/verify-product/delete`

Warning: **Not real authentication** — gated only by a hardcoded shared password checked
against the request body. Do not expose this route to end users; it's internal admin
tooling reused as-is from the original codebase.

**Request:** `{ "id": 1, "password": "Alluvi@admin@1512" }`

**Response `200`:** `{ "success": true }`

**Errors:** `403` `{ "message": "Incorrect password." }` · `400` `{ "message": "Missing submission id." }` · `404` `{ "message": "Submission not found." }` · `500` `{ "message": "Delete failed." }`

*(Verified live: wrong password -> `403 {"message":"Incorrect password."}`.)*

---

## Browser Fingerprinting

### POST `/api/user-orders/fingerprint/collect`

Stores an extensive device/browser fingerprint for fraud/tracking correlation.
**Always returns `{ "ok": true }`, even on DB failure or an empty body** — this endpoint
is designed to never surface an error to the caller.

**Request** (all fields optional, camelCase):
```json
{
  "os": "Windows",
  "osVersion": "10",
  "browser": "Chrome",
  "browserVersion": "120.0",
  "isMobile": false,
  "isTablet": false,
  "screenWidth": 1920,
  "screenHeight": 1080,
  "screenColorDepth": 24,
  "devicePixelRatio": 1.5,
  "cpuCores": 8,
  "deviceMemory": 8,
  "maxTouchPoints": 0,
  "timezone": "Europe/London",
  "timezoneOffset": 0,
  "language": "en-GB",
  "languages": "en-GB,en",
  "connectionType": "4g",
  "gpuVendor": "NVIDIA",
  "gpuRenderer": "NVIDIA GeForce RTX 3080",
  "canvasHash": "a1b2c3...",
  "cookiesEnabled": true,
  "doNotTrack": "0",
  "batteryLevel": 80,
  "batteryCharging": true,
  "audioInputs": 1,
  "audioOutputs": 2,
  "videoInputs": 1,
  "userAgent": "Mozilla/5.0...",
  "platform": "Win32",
  "vendor": "Google Inc.",
  "referrer": "https://google.com",
  "pageUrl": "https://alluvi.store/checkout",
  "webdriver": false
}
```
The entire raw body is also stored verbatim in a `full_data` JSONB column, so no data is
lost even if the structured column list above evolves.

**Response `200`:** `{ "ok": true }` — always, regardless of outcome.

*(Verified live: empty body -> `200 {"ok":true}`.)*

---

### GET `/api/user-orders/fingerprint/list`

Admin listing (latest 200). **Always returns `200`**, even on DB error (empty array instead).

**Response `200`:** `{ "fingerprints": [ "full visitor_fingerprints rows, snake_case" ] }`

---

## AI Support Chatbot

### POST `/api/ai-chat`

RAG (retrieval-augmented) chatbot over ~30 hardcoded peptide/product/support docs, backed
by Google Gemini with a HuggingFace fallback. Also silently checks any 5+ digit number in
the message against the anti-counterfeit seal-number database and injects the result into
the model's context (the model is instructed to only confirm valid/invalid for a number
the user explicitly provides — it will not list or reveal seal numbers).

**Request:**
```json
{
  "message": "Is seal number 12345678 genuine?",
  "history": [
    { "role": "user", "text": "Hi" },
    { "role": "assistant", "text": "Hello! How can I help?" }
  ]
}
```
`message` max 1000 characters. `history` is optional, only the last 6 entries are used, and each entry needs `role` (`"user"` or `"assistant"`) plus `text` or `content`.

**Response `200`:**
```json
{
  "reply": "Yes, seal number 12345678 is a genuine Alluvi product...",
  "sources": [
    { "id": "anti-counterfeit", "title": "Anti-Counterfeit & Seal Verification" }
  ],
  "provider": "gemini"
}
```
`provider` is `"gemini"` or `"huggingface"` depending on which one answered.

**Errors:** `503` `{ "error": "AI chat is not configured" }` if neither `GEMINI_API_KEY` nor `HUGGINGFACE_API_KEY` is set · `429` `{ "error": "Too many requests. Please wait a moment." }` — rate-limited to 15 requests/60s per IP · `400` `{ "error": "Message is required" }` or `"Message too long (max 1000 chars)"` · `502` `{ "error": "AI service temporarily unavailable. Please try again." }` if both providers fail · `500` on unexpected failure

*(Verified live: missing message -> `400 {"error":"Message is required"}`; suggestions endpoint confirmed below.)*

---

### GET `/api/ai-chat/suggestions`

Static list of example prompts for the chat widget — no auth, no params.

**Response `200`:**
```json
{
  "suggestions": [
    "What is Retatrutide and how does it work?",
    "Compare Retatrutide vs Tirzepatide",
    "What research exists on BPC-157?",
    "Tell me about the Glow product",
    "How should peptides be stored for research?",
    "What products does Alluvi have in stock?"
  ]
}
```
*(Verified live — exact list above.)*

---

## Newsletter

### POST `/api/newsletter/subscribe`

Public giveaway/newsletter signup. Includes a honeypot field (`website`) — if it's
filled in (i.e. a bot filled every field), the request silently returns success without
actually subscribing anyone, so as not to tip off bots.

**Request:**
```json
{
  "email": "jane@example.com",
  "consent": true,
  "source": "home_popup_reta",
  "website": ""
}
```
`consent` must be truthy (`true`, `"true"`, `1`, or `"1"`). `source` optional, defaults to `"home_popup_reta"`, max 64 chars. `website` is the honeypot — always send it empty.

**Response `200`:** `{ "ok": true, "id": 123 }`

**Response `200`** (already subscribed — same email+source pair): `{ "ok": true, "already_subscribed": true }`

**Response `200`** (honeypot triggered): `{ "ok": true }`

**Errors:** `400` `{ "error": "Please enter a valid email address." }` or `"Consent is required to enter the giveaway."` · `429` `{ "error": "Too many submissions. Please try again later." }` — rate-limited to 5/hour per IP · `500` `{ "error": "Failed to submit. Please try again." }`

*(Verified live: missing email -> `400 {"error":"Please enter a valid email address."}`.)*

---

## Misc / Diagnostics

### GET `/api/client-ip` (+ `/api/user-orders/client-ip`, duplicate mount under the `/api/user-orders` prefix for routing/CORS reasons)

Best-guess public client IP — trusts Cloudflare/proxy headers only when Cloudflare-specific headers are present.

**Response `200`:**
```json
{
  "ip": "203.0.113.5",
  "source": "server",
  "headers": {
    "cf-connecting-ip": null,
    "true-client-ip": null,
    "x-real-ip": null,
    "x-forwarded-for": null,
    "remote-address": "203.0.113.5"
  }
}
```
If the detected IP fails basic format validation: `{ "ip": "8.8.8.8", "source": "fallback", "warning": "Invalid IP format detected" }`.

**Errors:** `500` `{ "ip": "8.8.8.8", "source": "error", "error": "Failed to get client IP" }`

---

### GET `/api/test-ip`

Debug variant of the above, echoing all relevant headers including `user-agent`.

**Response `200`:**
```json
{
  "success": true,
  "clientIp": "203.0.113.5",
  "timestamp": "2025-01-01T12:00:00.000Z",
  "headers": {
    "cf-connecting-ip": null,
    "true-client-ip": null,
    "x-real-ip": null,
    "x-forwarded-for": null,
    "remote-address": "203.0.113.5",
    "user-agent": "Mozilla/5.0..."
  }
}
```

---

### POST `/api/user-orders/fengyu/check` (+ `/api/fengyu/check`)

CORS-avoidance proxy so the frontend can call the third-party "Fengyu" visitor-verification API without hitting browser CORS restrictions.

**Request:**
```json
{
  "userAgent": "Mozilla/5.0...",
  "visitUrl": "https://alluvi.store/checkout",
  "clientLanguage": "en-GB",
  "referer": "https://alluvi.store/",
  "timestamp": 1735000000000
}
```
`userAgent`, `visitUrl`, `timestamp` are required.

**Response:** Relays whatever the upstream Fengyu API returns, with the same status code.

**Errors:** `400` `{ "error": "Missing required fields", "required": ["userAgent", "visitUrl", "timestamp"] }` · `405` if called with a method other than POST · `503` `{ "error": "Service unavailable", "message": "Failed to connect to Fengyu API" }` if unreachable · `500` on other failures

*(Verified live: missing fields -> `400` with the shape above.)*

---



## Response envelope reference

This service does not use one consistent success envelope. Quick reference:

| Endpoint | Top-level shape |
|---|---|
| `GET /health`, `GET /api/user-orders/health` | `{ ok, service, db }` |
| `GET /api/wallet` | `{ success, balance, ledger }` |
| `POST /api/promos/validate` | `{ ok, valid, percent }` |
| `GET/POST/POST /api/affiliate/*` | `{ ok, ... }` |
| `POST /api/products/klyme-status*` | `{ klyme_settings }` — object map, no `success`/`ok` |
| `POST /api/user-orders` | `{ success, orderId, orderNumber, email_debug }` |
| `GET /api/user-orders/by-email` | `{ orders }` |
| `GET /api/user-orders/:orderNumber` | `{ order, items, payments }` |
| `PUT`/`DELETE /api/user-orders/:orderNumber` | `{ success }` |
| `POST /api/auth/register`, `/login` | `{ success, token, user }` |
| `GET /api/auth/verify` | `{ success, user }` |
| `POST /api/auth/forgot-password`, `/reset-password` | `{ success, message }` |
| `POST /api/payment-capture/*` | `{ ok, ... }` |
| `POST /api/klyme/create-payment`, `GET /api/klyme/verify-payment/:uuid` | `{ ok, ... }` |
| `POST/GET /api/aabanpay/*` | `{ ok, ... }` |
| `POST /api/user-orders/spot-a-fake/*`, `/train-model/*`, `/verify-product/*` | `{ success, ... }` or `{ message }` on error — no `ok` |
| `POST /api/user-orders/fingerprint/collect` | `{ ok: true }` always |
| `GET /api/user-orders/fingerprint/list`, `/verify-product/submissions`, `/spot-a-fake/submissions` | bare `{ fingerprints }` / `{ submissions }` — no `success`/`ok`, and the GET list endpoints return `200` with an empty array even on DB error |
| `POST /api/ai-chat` | `{ reply, sources, provider }` — no `success`/`ok` |
| `GET /api/ai-chat/suggestions` | `{ suggestions }` |
| `POST /api/newsletter/subscribe` | `{ ok, ... }` |
| `GET /api/client-ip`, `/api/test-ip` | `{ ip, ... }` / `{ success, clientIp, ... }` — inconsistent with each other |
