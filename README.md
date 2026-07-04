# user-order-service

PostgreSQL/Supabase-compatible  single Express
app that owns customer checkout, payments, wallet/affiliate rewards, auth, anti-fraud
tooling, and a support chatbot.

## What it does

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

It talks to Postgres exclusively through `db-adapter.js`.

## Project structure

| File | Purpose |
|---|---|
| [`index.js`](index.js) | The whole application: Express app, routes, business logic. |
| [`db-adapter.js`](db-adapter.js) | MySQL → Postgres SQL translation layer (shared with `tracking-service` and `payment-verification-service`). |
| [`fengyu-proxy.js`](fengyu-proxy.js) | CORS-avoidance proxy to a third-party visitor-fingerprinting API. |
| [`seal-numbers.json`](seal-numbers.json) | Static anti-counterfeit seal-number data (~250k entries). |
| [`documentation/API_DOCUMENTATION.md`](documentation/API_DOCUMENTATION.md) | Full HTTP API reference. |
| [`documentation/FUNCTIONS.md`](documentation/FUNCTIONS.md) | Function-by-function reference for the codebase. |
| [`test/`](test) | Postman collection + environment for manual/API testing. |

## Requirements

- Node.js >= 18

## Setup

```bash
npm install
```

Create a `.env` file (or rely on a shared `/var/www/.env`) with at least:

```
DATABASE_URL=postgres://user:password@host:5432/dbname
USER_ORDER_CREATION_PORT=5003
JWT_SECRET=some-long-random-secret
UPLOADS_DIR=/var/www/backend/uploads
```

Other env vars used by specific features (payment gateways, email, AI chatbot) are
documented inline in [`documentation/FUNCTIONS.md`](documentation/FUNCTIONS.md#2-startup--configuration).

`.env` resolution order: `$DOTENV_PATH`, then this service's own `.env`, then up to 3
parent directories (matches sibling services' convention).

## Running

```bash
npm start      # node index.js
npm run dev    # nodemon index.js
```

The server listens on `USER_ORDER_CREATION_PORT` (default `5003`). On boot it runs
idempotent `ensure*Schema()`/`ensure*Table()` migration helpers so the schema
self-heals.

## API

See [`documentation/API_DOCUMENTATION.md`](documentation/API_DOCUMENTATION.md) for the
full endpoint reference (auth, orders, wallet/affiliate, Klyme, AabanPay, payment
capture, uploads, fingerprinting, AI chat, newsletter). A Postman collection is
available in [`test/`](test).

## Documentation

- [`documentation/FUNCTIONS.md`](documentation/FUNCTIONS.md) — every top-level
  function, what it does, and which endpoint(s) trigger it.
- [`documentation/API_DOCUMENTATION.md`](documentation/API_DOCUMENTATION.md) — HTTP API
  reference.
