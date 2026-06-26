"use strict";

const { ethers } = require("ethers");
const { gateway, walletFor, isRegistered, userStore, CHANNEL } = require("./context");
const wa = require("./whatsapp");
const { getCooldown, markCooldown, updateSession } = require("./session");
const config = require("./config");
const logger = require("./logger");
const {
  WORK_TYPES,
  getWorkType,
  isValidWorkType,
  estimateReward,
  progressBar,
  truncateAddress,
  formatAxis,
  formatPercent,
} = require("@axis/shared");

const GENESIS_SUPPLY = 21_000_000;

const EPOCH_BOUNDS = {
  1: [0, 5_250_000],
  2: [5_250_000, 10_500_000],
  3: [10_500_000, 15_750_000],
  4: [15_750_000, 21_000_000],
  5: [21_000_000, 63_000_000],
  6: [63_000_000, 79_800_000],
  7: [79_800_000, 84_000_000],
};

async function fetchStats(waId) {
  const { body } = await gateway.networkStats(walletFor(waId));
  return body || {};
}

// ----------------------------- Flow handlers ----------------------------- //

async function onboardingIntro(waId) {
  let stats = {};
  try {
    stats = await fetchStats(waId);
  } catch (_) {
    /* best effort */
  }
  const totalMined = Number(stats.total_mined_axis || 0);
  const fraction = Math.min(1, totalMined / GENESIS_SUPPLY);
  const body =
    "⚡ *Welcome to AXIS AI* — Proof-of-AI-Work mining.\n\n" +
    "AXIS turns AI computation into a mineable digital commodity. Fixed supply: 84,000,000 AXIS. No premine, no admin keys.\n\n" +
    "*🌱 Genesis Phase*\n" +
    `Epoch: ${stats.epoch ?? "—"}\n` +
    `Reward/unit: ${stats.base_reward_axis ?? "—"} AXIS\n` +
    `Total mined: ${formatAxis(totalMined)} / 21,000,000 AXIS\n` +
    `${progressBar(fraction)} ${(fraction * 100).toFixed(2)}%\n\n` +
    "To begin, reply with your *EVM wallet address* (0x…) to register.";
  await wa.sendText(waId, body);
}

async function registerWallet(waId, providedAddress) {
  const wallet = walletFor(waId);
  await userStore.registerUser(CHANNEL, waId, wallet.address);
  let balance = "0";
  try {
    const { body } = await gateway.miner(wallet);
    balance = body.total_axis_earned ?? "0";
  } catch (_) {
    /* best effort */
  }
  const body =
    "✅ *Registration complete!*\n\n" +
    "Your AXIS mining wallet (holds all rewards):\n" +
    `${wallet.address}\n(${truncateAddress(wallet.address)})\n` +
    (providedAddress ? `Linked reference: ${providedAddress}\n` : "") +
    `\nAXIS earned: ${balance}\n\n` +
    'Reply *mine* to choose a work type.';
  await wa.sendText(waId, body);
}

async function mineList(waId) {
  let stats = {};
  try {
    stats = await fetchStats(waId);
  } catch (_) {
    /* best effort */
  }
  const base = stats.base_reward_axis || 0;
  const difficulty = stats.difficulty || 1;
  const rows = WORK_TYPES.map((wt) => ({
    id: `mine_${wt.id}`,
    title: wt.label.replace(/[^\x20-\x7E]/g, "").trim() || wt.id,
    description: `~${formatAxis(estimateReward(wt.id, base, difficulty))} AXIS · ${wt.id}`,
  }));
  await wa.sendList(
    waId,
    "⛏️ Mine AXIS",
    `Choose a work type. Reward/unit: ${base} AXIS · D=${difficulty}. Actual reward = W × Q ÷ D.`,
    "Work Types",
    rows
  );
}

async function sendTask(waId, workTypeId) {
  const wt = getWorkType(workTypeId);
  if (!wt) return wa.sendText(waId, "Unknown work type. Reply *mine* to see options.");
  await updateSession(waId, { lastWorkType: wt.id });
  const sample = wt.sample();
  const body =
    `*${wt.label} — Task*\n\n${wt.instructions}\n\n` +
    "To submit, send:\n" +
    `submit ${wt.id} <your_output_json>\n\n` +
    "Or submit this ready sample:\n" +
    `submit ${wt.id} ${sample}`;
  await wa.sendButtons(waId, body.slice(0, 1000), [
    { id: `submitsample_${wt.id}`, title: "Submit sample" },
  ]);
}

async function doSubmit(waId, workType, outputData) {
  if (!(await isRegistered(waId))) {
    return wa.sendText(waId, "Please register first — reply with your EVM wallet address (0x…).");
  }
  if (!isValidWorkType(workType)) {
    return wa.sendText(waId, "Unknown work type. Reply *mine* to see the 7 options.");
  }
  const cd = await getCooldown(waId);
  if (cd > 0) {
    return wa.sendText(waId, `⏳ Cooldown active. Please wait ${cd}s before submitting again.`);
  }

  const wallet = walletFor(waId);
  const payload = outputData && outputData.trim().length ? outputData.trim() : getWorkType(workType).sample();

  try {
    const { status, body } = await gateway.submit(wallet, workType, payload, "whatsapp");
    if (status === 202 || status === 200) {
      await markCooldown(waId, config.submitCooldownSeconds);
      return wa.sendText(
        waId,
        "📤 *Submission accepted!*\n" +
          `Work type: ${workType}\n` +
          `Job ID: ${body.job_id}\n` +
          `Est. processing: ~${body.estimated_processing_seconds ?? 5}s\n` +
          (body.estimated_max_reward_axis ? `Est. max reward: ${body.estimated_max_reward_axis} AXIS\n` : "") +
          `\nCheck progress: status ${body.job_id}`
      );
    }
    if (status === 429) {
      return wa.sendText(waId, `⏳ Rate limited. Retry after ${body.retry_after_seconds ?? 60}s.`);
    }
    return wa.sendText(waId, `❌ Rejected: ${body.error || body.reason || "unknown error"}`);
  } catch (err) {
    logger.error("wa submit failed", { error: err.message });
    return wa.sendText(waId, "⚠️ Submission failed (gateway unreachable). Try again shortly.");
  }
}

async function statusFlow(waId, jobId) {
  try {
    const { status, body } = await gateway.status(walletFor(waId), jobId);
    if (status === 404) return wa.sendText(waId, `❌ Job not found: ${jobId}`);
    if (status >= 400) return wa.sendText(waId, `⚠️ ${body.error || "could not fetch status"}`);
    let msg = `*Job ${body.status}*\nJob ID: ${body.job_id}\nWork type: ${body.work_type}\n`;
    if (body.quality != null) msg += `Quality Q: ${Number(body.quality).toFixed(3)}\n`;
    if (body.status === "approved") {
      msg += `Reward: ${body.reward_axis} AXIS\n`;
      if (body.tx_hash) msg += `Tx: ${body.tx_hash}\n`;
    }
    if (body.status === "rejected" && body.reject_reason) msg += `Reason: ${body.reject_reason}\n`;
    return wa.sendText(waId, msg);
  } catch (err) {
    logger.error("wa status failed", { error: err.message });
    return wa.sendText(waId, "⚠️ Could not fetch status. Try again shortly.");
  }
}

async function balanceFlow(waId) {
  if (!(await isRegistered(waId))) {
    return wa.sendText(waId, "Please register first — reply with your EVM wallet address (0x…).");
  }
  try {
    const wallet = walletFor(waId);
    const { body } = await gateway.miner(wallet);
    const msg =
      "*💰 Your AXIS Balance*\n" +
      `${truncateAddress(wallet.address)}\n\n` +
      `Total earned: ${formatAxis(body.total_axis_earned)} AXIS\n` +
      `Submissions: ${body.total_submitted ?? 0}\n` +
      `Verified: ${body.total_verified ?? 0}\n` +
      `Verification rate: ${formatPercent((body.verification_rate || 0) * 100)}`;
    return wa.sendText(waId, msg);
  } catch (err) {
    logger.error("wa balance failed", { error: err.message });
    return wa.sendText(waId, "⚠️ Could not fetch balance. Try again shortly.");
  }
}

async function epochFlow(waId) {
  try {
    const stats = await fetchStats(waId);
    const epoch = Number(stats.epoch || 1);
    const totalMined = Number(stats.total_mined_axis || 0);
    const [start, end] = EPOCH_BOUNDS[epoch] || [0, 84_000_000];
    const minedThisEpoch = Math.max(0, totalMined - start);
    const target = end - start;
    const fraction = target > 0 ? Math.min(1, minedThisEpoch / target) : 1;
    const msg =
      `*📅 Epoch ${epoch}*\n` +
      `Reward/unit: ${stats.base_reward_axis} AXIS\n` +
      `Mined this epoch: ${formatAxis(minedThisEpoch)} / ${formatAxis(target)} AXIS\n` +
      `${progressBar(fraction)} ${(fraction * 100).toFixed(2)}%\n` +
      `Difficulty D: ${stats.difficulty}`;
    return wa.sendText(waId, msg);
  } catch (err) {
    logger.error("wa epoch failed", { error: err.message });
    return wa.sendText(waId, "⚠️ Could not load epoch data. Try again shortly.");
  }
}

async function networkFlow(waId) {
  try {
    const stats = await fetchStats(waId);
    const msg =
      "*🌐 AXIS Network*\n" +
      `Difficulty D: ${stats.difficulty}\n` +
      `Epoch: ${stats.epoch}\n` +
      `Reward/unit: ${stats.base_reward_axis} AXIS\n` +
      `Total mined: ${formatAxis(stats.total_mined_axis)} / ${formatAxis(stats.max_supply_axis)} AXIS\n` +
      `Supply mined: ${formatPercent(stats.percent_of_supply_mined || 0)}\n` +
      `Active miners (24h): ${stats.active_miners_24h ?? 0}`;
    return wa.sendText(waId, msg);
  } catch (err) {
    logger.error("wa network failed", { error: err.message });
    return wa.sendText(waId, "⚠️ Could not load network stats. Try again shortly.");
  }
}

async function leaderboardFlow(waId) {
  try {
    const wallet = walletFor(waId);
    const { body } = await gateway.leaderboard(wallet);
    const board = body.leaderboard || [];
    if (board.length === 0) return wa.sendText(waId, "🏆 No verified mining yet this epoch.");
    const me = wallet.address.toLowerCase();
    const lines = board.slice(0, 10).map((r) => {
      const tag = r.wallet_address.toLowerCase() === me ? " 👈 you" : "";
      const medal = r.rank === 1 ? "🥇" : r.rank === 2 ? "🥈" : r.rank === 3 ? "🥉" : `${r.rank}.`;
      return `${medal} ${truncateAddress(r.wallet_address)} — ${formatAxis(r.axis_earned)} AXIS${tag}`;
    });
    return wa.sendText(waId, `*🏆 Top miners — Epoch ${body.epoch ?? "—"}*\n` + lines.join("\n"));
  } catch (err) {
    logger.error("wa leaderboard failed", { error: err.message });
    return wa.sendText(waId, "⚠️ Could not load leaderboard. Try again shortly.");
  }
}

function helpFlow(waId) {
  const msg =
    "*⚡ AXIS AI — Commands*\n\n" +
    "Send your *0x… wallet* to register\n" +
    "*mine* — choose a work type\n" +
    "*submit <type> <output>* — submit work\n" +
    "*status <job_id>* — check a submission\n" +
    "*balance* — your AXIS earned\n" +
    "*epoch* — epoch progress\n" +
    "*network* — network stats\n" +
    "*leaderboard* — top miners\n" +
    "*help* — this menu\n\n" +
    "Reward formula: AXIS = W × Q ÷ D";
  return wa.sendText(waId, msg);
}

// ------------------------------- Router ---------------------------------- //

/**
 * Main message router. Handles text and interactive (list/button) replies.
 * @param {string} waId  WhatsApp user id (phone number).
 * @param {object} msg   { text?:string, interactiveId?:string }
 */
async function handleMessage(waId, msg) {
  const interactiveId = msg.interactiveId;
  const text = (msg.text || "").trim();
  const lower = text.toLowerCase();

  try {
    // Interactive replies (list selections / button taps).
    if (interactiveId) {
      if (interactiveId.startsWith("mine_")) return await sendTask(waId, interactiveId.slice(5));
      if (interactiveId.startsWith("submitsample_")) {
        const wt = getWorkType(interactiveId.slice("submitsample_".length));
        if (wt) return await doSubmit(waId, wt.id, wt.sample());
      }
      if (interactiveId === "menu_mine") return await mineList(waId);
      if (interactiveId === "menu_help") return helpFlow(waId);
      return helpFlow(waId);
    }

    // Read-only commands available pre-registration.
    if (lower === "help" || lower === "menu") return helpFlow(waId);
    if (lower === "epoch") return await epochFlow(waId);
    if (lower === "network") return await networkFlow(waId);

    const registered = await isRegistered(waId);

    // Onboarding: register when an EVM address is sent.
    if (ethers.isAddress(text)) {
      return await registerWallet(waId, text);
    }
    if (!registered) {
      return await onboardingIntro(waId);
    }

    // Registered command routing.
    if (lower === "mine") return await mineList(waId);
    if (lower.startsWith("submit ")) {
      const rest = text.slice("submit ".length).trim();
      const sp = rest.indexOf(" ");
      const workType = sp === -1 ? rest : rest.slice(0, sp);
      const output = sp === -1 ? "" : rest.slice(sp + 1);
      return await doSubmit(waId, workType, output);
    }
    if (lower.startsWith("status ")) return await statusFlow(waId, text.slice("status ".length).trim());
    if (lower === "balance") return await balanceFlow(waId);
    if (lower === "leaderboard") return await leaderboardFlow(waId);

    // Graceful fallback.
    return helpFlow(waId);
  } catch (err) {
    logger.error("handleMessage failed", { error: err.message, stack: err.stack });
    return wa.sendText(waId, "⚠️ Something went wrong. Reply *help* for the menu.");
  }
}

module.exports = { handleMessage };
