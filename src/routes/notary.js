// ======================================================
// NOTARY ROUTES
// Handles notary document metadata + notary service requests
// ======================================================

const express = require("express");
const router = express.Router();
const pool = require("../utils/db");

/* ======================================================
   HELPERS
====================================================== */

function serverError(res, err, label) {
  console.error(`[NOTARY] ${label}:`, err);
  return res.status(500).json({
    ok: false,
    error: "Internal server error",
  });
}

/* ======================================================
   GET /api/notary
   - Fetch active notary document types
====================================================== */
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM notary_documents
      WHERE active = true
      ORDER BY category, document_name
    `);

    return res.status(200).json({
      ok: true,
      documents: result.rows,
    });
  } catch (err) {
    return serverError(res, err, "fetch documents");
  }
});

/* ======================================================
   GET /api/notary/:id
   - Fetch specific notary document
====================================================== */
router.get("/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      "SELECT * FROM notary_documents WHERE document_id = $1",
      [id]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        ok: false,
        error: "Notary document not found",
      });
    }

    return res.status(200).json({
      ok: true,
      document: result.rows[0],
    });
  } catch (err) {
    return serverError(res, err, "fetch single document");
  }
});

/* ======================================================
   POST /api/notary/request
   - Create a notary service order
   - Inserts into unified orders table
====================================================== */
router.post("/request", async (req, res) => {
  const {
    service_type,
    customer_name,
    customer_email,
    customer_phone,
    address,
    document_type,
    signers,
    notes,
    scheduled_date,
    scheduled_time,
  } = req.body;

  // Basic validation
  if (
    !customer_name ||
    !customer_email ||
    !customer_phone ||
    !address ||
    !document_type ||
    !scheduled_date ||
    !scheduled_time
  ) {
    return res.status(400).json({
      ok: false,
      error: "Missing required fields",
    });
  }

  try {
    const result = await pool.query(
      `
      INSERT INTO orders (
        service_type,
        customer_name,
        customer_email,
        customer_phone,
        pickup_address,
        document_type,
        signers,
        notes,
        scheduled_date,
        scheduled_time,
        status,
        created_at
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'paid', NOW()
      )
      RETURNING *
      `,
      [
        service_type || "notary",
        customer_name,
        customer_email,
        customer_phone,
        address,
        document_type,
        signers || 1,
        notes || null,
        scheduled_date,
        scheduled_time,
      ]
    );

    return res.status(201).json({
      ok: true,
      order: result.rows[0],
    });
  } catch (err) {
    return serverError(res, err, "create notary request");
  }
});

module.exports = router;