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

All pricing is calculated server-side.

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
