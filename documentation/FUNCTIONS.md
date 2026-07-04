# user-order-service — Function Reference

This document walks through every top-level function in the `user-order-service`
codebase, in the order it appears in the source: what it does, and which HTTP
endpoint(s) ultimately trigger it (directly, or through a chain of internal calls). It
covers:

- [index.js](../index.js) (~10,100 lines) — the whole application: Express app, routes, business logic.
- [db-adapter.js](../db-adapter.js) — the MySQL→Postgres SQL translation layer.
- [fengyu-proxy.js](../fengyu-proxy.js) — a small third-party API proxy.
- [seal-numbers.json](../seal-numbers.json) — static anti-counterfeit data (not code).

---

## 1. What this service is

`user-order-service` is a PostgreSQL/Supabase-compatible clone of an original MySQL
service (`server/user-order-creation`) for **Alluvi**, a peptide research-chemical
storefront. A single Express app (`index.js`) owns:

- Customer checkout / order creation and order lookup
- Manual bank-transfer "payment capture" (screenshot upload + verification)
- Two card/BNPL payment gateways: **Klyme** and **AabanPay**
- A wallet/store-credit system and an affiliate/referral program with promo codes
- Customer auth (register/login/JWT), password reset
- Anti-fraud tooling: customer blacklist, browser fingerprinting, seal-number
  (anti-counterfeit) verification
- Product-authenticity crowdsourcing: "Spot a Fake" reports, "train model" photo
  uploads, "verify product" photo uploads
- An AI support chatbot (RAG + Gemini/HuggingFace)
- Newsletter/giveaway signup
- A CORS proxy for a third-party visitor-tracking API ("Fengyu")

It talks to Postgres exclusively through `db-adapter.js`, which lets ~10k lines of
MySQL-flavored SQL (`?` placeholders, `INSERT IGNORE`, `ON DUPLICATE KEY UPDATE`,
backtick identifiers, `UPDATE`/`DELETE ... LIMIT`) run unmodified against Postgres.

---

## 2. Startup & configuration

- **`.env` loading** — Checks `$DOTENV_PATH`, then this service's own `.env`, then
  walks up to 3 parent directories (matches the sibling services' convention — on the
  VPS this resolves to the shared `/var/www/.env`). First file found wins.

- **DB pool** — Built via `mysql.createPool(...)`, where `mysql` is the
  `db-adapter.js` compat shim, not real `mysql2`. Prefers `DATABASE_URL` (Supabase
  Postgres) when set; falls back to discrete `DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASS`/
  `DB_NAME` only if it isn't.

- **`PORT`** — Read from the `USER_ORDER_CREATION_PORT` env var, default `5003`.

- **`JWT_SECRET`** — ⚠️ Has a hardcoded fallback
  (`'alluvi_super_secret_key_2024_production_secure_token_12345'`) if the env var
  isn't set. Used for both customer auth tokens (`requireUserAuth`) and
  password-reset tokens. Tokens issued by `/api/auth/login`/`/api/auth/register`
  expire after **30 days**.

- **`UPLOADS_DIR`** — Default `/var/www/backend/uploads`; served statically at
  `/uploads`.

- **CORS / `express.json`** — Body size limit 5mb.

- **Multer upload configs** — Four separate configs (`upload`/`captureUpload` for
  order/payment-capture screenshots, `spotFakeUpload`, `trainModelUpload`,
  `verifyProductUpload`), each writing to its own subfolder under `UPLOADS_DIR` with
  its own file-size/count limits.

- **App listen** — `app.listen(PORT, ...)`, immediately followed by an async IIFE
  that runs the `ensure*Schema()`/`ensure*Table()` migration helpers so the schema
  self-heals on boot.

- **Seal number DB** — Loads `seal-numbers.json` into an in-memory `Set`
  (`SEAL_NUMBERS`) at startup for `checkSealNumbers`.

- **RAG knowledge base** — `RAG_DOCUMENTS`, a static array of ~30 hand-written
  peptide/product/company knowledge documents, TF-IDF-indexed at startup for the AI
  chatbot. Not a function, but core to how `/api/ai-chat` works.

---

## 3. Order persistence, credits & shared helpers

The heart of the service. `persistOrderFromCheckout` is the single write-path used by
every checkout flow (manual, Klyme, AabanPay) — a full order-creation pipeline in one
function, run inside a DB transaction by its caller.

### `persistOrderFromCheckout(connection, payload, opts)` — index.js:3088

Creates one order end-to-end. Phases, in order:

1. Validate `email` is present; run `assertNotBlacklisted` (throws if the customer/address is blacklisted).
2. Resolve/generate a unique order number (`resolveUniqueOrderNumber`).
3. Normalize customer/shipping fields (name, phone, address).
4. Classify the checkout as Klyme / AabanPay / Manual (`isKlymeCheckoutPayload`, an inline AabanPay-eligible-products check) — sets `payment_method`/`bank_account_used`.
5. If the order contains a "bundle" item (`orderItemsContainBundle`), force-clear any promo/discount (bundles aren't promo-eligible).
6. Upsert the `users` row (`INSERT ... ON DUPLICATE KEY UPDATE`) so a customer record always exists.
7. For non-Klyme (manual/AabanPay) orders, immediately apply available store credit via `applyAvailableCreditsToOrder` (Klyme orders instead reserve credit later, since Klyme needs the pre-credit total for its own payment amount).
8. Upsert the customer's default shipping address (`user_addresses`).
9. `INSERT INTO orders` (the main order row) and `INSERT INTO payments` (a tracking row keyed by `providerId`).
10. Ensure the special test product (id `32`) exists if referenced (sandbox/AabanPay-test flows).
11. Loop `order_items`, resolving/validating each `product_id` (with an in-memory existence cache) before inserting.
12. Return `{ orderId, orderNumber }`.

Ends at line ~3567 — not the ~3000-line span the raw line numbers alone might
suggest; verified by reading to its closing brace.

**Used by**: `POST /api/user-orders` (the main order-creation endpoint) — its only direct caller.

### `reserveAvailableCreditsForOrder(connection, orderNumber, opts)` 

Soft-holds a customer's wallet balance against an order's total at checkout time
(before payment is confirmed), without debiting it yet. Reads/writes `orders`
(`credits_reserved`), `user_credits`, `credit_ledger`; can also update
`payments.amount`. Returns
`{ ok, orderId, orderNumber, creditsReserved, payableTotal, alreadyReserved|alreadyApplied, reason? }`.

**Used by**: `POST /api/klyme/create-payment` (Klyme's checkout flow reserves credit before sending the payable amount to Klyme).

### `applyAvailableCreditsToOrder(connection, orderNumber, opts)`

Immediately debits available `user_credits` balance against a pending order's total
(used by manual/AabanPay orders, which don't need the reserve→finalize two-step that
Klyme uses). Writes `orders` (`credits_applied`, `total_before_credits`, `total`),
`credit_ledger`, optionally `payments.amount`.

**Used by**: `persistOrderFromCheckout` (for non-Klyme orders) and `POST /api/payment-capture/apply-promo`.

### `finalizeReservedCreditsForOrder(connection, orderNumber, opts)` 

Converts a previously-reserved credit hold into an actual debit once payment is
confirmed (used by the Klyme webhook/verify flow). Writes `orders`, `user_credits`,
`credit_ledger`.

**Used by**: `POST /api/klyme/webhook` and `GET /api/klyme/verify-payment/:uuid`.

### `ensureCustomerCreditsSchema()`

Idempotently creates `user_credits`/`credit_ledger` tables and the
`orders.credits_applied`/`total_before_credits`/`credits_reserved` columns if
missing.

**Used by**: the credit-reserve/apply/finalize functions above (defensive self-healing before every credit operation), plus directly by several routes (`/api/wallet`, `/api/affiliate/dashboard`, `/api/newsletter/subscribe`'s startup path).

### `isBundleItemIdentifier(raw)` / `orderItemsContainBundle(items)`

Detect "bundle" SKUs/names/ids (e.g. `bundle-retatrutide...`) so bundle orders are
excluded from promo-code discounts.

**Used by**: `persistOrderFromCheckout` and the payment-capture validate/apply-promo routes.

### `withTimeout(promise, ms, label)`

Generic `Promise.race`-based timeout wrapper — rejects with an `ETIMEDOUT`-coded
error if the wrapped promise doesn't settle in time.

**Used by**: `POST /api/auth/login` (wraps the bcrypt compare + DB lookup so login can't hang indefinitely).

### `maskSecret(value)` 

Masks a secret for safe logging (`ab7cd2***2fc0`-style).

**Used by**: nothing — it's invoked once, directly at module load time (index.js:773-785), to log a masked Klyme merchant UUID to the console on startup. Not called from any route or function.

### `isKlymeCheckoutPayload(payload, opts)` 

Heuristic classifier: does this checkout payload look like a Klyme payment (checks
`providerId`, `payment_method`, `mode`, a `klyme`/`klyme_enabled` hint field, or
presence of a `paymentUuid`)?

**Used by**: `persistOrderFromCheckout` and `POST /api/user-orders` (to decide `bankAccountUsed`/routing before calling it).

### `addBusinessDays(date, days)`

Adds N UK business days (skipping Sat/Sun) to a date.

**Used by**: nobody — dead code. Grepped for every call site in the file; there are none. `computeUkDeliveryEstimate` (directly below it) has its own separate inline business-day-adding closure and doesn't call this function at all, despite the apparent duplication.

### `computeUkDeliveryEstimate(paymentDate)`

Given a payment timestamp, returns `{ deliveryText, deliveryDateLabel }` —
UK-timezone-aware "before/after 2pm cutoff" delivery estimate text, using its own
internal `addUkBusinessDays` closure (see note above).

**Used by**: the Klyme webhook/verify routes and the AabanPay charge/callback routes, to build delivery-estimate text for the "payment successful" customer email.

### `postExternalInvoice(payload)`
Dead/stubbed out — the body is just `return { ok: false, status: 410, ... }` with a
comment "Disabled: no outbound requests should be sent to external invoice
endpoints."

**Used by**: nobody — no call sites found. Left in place as a disabled no-op rather than removed.

### `env(name, fallback)` / `envInt(name, fallback)`

The standard `process.env` reader used throughout this codebase (blank/whitespace-only
values are treated as unset, falling back to the default).

**Used by**: called pervasively — from nearly every route and several other helpers (`envInt`, `generatePasswordResetEmail`, `getNewsletterAdminTransporter`, `sendNewsletterAdminNotification`, `aabanpayCreatePaymentHandler`, `fetchTimeoutMs`, etc.). Not exhaustively listed here.

### `generatePasswordResetEmail(resetLink, userName)`

Builds the branded HTML for the password-reset email.

**Used by**: `POST /api/auth/forgot-password`.

---

## 4. Auth & anti-fraud helpers

### `requireUserAuth(req, res, next)` 

Express middleware: reads `Authorization: Bearer <token>`, verifies it with
`JWT_SECRET`, and attaches `req.user = { id, email, role }`. Returns
`401 { error: 'Missing token' }` or `401 { error: 'Invalid token' }` on failure.

**Used by**: as middleware on `GET /api/wallet`, `GET /api/affiliate/status`, `POST /api/affiliate/request`, `GET /api/affiliate/dashboard` (and their `/api/auth/*` / `/api/user-orders/*` path aliases).

### `normalizeBlacklistEmail(raw)` / `normalizeBlacklistAddressKey(parts)` 

Normalize an email or a `address|city|postcode|country` tuple into a lookup key for
the blacklist table.

**Used by**: `assertNotBlacklisted` only.

### `assertNotBlacklisted(connection, payload)`

Throws a `CUSTOMER_BLACKLISTED`-coded error if the customer's email or shipping
address matches a row in `customer_blacklist`.

**Used by**: `persistOrderFromCheckout` (step 1) — so every order-creation path is gated by this.

### `ensureCustomerBlacklistTable()` 

Idempotently creates the `customer_blacklist` table.

**Used by**: `assertNotBlacklisted` and `POST /api/newsletter/subscribe`'s startup path.

### `ensureUsersAuthColumns()`

Idempotently adds auth-related columns to `users` (password hash, etc.) if missing.

**Used by**: `POST /api/newsletter/subscribe`'s startup path (grouped with the other schema-ensure calls there, even though it's unrelated to newsletters — likely just piggybacking on an existing "ensure everything" bootstrap call).

### `ensurePasswordResetTokensTable()`

Idempotently creates the `password_reset_tokens` table.

**Used by**: `POST /api/newsletter/subscribe`'s startup path (same bootstrap grouping as above).

### `toMysqlDatetimeFromIso(iso)` / `nowMysqlDatetime()` / `addHoursMysql(hours)2662

Date-formatting helpers producing MySQL-style `'YYYY-MM-DD HH:MM:SS'` strings (which
Postgres also accepts for `TIMESTAMP`/`DATETIME` columns via the adapter).

**Used by**: `nowMysqlDatetime` in particular is called from many places across the credits, affiliate, and order-capture code paths — too many to list individually.

### `randomToken()` — index.js:2796 / `sanitizeForFilename(raw)`

`randomToken` generates a crypto-random hex token (used for payment-capture links and
password resets). `sanitizeForFilename` strips unsafe characters from user-supplied
filenames before writing to disk.

**Used by**: `POST /api/payment-capture/upload` and `POST /api/user-orders` (screenshot filename handling).

---

## 5. Promo codes & affiliate program

### `ensureAffiliateSchema()` 
Idempotently creates `promo_codes`, `affiliate_requests`, `affiliates`,
`promo_redemptions` tables and their self-serve-signup columns (`first_name`,
`last_name`, `tiktok_link`).

**Used by**: `POST /api/affiliate/request`, `GET /api/affiliate/dashboard`, `GET /api/affiliate/status`, `POST /api/newsletter/subscribe`'s bootstrap path, and internally by `resolvePromoPercent`/`grantAffiliateRewardForOrder`.

### `resolvePromoPercent(connection, codeRaw)` 
Resolves a promo code to a discount percentage — checks a small hardcoded
`STATIC_PROMO_MAP` (`SAVE10`, `PETER10`, `DAVID10` → 10%) first, then falls back to
the `promo_codes` table (covers affiliate-generated codes).

**Used by**: `POST /api/promos/validate` and `POST /api/payment-capture/apply-promo`.

### `splitFirstName(raw)` / `sanitizePromoToken(raw)`

Small string helpers (first word of a name; uppercase-alphanumeric-only token).

**Used by**: `generateUniqueAffiliatePromoCode` only.

### `generateUniqueAffiliatePromoCode(connection, userName, percent)` — index.js:1471

Generates a unique promo code for a new affiliate (based on their name + percent,
retrying on collision).

**Used by**: `POST /api/affiliate/request`.

### `grantAffiliateRewardForOrder(connection, orderNumber, opts)` 

The core affiliate-payout logic, run once an order's payment is confirmed. Validates:
order exists, has a customer email, `payment_status = 'received'`, has a real
(non-`-`/`NONE`) promo code that maps to an **affiliate**-sourced `promo_codes` row,
buyer isn't the affiliate themselves (no self-referral), and the affiliate hasn't
already been rewarded for this customer or this order (`promo_redemptions`
uniqueness). If all checks pass: credits the affiliate's `user_credits` balance, logs
`credit_ledger` + `promo_redemptions` rows, and fires (non-blocking)
`sendAffiliateRewardNotificationEmail`.

**Used by**: `POST /api/klyme/webhook` and `POST /api/payment-capture/upload` directly; also via the `grantAffiliateRewardForOrderId` wrapper below.
**Calls out to**: email (`sendAffiliateRewardNotificationEmail`, via `../emailService.js` → Resend).

### `grantAffiliateRewardForOrderId(connection, orderId, opts)`

Convenience wrapper: looks up `order_number` from a numeric `orderId`, then calls
`grantAffiliateRewardForOrder`. Idempotent — safe to call from every
payment-success path.

**Used by**: `GET /api/klyme/verify-payment/:uuid`, `POST /api/user-orders/aabanpay/charge`, `GET /api/user-orders/aabanpay/callback`, and internally by `recheckAndUpdateKlymeStatus`, `aabanpayWebhookHandler`, `aabanpayVerifyPaymentHandler`.

---

## 6. Payment capture (manual bank transfer)

### `ensurePaymentCaptureTable() / `ensurePaymentCaptureEmailTrackingColumns()` `ensureOrdersPaymentRejectionReasonColumn()`  `ensurePaymentSessionsEmailTrackingColumns()`

Idempotent schema-ensure functions for `payment_capture_requests` (the table backing
bank-transfer proof-of-payment links/tokens) and related tracking columns on
`payment_sessions`/`orders`.

**Used by**: `POST /api/newsletter/subscribe`'s startup bootstrap (all four, grouped there alongside the other `ensure*` calls) and, for `ensurePaymentSessionsEmailTrackingColumns`, also directly by `POST /api/klyme/create-payment`.

### `validateCaptureToken(connection, tokenRaw)` 

Looks up a payment-capture link token by its SHA-256 hash, checks expiry, checks it
hasn't already been used by a *finally-paid* order (retry-safe otherwise), and checks
the requester's email matches the order. Returns the order + items + payments on
success.

**Used by**: `POST /api/payment-capture/validate`, `POST /api/payment-capture/apply-promo`, `POST /api/payment-capture/upload`.

### `parseMoney(raw)` / `parsePercent(raw)` 

Tolerant numeric parsers (strip `£`, coerce to `Number`, default to `0` on failure).

**Used by**: `persistOrderFromCheckout` (money/percent fields from the checkout payload).

### `parseItemsText(itemsText)`

Parses the legacy `"Product A x2 @ £19.99 | Product B x1 @ £9.99"` items-text format
back into structured `{ name, quantity, unitPrice }` objects. Used where a full items
array isn't available.

### `slugifySku(name)`

Turns a product name into a URL/SKU-safe slug.

**Used by**: `persistOrderFromCheckout` (fallback SKU generation for order items missing one).

### `fetchTimeoutMs()` — index.js:2820 / `fetchJsonWithTimeout(url, opts)` 

Reads `PAYMENT_CAPTURE_VERIFY_TIMEOUT_MS` (default) and wraps `fetch` with an
abort-based timeout.

**Used by**: `POST /api/payment-capture/upload` (calls out to payment-verification-service's `/api/payment-verification/verify` endpoint to OCR-check the uploaded screenshot).
**Calls out to**: `payment-verification-service` (a sibling microservice, not an external third party).

---

## 7. Klyme payment gateway integration

All Klyme HTTP calls go through `callKlymeAPI`, which tries multiple base
URLs/payload encodings for resilience against the provider's flaky routing.

### `getActiveKlymeConfig()`

Picks sandbox vs. production Klyme credentials based on `KLYME_ENV`.

**Used by**: `POST /api/klyme/create-payment` and internally by `resolveKlymeBaseUrls`/`callKlymeAPI`.

### `resolveKlymeBaseUrls(cfg)` 

Builds an ordered, de-duplicated list of Klyme API base URLs to try (configured value
first, then hardcoded prod/sandbox fallbacks).

**Used by**: `callKlymeAPI` only.

### `fetchWithTimeout(url, options, timeoutMs)`

A second, Klyme-specific `AbortController`-based fetch timeout wrapper (distinct from
the payment-capture one above, despite the same name — they're independent local
functions, not a duplicate export).

**Used by**: `callKlymeAPI` only.

### `callKlymeAPI(endpoint, method, body, opts)`

Core Klyme HTTP client: Basic-auth header, tries each base URL × `{json, form}`
payload encoding combination until one succeeds.

**Used by**: `POST /api/klyme/create-payment` directly, and internally by `getKlymePaymentStatus`.
**Calls out to**: Klyme's API (`https://api.klyme.io/api/v1` prod / `https://api-test.klyme.io/api/v1` sandbox).

### `deriveKlymeStatus(payload)`

Normalizes Klyme's various status representations (ISO 20022-style codes like
`ACSP`/`RJCT`, numeric status, or free-text description) into
`{ status: 1|0|2|null, statusCode, description, settlement }` (1 = success, 0 =
failed, 2 = pending).

**Used by**: `GET /api/klyme/verify-payment/:uuid`, `POST /api/klyme/webhook`, and internally by `recheckAndUpdateKlymeStatus`.

### `getKlymePaymentStatus(uuid)` 

Thin wrapper: `GET /payments/status?uuid=...` via `callKlymeAPI`.

**Used by**: `GET /api/klyme/verify-payment/:uuid` and internally by `recheckAndUpdateKlymeStatus`.

### `recheckAndUpdateKlymeStatus(uuid, attempt)` 

Self-scheduling background poller (exponential backoff, up to 8 attempts) that
re-checks a pending Klyme payment's status and, once resolved, updates
`payment_sessions`/`payments`/`orders` and grants the affiliate reward if paid.
Recursively re-invokes itself via `setTimeout` while status stays pending/unknown.

**Used by**: `scheduleKlymeStatusRecheck` only (the actual public entry point).

### `scheduleKlymeStatusRecheck(uuid)`

De-bounces recheck requests per UUID (via an in-flight `Map`) and kicks off
`recheckAndUpdateKlymeStatus` after a short delay.

**Used by**: `POST /api/klyme/webhook` (schedules a recheck as a safety net alongside the webhook's own status handling).

### `decryptKlymeWebhookIfNeeded(body)` 

Klyme webhooks are sometimes AES-encrypted (`{ iv, data }` hex fields); this decrypts
them back to plain JSON if that shape is detected, otherwise returns the body
unchanged.

**Used by**: `POST /api/klyme/webhook` only.

---

## 8. AabanPay payment gateway integration

### `aabanpayAuthToken()`

Base64-encodes `AABANPAY_API_KEY` for the plugin's `Authorization` field.

**Used by**: `POST /api/user-orders/aabanpay/charge` and internally by `fetchAabanPayTransactionsByExtId`.

### `aabanpayCardTypeNumber(raw)` / `aabanpayNormalizeCountry(raw)`

Map human-readable card brand/country strings to the numeric/ISO2 codes AabanPay's
API expects.

**Used by**: `POST /api/user-orders/aabanpay/charge`.

### `fetchAabanPayTransactionsByExtId(extOrderId)` 

Looks up a transaction on AabanPay's side by the merchant's external order id.

**Used by**: `GET /api/user-orders/aabanpay/callback`.
**Calls out to**: AabanPay's API (`AABANPAY_API_BASE`).

### `isAabanPayProduct(productId)`  / `isAabanPayOrder(connection, orderId)`

Determine eligibility: only orders composed entirely of a small allow-list of
products (test product `32`, `retatrutide-20mg`/`-40mg`, etc.) may use AabanPay.

**Used by**: `aabanpayCreatePaymentHandler` and `POST /api/user-orders/aabanpay/charge`.

### `aabanpayCreatePaymentHandler` (route handler, not a plain helper)

Validates the order is AabanPay-eligible, then calls AabanPay's `/payment/create` to
start a hosted-payment session, building success/failure/webhook redirect URLs from
`FRONTEND_URL`/`PUBLIC_API_BASE_URL`.

**Mounted at**: `POST /api/aabanpay/create-payment` and `POST /api/user-orders/aabanpay/create-payment` (same handler, two paths).
**Calls out to**: AabanPay's API.

### `aabanpayWebhookHandler`
Receives AabanPay's payment-status webhook; updates `orders`/`payments` and grants
affiliate rewards via `grantAffiliateRewardForOrderId` on success.

**Mounted at**: `POST /api/aabanpay/webhook` and `POST /api/user-orders/aabanpay/webhook`.

### `aabanpayVerifyPaymentHandler`5 (route handler)

Client-side polling endpoint to check an AabanPay session's current status.

**Mounted at**: `GET /api/aabanpay/verify-payment/:sessionId` and `GET /api/user-orders/aabanpay/verify-payment/:sessionId`.

---

## 9. AI support chatbot (RAG + Gemini/HuggingFace)

### `checkSealNumbers(message)`

Extracts 5+ digit numbers from a chat message and checks each against the in-memory
`SEAL_NUMBERS` set (loaded from `seal-numbers.json`) for anti-counterfeit
verification.

**Used by**: `POST /api/ai-chat`.

### `ragTokenize(text)` / `ragIdf(term)`/ `ragRetrieve(query, topK)`

A small hand-rolled TF-IDF retrieval engine over the static `RAG_DOCUMENTS` knowledge
base (tokenize → inverse-document-frequency scoring → top-K most relevant documents
for a query, with a tag-match boost and a default fallback to the "company"/"peptide
basics" docs for empty queries).

**Used by**: `POST /api/ai-chat` (via `ragRetrieve`, which internally uses `ragTokenize`/`ragIdf`).

### `callGemini(messages, contextDocs)`

Primary AI backend: builds a system prompt with the RAG-retrieved context documents
injected, calls Google's Gemini `generateContent` API.

**Used by**: `POST /api/ai-chat` (tried first if `GEMINI_API_KEY` is set).
**Calls out to**: `https://generativelanguage.googleapis.com` (Gemini).

### `callHuggingFace(messages, contextDocs)`

Fallback AI backend (OpenAI-compatible chat-completions format) used if Gemini fails
or isn't configured.

**Used by**: `POST /api/ai-chat`.
**Calls out to**: `https://router.huggingface.co/v1/chat/completions`.

### `aiRateCheck(ip)`

Simple in-memory sliding-window rate limiter (15 requests/minute per IP), with a
periodic cleanup `setInterval`.

**Used by**: `POST /api/ai-chat`.

---

## 10. Newsletter / giveaway signup

### `newsletterRateLimit(ip)` 

Per-IP rate limiter for newsletter signups (separate map/window from the AI chat
one).

**Used by**: `POST /api/newsletter/subscribe`.

### `escapeNewsletterHtml(s)` 
Basic HTML-entity escaping for values interpolated into the admin-notification
email.

**Used by**: `sendNewsletterAdminNotification` only.

### `getNewsletterAdminTransporter()` 

Lazily creates (and caches) a nodemailer SMTP transporter from `EMAIL_USER`/
`EMAIL_PASS` (Gmail SMTP), returning `null` if unconfigured.

**Used by**: `sendNewsletterAdminNotification` only.

### `sendNewsletterAdminNotification({ email, source, ipAddress, userAgent, originLabel })`

Sends an internal notification email (to `NEWSLETTER_NOTIFY_EMAIL`) whenever someone
signs up, with signup metadata.

**Used by**: `POST /api/newsletter/subscribe`.
**Calls out to**: Gmail SMTP directly (not via `../emailService.js`/Resend — this one function uses its own transporter).

### `ensureNewsletterTable()`

Idempotently creates `newsletter_subscribers`.

**Used by**: `POST /api/newsletter/subscribe`.

---

## 11. Supporting files

### `db-adapter.js`

A `mysql2/promise`-compatible adapter backed by `pg`, so this file's ~10k lines of
MySQL-flavored query code can run against Postgres unmodified. Translates: `?` →
`$1..$n` placeholders, backtick identifiers → double-quoted, `INSERT IGNORE` →
`ON CONFLICT DO NOTHING`, `ON DUPLICATE KEY UPDATE` →
`ON CONFLICT ... DO UPDATE SET` (via a per-table `CONFLICT_TARGETS` map),
`DATE_ADD(...)` → Postgres interval arithmetic, `IF(a,b,c)` → `CASE WHEN`, MySQL DDL
→ Postgres DDL (`AUTO_INCREMENT` → `SERIAL`/`BIGSERIAL`, `DATETIME` → `TIMESTAMPTZ`,
etc.), and strips a trailing `LIMIT n` from `UPDATE`/`DELETE` statements (Postgres
doesn't support it there — every such query in this codebase already scopes its
`WHERE` to a unique key, so dropping the clause is behavior-preserving). Shared,
byte-identical copy also used by `tracking-service` and `payment-verification-service`.

### `fengyu-proxy.js`

Exports `fengyuProxy(req, res)`, a thin CORS-avoidance proxy to a third-party
visitor-fingerprinting API (`api-visitor.fangyu.io`). Includes `getClientIpFromReq`
(Cloudflare-aware real-IP extraction) and `buildPhpStyleQueryString` (matches the
third party's expected query format).

**Mounted at**: `POST /api/user-orders/fengyu/check` and `POST /api/fengyu/check`.

### `seal-numbers.json`

A static JSON array of ~250,000 valid Alluvi product authenticity seal numbers,
loaded into memory at startup for `checkSealNumbers` (AI chat) and the "Spot a
Fake"/"verify product" anti-counterfeit endpoints. Not code — a data file.
