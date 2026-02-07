import express from "express";

const router = express.Router();

/**
 * Canonical Availability Endpoint
 * This endpoint is role-agnostic and tenant-scoped.
 * It ALWAYS returns 200 with an array.
 */
router.get("/", async (req, res, next) => {
  try {
    // Temporary placeholder
    // Existing scheduling logic will be wired here next
    return res.status(200).json([]);
  } catch (err) {
    next(err);
  }
});

export default router;
