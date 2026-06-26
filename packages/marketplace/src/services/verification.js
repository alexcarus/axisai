"use strict";

const config = require("../config");
const logger = require("../logger");

/**
 * Routes a compute-job delivery output to the PoAIW verification engine's
 * scoring-only endpoint (`POST /score`) and returns the quality and a pass/fail
 * decision against the configured minimum quality.
 */
async function scoreDelivery(workType, outputData) {
  try {
    const headers = { "Content-Type": "application/json" };
    if (config.engineInternalKey) headers["x-internal-key"] = config.engineInternalKey;
    const res = await fetch(`${config.engineUrl}/score`, {
      method: "POST",
      headers,
      body: JSON.stringify({ work_type: workType, output_data: outputData }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      logger.error("engine /score error", { status: res.status, body });
      return { quality: 0, passed: false, error: body.error || `engine ${res.status}` };
    }
    const quality = Number(body.quality || 0);
    return { quality, passed: quality >= config.jobs.minQuality, details: body.details };
  } catch (err) {
    logger.error("scoreDelivery failed", { error: err.message });
    return { quality: 0, passed: false, error: err.message };
  }
}

module.exports = { scoreDelivery };
