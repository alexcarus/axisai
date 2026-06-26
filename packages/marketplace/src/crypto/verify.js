"use strict";

const { ethers } = require("ethers");

/**
 * Ownership / authorisation verification via signed messages. Each mutating
 * endpoint reconstructs the canonical message from the request payload and
 * checks that the supplied signature recovers to the claimed wallet — so a
 * caller can only act for a wallet they control.
 */

/** Canonical marketplace action messages. */
const messages = {
  publish: (owner, name, price) => `AXIS-MKT|publish|${owner.toLowerCase()}|${name}|${price}`,
  rate: (wallet, modelId, stars) => `AXIS-MKT|rate|${wallet.toLowerCase()}|${modelId}|${stars}`,
  deleteModel: (owner, modelId) => `AXIS-MKT|delete-model|${owner.toLowerCase()}|${modelId}`,
  jobRequest: (requester, modelId, maxPrice) =>
    `AXIS-MKT|job-request|${requester.toLowerCase()}|${modelId}|${maxPrice}`,
  jobDeliver: (provider, jobId) => `AXIS-MKT|job-deliver|${provider.toLowerCase()}|${jobId}`,
  capacityOffer: (provider, units, price, expiry) =>
    `AXIS-MKT|capacity-offer|${provider.toLowerCase()}|${units}|${price}|${expiry}`,
  capacityPurchase: (buyer, offerId, units) =>
    `AXIS-MKT|capacity-purchase|${buyer.toLowerCase()}|${offerId}|${units}`,
};

/**
 * Verifies a signature over an expected message recovers to `wallet`.
 * @returns {boolean}
 */
function verify(wallet, expectedMessage, signature) {
  try {
    if (!wallet || !signature) return false;
    const recovered = ethers.verifyMessage(expectedMessage, signature);
    return recovered.toLowerCase() === String(wallet).toLowerCase();
  } catch (_) {
    return false;
  }
}

module.exports = { messages, verify };
