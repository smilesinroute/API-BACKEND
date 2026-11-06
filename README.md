# Smiles In Route — Platform API

## Purpose

Core backend API powering the Smiles In Route logistics platform.

This API is the central system for all portals:

* Customer Portal
* Admin Dispatch Portal
* Driver Portal

Future system:

* Ops Portal (not yet implemented)

This API handles:

* Pricing logic
* Availability
* Unified order creation
* Order lifecycle management
* Admin dispatch workflow
* Driver assignment
* Driver delivery workflow
* Stripe payment confirmation

This API is the single source of truth for all business logic.

---

# Architecture Overview

Platform stack:

* Node.js native HTTP server (no Express)
* PostgreSQL (Supabase)
* Strict CORS policy
* Unified orders table
* Internal service modules

Primary router:

server.js
↓
index.js
↓
controllers / drivers / admin modules

All portals communicate with this API.

---

# Canonical Public Endpoints

## Health Check

GET /api/health

Returns API status.

---

# Courier Quotes

POST /api/quote

Request fields: `serviceType` (`courier`), `region`, `vehicleType`, `pickupAddress`, and `dropoffAddress`. Optional flags: `fragile`, `priority`, `timeSensitive`, and `afterHours`. Vehicle values must match the configured database pricing rows.

All pricing is calculated server-side using the stored rates and Google driving distance. Client-supplied distance or total fields are not used for quoting. The response includes `ok`, `distance`, `total`, and a `breakdown` with `baseFee`, `perMile`, `mileageCost`, and the selected add-on fees. The frontend displays these amounts without recalculating mileage charges.

## Changing courier prices

Prices come from `public.pricing_config` on every quote request; they are not cached or hardcoded in the website. After this draft is deployed, authorized operators can change prices in Supabase's Table Editor without redeploying the API or website:

1. Open **Table Editor → pricing_config**.
2. Filter `service_type = courier`, `region = oregon`, `vehicle_type = standard`, and `active = true`. This is the approved Oregon **Sedan** rate shown in the customer portal.
3. Edit `base_rate` (base fee), `per_mile_rate` (dollars per mile), `fragile_fee`, or `priority_fee`, then save the row. Use nonnegative dollar amounts, not cents.
4. Request a new test quote and verify the displayed breakdown and total. The next quote reads the saved amounts; no code change or restart is needed.

Keep exactly one active row for each region, service and pricing vehicle. The API rejects missing or duplicate active rows rather than choosing an arbitrary price. Other regions use their exact vehicle names; there is no automatic global fallback. Cargo Van (`cargo`) still needs a confirmed rate and matching row before it can quote.

`time_sensitive_fee` and `after_hours_fee` are not currently present in the inspected table. Requests selecting those extras will fail clearly until their rates and database fields are configured; they are never silently priced at zero. Base and per-mile rates are required, as are the fees for any selected extras.

This draft only reads pricing. It does not provide a public price-edit endpoint or change existing database rows, permissions, orders, or payments. Editing a production rate intentionally changes new customer quotes, so review a new quote immediately after saving.

Quote regression tests (no live database or Google calls):

```bash
node --test tests/quote.test.js
```

---

# Notary Quotes

POST /api/notary/quote

---

# Unified Order Submission

POST /api/orders

All portals must submit orders here.

No portal may bypass this endpoint.

---

# Order Lifecycle

Primary order statuses:

pending_admin_review
approved_pending_payment
ready_for_dispatch
assigned
en_route
completed
rejected
cancelled

Payment statuses:

unpaid
paid

Lifecycle flow:

Customer submits order
↓
pending_admin_review
↓
Admin approves
↓
approved_pending_payment
↓
Customer pays via Stripe
↓
ready_for_dispatch
↓
Dispatch assigns driver
↓
assigned
↓
Driver begins route
↓
en_route
↓
Driver completes job
↓
completed

---

# Driver Portal Endpoints

POST /api/driver/login

GET /api/driver/orders

POST /api/driver/order/:id/accept

POST /api/driver/order/:id/start

POST /api/driver/order/:id/complete

POST /api/driver/proof

Files stored in Supabase Storage.

---

# Dispatch

POST /dispatch/assign-driver

Body:

order_id
driver_id

Updates:

orders.assigned_driver_id
orders.status = assigned

---

# Stripe Payments

POST /api/webhook/stripe

Updates:

payment_status = paid
status = ready_for_dispatch

---

# Internal Admin Routes

/admin/dashboard
/admin/orders
/admin/orders/:id/approve
/admin/orders/:id/reject

These routes are internal and may change.

---

# Core System Rules

* Pricing always calculated server-side
* Frontend never calculates totals
* All services must use unified /api/orders
* Order totals must match server pricing
* Region validation must occur before quote
* Empty queries return empty arrays
* 404 reserved for unknown routes

---

# Deployment

Environment variables required:

PG_HOST
PG_USER
PG_PASSWORD
PG_DATABASE
PG_PORT

STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET

SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY

CORS_ALLOWED_ORIGINS

Deployment target:

Render

---

# Contract Authority

If frontend and backend disagree:

Backend contract wins.

Update this document whenever:

* Endpoint structure changes
* Pricing logic changes
* Order lifecycle changes
* Driver workflow changes

