"use strict";

const { Pool } = require("pg");

/**
 * Shared access to the `users` table (channel identity -> wallet linkage). Both
 * the Telegram bot and WhatsApp agent use this so they truly share the same
 * users/miners tables.
 */
function createUserStore(connectionString) {
  const pool = new Pool({ connectionString, max: 5 });

  return {
    pool,

    /** Links a channel user to a mining wallet (and optional external wallet). */
    async registerUser(channel, channelUserId, walletAddress) {
      await pool.query(
        `INSERT INTO users (channel, channel_user_id, wallet_address)
         VALUES ($1, $2, $3)
         ON CONFLICT (channel, channel_user_id)
         DO UPDATE SET wallet_address = EXCLUDED.wallet_address`,
        [channel, String(channelUserId), walletAddress.toLowerCase()]
      );
    },

    /** Returns the linked wallet address for a channel user, or null. */
    async getUserWallet(channel, channelUserId) {
      const { rows } = await pool.query(
        `SELECT wallet_address FROM users WHERE channel = $1 AND channel_user_id = $2`,
        [channel, String(channelUserId)]
      );
      return rows[0] ? rows[0].wallet_address : null;
    },

    /** Whether a wallet is already linked to any user. */
    async walletExists(walletAddress) {
      const { rows } = await pool.query(
        `SELECT 1 FROM users WHERE wallet_address = $1 LIMIT 1`,
        [walletAddress.toLowerCase()]
      );
      return rows.length > 0;
    },

    async close() {
      await pool.end();
    },
  };
}

module.exports = { createUserStore };
