\# SmilesInRoute Platform API



\## Purpose

A multi-tenant scheduling, availability, and booking API

for mobile, real-world services (courier, mobile notary, etc).



This API powers internal portals and may be rented by

external businesses with similar needs.



\## Core Principles

\- One availability engine

\- Stable API contracts

\- Tenant-scoped data

\- Role-based authorization (not role-based endpoints)

\- Empty results return 200 with an empty array



\## Roles

Supported roles include:

\- customer

\- driver

\- admin

\- ops (internal)



Roles affect permissions and visibility only.

They do not change endpoint URLs or response shapes.



\## Public API (Stable)

\- GET /api/v1/availability

\- POST /api/v1/bookings

\- GET /api/v1/services



\## Internal API (Unstable)

\- /admin/\*

\- /drivers/\*

\- /integrations/\*

\- /internal/ops/\*



\## Status Code Rules

\- 200: success (including empty results)

\- 400: invalid input

\- 401/403: authentication/authorization issues

\- 404: route does not exist (never used for empty data)



