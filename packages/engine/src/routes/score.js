"use strict";

const express = require("express");
const { scoreSubmission, isValidWorkType } = require("../scoring");
const { parseOutput } = require("../pipeline/verify");
const logger = require("../logger");

const router = express.Router();

/**
 * POST /score — scoring-only endpoint (no minting, no persistence). Used by the
 * marketplace to route compute-job deliveries to the PoAIW engine for quality
 * scoring before escrow settlement.
 *
 * Body: { work_type, output_data, peer_context? }
 * Returns: { quality, details }
 */
router.post("/score", async (req, res) => {
  try {
    const { work_type, output_data, peer_context } = req.body || {};
    if (!isValidWorkType(work_type)) {
      return res.status(400).json({ error: `unsupported work_type: ${work_type}` });
    }
    const parsed = parseOutput(output_data);
    const { quality, details } = scoreSubmission(work_type, parsed, peer_context || {});
    return res.json({ quality, details });
  } catch (err) {
    logger.error("POST /score failed", { error: err.message });
    return res.status(500).json({ error: "internal error" });
  }
});

module.exports = router;
