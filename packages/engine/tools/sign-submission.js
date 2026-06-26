"use strict";

/**
 * Developer utility: build a correctly-signed PoAIW submission body for testing
 * the engine and gateway. Not part of the runtime — a convenience CLI.
 *
 * Usage:
 *   node tools/sign-submission.js <privateKey> <work_type> '<output_data_json>'
 */
const { ethers } = require("ethers");
const { buildSubmissionMessage, commit } = require("../src/crypto/signature");

async function main() {
  const [pk, workType, outputDataArg] = process.argv.slice(2);
  if (!pk || !workType) {
    console.error("Usage: node tools/sign-submission.js <privateKey> <work_type> '<output_data_json>'");
    process.exit(1);
  }
  const outputData = outputDataArg || JSON.stringify({ text: "the inference output is coherent and relevant and accurate" });

  const wallet = new ethers.Wallet(pk);
  const timestamp = Date.now();
  const inputHash = commit(`input:${workType}:${timestamp}`);
  const outputHash = commit(outputData);

  const submission = {
    wallet_address: wallet.address,
    work_type: workType,
    input_hash: inputHash,
    output_hash: outputHash,
    output_data: outputData,
    timestamp,
  };
  const message = buildSubmissionMessage(submission);
  submission.signature = await wallet.signMessage(message);

  console.log(JSON.stringify(submission, null, 2));
}

main();
