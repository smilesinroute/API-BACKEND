\# Smiles In Route — Platform API



\## Purpose



Core backend API powering:



\- Customer Portal

\- Ops Portal

\- Driver Portal

\- Admin workflows



This API handles:



\- Pricing logic

\- Availability

\- Unified order creation

\- Order lifecycle management

\- Driver assignment

\- Admin review



This is the single source of truth for all business logic.



---



\# Architecture Overview



\- Node.js (native HTTP, no Express)

\- PostgreSQL

\- Strict CORS policy

\- Unified `orders` table

\- Role-based access (not role-based endpoints)



All portals communicate with this API.



---



\# Canonical Public Endpoints



\## Health Check



GET /api/health



---



\# NOTARY



\## Quote



POST /api/notary/quote



Body:

{

&nbsp; region: string,

&nbsp; signers: number,

&nbsp; document\_type: string

}



Returns:

{

&nbsp; quote\_id: string,

&nbsp; breakdown: object,

&nbsp; total: number

}



Pricing is calculated server-side.



---



\# COURIER



\## Quote



POST /api/quote



Body:

{

&nbsp; distance\_miles: number

}



Returns:

{

&nbsp; quote\_id: string,

&nbsp; breakdown: object,

&nbsp; total: number

}



---



\# Unified Order Submission



POST /api/orders



Body:

{

&nbsp; service\_type: "courier" | "notary",

&nbsp; region?: string,

&nbsp; customer\_email: string,



&nbsp; pickup\_address?: string,

&nbsp; delivery\_address?: string,

&nbsp; id\_address?: string,



&nbsp; scheduled\_date?: string,

&nbsp; scheduled\_time?: string,



&nbsp; total\_amount: number,

&nbsp; notes?: string,

&nbsp; pricing\_breakdown?: object

}



All portals must submit orders here.



No portal may bypass this endpoint.



---



\# Order Lifecycle



Status values:



\- pending\_admin\_review

\- approved

\- assigned

\- in\_progress

\- completed

\- cancelled



Payment status:



\- unpaid

\- paid



Status transitions are controlled by internal routes only.



---



\# Internal Routes (Unstable)



\- /admin/\*

\- /drivers/\*

\- /ops/\*



These may change without notice.



---



\# Core Rules



\- Pricing always calculated on server.

\- Frontend never calculates totals.

\- All new services must use unified /api/orders.

\- Region logic must be determined before quote request.

\- 200 responses return empty arrays when no data found.

\- 404 is used only for unknown routes.



---



\# Deployment



Required Environment Variables:



DATABASE\_URL  

NODE\_ENV  

CORS\_ALLOWED\_ORIGINS  



Deploy target:

Render



---



\# Contract Authority



If frontend and backend disagree,

backend contract wins.



Update this file whenever:



\- Endpoint structure changes

\- Pricing logic changes

\- Order lifecycle changes

