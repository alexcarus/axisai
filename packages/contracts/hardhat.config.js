require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const {
  RPC_URL,
  DEPLOYER_PRIVATE_KEY,
  ETHERSCAN_API_KEY,
  CHAIN_ID,
  // Base-specific overrides (fall back to the public RPCs / a private one).
  BASE_RPC_URL,
  BASE_SEPOLIA_RPC_URL,
  BASESCAN_API_KEY,
} = process.env;

// Only attach an accounts array when a real key is configured, so read-only
// commands (and the local node) work without one.
const deployerAccounts = DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [];

/**
 * Hardhat configuration for the AXIS AI protocol contracts.
 * Networks and keys are fully driven by environment variables — nothing secret
 * is hardcoded. See .env.example for the required variables.
 */
module.exports = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
    },
    localhost: {
      url: RPC_URL || "http://127.0.0.1:8545",
      chainId: CHAIN_ID ? Number(CHAIN_ID) : 31337,
      accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : undefined,
    },
    // Base mainnet (chainId 8453). Real ETH gas, permanent deployment.
    base: {
      url: BASE_RPC_URL || RPC_URL || "https://mainnet.base.org",
      chainId: 8453,
      accounts: deployerAccounts,
    },
    // Base Sepolia testnet (chainId 84532). Free faucet ETH.
    baseSepolia: {
      url: BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
      chainId: 84532,
      accounts: deployerAccounts,
    },
    // Generic env-driven network (RPC_URL + CHAIN_ID).
    custom: {
      url: RPC_URL || "http://127.0.0.1:8545",
      chainId: CHAIN_ID ? Number(CHAIN_ID) : undefined,
      accounts: deployerAccounts,
    },
  },
  etherscan: {
    // Etherscan V2 unified API — a single key routes by chainId (Base = 8453,
    // Base Sepolia = 84532). Basescan keys work through the V2 endpoint.
    apiKey: BASESCAN_API_KEY || ETHERSCAN_API_KEY || "",
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
};
