// ---------------------------------------------------------------------------
// AXIS AI — real on-chain swaps against the Uniswap v4 ETH/AXIS pool (Base).
//
// The website Market widget uses this to do GENUINE swaps (no simulation):
// quotes come from the v4 Quoter, execution goes through the Universal Router
// (+ Permit2 approvals when selling AXIS) signed by the user's own injected
// wallet. Reads use a public Base RPC; writes use the wallet's RPC.
//
// Pool (on-chain):
//   v4 PoolManager singleton · poolId 0x4425a476…de16255a
//   currency0 = ETH (native, 18) · currency1 = AXIS (18) · fee 1% · tickSpacing 200 · no hooks
// USD prices are derived from the pool's ETH price × a Chainlink ETH/USD feed.
// ---------------------------------------------------------------------------

import {
  type Address,
  createPublicClient,
  createWalletClient,
  custom,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  type Hex,
  http,
  maxUint256,
} from "viem";
import { base } from "viem/chains";

export const CHAIN_ID = 8453;
export const CHAIN_HEX = "0x2105";
const RPC =
  (import.meta.env?.VITE_BASE_RPC_URL as string | undefined) ||
  "https://base-rpc.publicnode.com";

// Tokens (Base mainnet). In v4 native ETH is the zero address.
export const AXIS = "0x6DBBd1910BeFC6736b818d4DcaD3ff833b9e06D7" as Address;
export const ETH = "0x0000000000000000000000000000000000000000" as Address;
export const AXIS_DECIMALS = 18;
export const ETH_DECIMALS = 18;

// Uniswap v4 infrastructure (Base) — from docs.uniswap.org deployments
const STATE_VIEW = "0xa3c0c9b65bad0b08107aa264b0f3db444b867a71" as Address;
const V4_QUOTER = "0x0d5e0f971ed27fbff6c2837bf31316121532048d" as Address;
const UNIVERSAL_ROUTER =
  "0x6ff5693b99212da76ad316178a184ab56d299b43" as Address;
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address;
const HOOKS_NONE = "0x0000000000000000000000000000000000000000" as Address;

// Chainlink ETH/USD feed on Base (8 decimals) — turns the pool's ETH price into
// a USD display price.
const CHAINLINK_ETH_USD =
  "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70" as Address;

// Deterministic poolId (keccak256 of the PoolKey) — verified initialized + funded.
const POOL_ID =
  "0x4425a476a588b210c430062cfa30a7adc26fae4dbb1ddb2b8db488bbde16255a" as Hex;

// PoolKey: currency0 = ETH (native, 0x0) < currency1 = AXIS, 1% fee,
// tickSpacing 200, no hooks.
const POOL_KEY = {
  currency0: ETH,
  currency1: AXIS,
  fee: 10000,
  tickSpacing: 200,
  hooks: HOOKS_NONE,
} as const;

// ABI fragments ------------------------------------------------------------

const ERC20_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "address" }, { type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "uint256" }],
    outputs: [{ type: "bool" }],
  },
] as const;

const STATE_VIEW_ABI = [
  {
    name: "getSlot0",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }],
    outputs: [
      { type: "uint160", name: "sqrtPriceX96" },
      { type: "int24", name: "tick" },
      { type: "uint24", name: "protocolFee" },
      { type: "uint24", name: "lpFee" },
    ],
  },
] as const;

const CHAINLINK_ABI = [
  {
    name: "latestRoundData",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { type: "uint80", name: "roundId" },
      { type: "int256", name: "answer" },
      { type: "uint256", name: "startedAt" },
      { type: "uint256", name: "updatedAt" },
      { type: "uint80", name: "answeredInRound" },
    ],
  },
] as const;

const POOLKEY_COMPONENTS = [
  { name: "currency0", type: "address" },
  { name: "currency1", type: "address" },
  { name: "fee", type: "uint24" },
  { name: "tickSpacing", type: "int24" },
  { name: "hooks", type: "address" },
] as const;

const QUOTER_ABI = [
  {
    name: "quoteExactInputSingle",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "poolKey", type: "tuple", components: POOLKEY_COMPONENTS },
          { name: "zeroForOne", type: "bool" },
          { name: "exactAmount", type: "uint128" },
          { name: "hookData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

const PERMIT2_ABI = [
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "address" }, { type: "address" }, { type: "address" }],
    outputs: [{ type: "uint160" }, { type: "uint48" }, { type: "uint48" }],
  },
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { type: "address" },
      { type: "address" },
      { type: "uint160" },
      { type: "uint48" },
    ],
    outputs: [],
  },
] as const;

const UNIVERSAL_ROUTER_ABI = [
  {
    name: "execute",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "commands", type: "bytes" },
      { name: "inputs", type: "bytes[]" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

// Universal Router command + v4 action opcodes.
const CMD_V4_SWAP = "0x10" as Hex;
const ACTIONS_EXACT_IN = "0x060c0f" as Hex; // SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL
const MAX_UINT160 = (1n << 160n) - 1n;
// viem types uint48 as a JS number; 2^48-1 fits safely under Number.MAX_SAFE_INTEGER.
const MAX_UINT48 = 281_474_976_710_655;

// Provider / clients -------------------------------------------------------

type Eip1193 = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, cb: (...a: unknown[]) => void) => void;
  removeListener?: (event: string, cb: (...a: unknown[]) => void) => void;
};

export function injected(): Eip1193 | null {
  if (typeof window === "undefined") return null;
  const eth = (window as unknown as { ethereum?: Eip1193 }).ethereum;
  return eth ?? null;
}

export function hasWallet(): boolean {
  return !!injected();
}

export const publicClient = createPublicClient({
  chain: base,
  transport: http(RPC),
});

function walletClient(account: string) {
  const eth = injected();
  if (!eth) throw new Error("No browser wallet found.");
  return createWalletClient({
    account: getAddress(account),
    chain: base,
    transport: custom(eth),
  });
}

async function ensureBaseChain(eth: Eip1193): Promise<void> {
  const cid = (await eth.request({ method: "eth_chainId" })) as string;
  if (Number.parseInt(cid, 16) === CHAIN_ID) return;
  try {
    await eth.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: CHAIN_HEX }],
    });
  } catch (e: unknown) {
    if ((e as { code?: number })?.code === 4902) {
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: CHAIN_HEX,
            chainName: "Base",
            nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
            rpcUrls: ["https://mainnet.base.org"],
            blockExplorerUrls: ["https://basescan.org"],
          },
        ],
      });
    } else {
      throw e;
    }
  }
}

/** Prompts the wallet to connect and ensures it's on Base. Returns the address. */
export async function connectWallet(): Promise<string> {
  const eth = injected();
  if (!eth)
    throw new Error(
      "No wallet found. Install MetaMask or Coinbase Wallet to trade.",
    );
  const accounts = (await eth.request({
    method: "eth_requestAccounts",
  })) as string[];
  if (!accounts?.length) throw new Error("No account authorized.");
  await ensureBaseChain(eth);
  return getAddress(accounts[0]);
}

/** Returns the already-authorized address (no prompt), or null. */
export async function currentAccount(): Promise<string | null> {
  const eth = injected();
  if (!eth) return null;
  try {
    const accounts = (await eth.request({
      method: "eth_accounts",
    })) as string[];
    return accounts?.length ? getAddress(accounts[0]) : null;
  } catch {
    return null;
  }
}

// Reads --------------------------------------------------------------------

export type Balances = { ethRaw: bigint; axisRaw: bigint };

export async function getBalances(account: string): Promise<Balances> {
  const owner = getAddress(account);
  const [ethRaw, axisRaw] = await Promise.all([
    publicClient.getBalance({ address: owner }),
    publicClient.readContract({
      address: AXIS,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [owner],
    }) as Promise<bigint>,
  ]);
  return { ethRaw, axisRaw };
}

/** Live pool price: ETH per 1 AXIS, from the pool's sqrtPriceX96. */
export async function getSpotEth(): Promise<number> {
  const slot0 = (await publicClient.readContract({
    address: STATE_VIEW,
    abi: STATE_VIEW_ABI,
    functionName: "getSlot0",
    args: [POOL_ID],
  })) as readonly [bigint, number, number, number];
  // currency0 = ETH, currency1 = AXIS (both 18dp) → ratio = AXIS per ETH.
  const axisPerEth = (Number(slot0[0]) / 2 ** 96) ** 2;
  return axisPerEth > 0 ? 1 / axisPerEth : 0; // ETH per AXIS
}

/** ETH/USD from the Chainlink feed on Base. */
export async function getEthUsd(): Promise<number> {
  const data = (await publicClient.readContract({
    address: CHAINLINK_ETH_USD,
    abi: CHAINLINK_ABI,
    functionName: "latestRoundData",
  })) as readonly [bigint, bigint, bigint, bigint, bigint];
  return Number(data[1]) / 1e8; // feed has 8 decimals
}

/** Live spot price: 1 AXIS in USD (pool ETH price × Chainlink ETH/USD). */
export async function getSpotPrice(): Promise<number> {
  const [ethPerAxis, ethUsd] = await Promise.all([getSpotEth(), getEthUsd()]);
  return ethPerAxis * ethUsd;
}

export type Side = "buy" | "sell";

/**
 * Quote an exact-input swap against the live pool (read-only eth_call).
 * buy  → input ETH, output AXIS (zeroForOne = true, ETH is currency0)
 * sell → input AXIS, output ETH (zeroForOne = false)
 */
export async function quoteExactIn(
  side: Side,
  amountInRaw: bigint,
): Promise<bigint> {
  const zeroForOne = side === "buy";
  const data = encodeFunctionData({
    abi: QUOTER_ABI,
    functionName: "quoteExactInputSingle",
    args: [
      {
        poolKey: POOL_KEY,
        zeroForOne,
        exactAmount: amountInRaw,
        hookData: "0x",
      },
    ],
  });
  const { data: ret } = await publicClient.call({ to: V4_QUOTER, data });
  if (!ret) throw new Error("No quote returned.");
  const decoded = decodeFunctionResult({
    abi: QUOTER_ABI,
    functionName: "quoteExactInputSingle",
    data: ret,
  }) as readonly [bigint, bigint];
  return decoded[0];
}

// Writes -------------------------------------------------------------------

/** Returns how many approval steps are still required for `inputToken`. */
export async function approvalsNeeded(
  account: string,
  inputToken: Address,
  amount: bigint,
): Promise<number> {
  // Native ETH (buys) needs no ERC-20 / Permit2 approval.
  if (inputToken.toLowerCase() === ETH.toLowerCase()) return 0;
  const owner = getAddress(account);
  let steps = 0;
  const erc20Allowance = (await publicClient.readContract({
    address: inputToken,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [owner, PERMIT2],
  })) as bigint;
  if (erc20Allowance < amount) steps += 1;
  const p2 = (await publicClient.readContract({
    address: PERMIT2,
    abi: PERMIT2_ABI,
    functionName: "allowance",
    args: [owner, inputToken, UNIVERSAL_ROUTER],
  })) as readonly [bigint, number, number];
  const now = Math.floor(Date.now() / 1000);
  if (p2[0] < amount || Number(p2[1]) < now) steps += 1;
  return steps;
}

/**
 * Ensures the Universal Router can pull `amount` of `inputToken` via Permit2,
 * sending approval transactions as needed (each awaited to confirmation).
 */
export async function ensureAllowances(
  account: string,
  inputToken: Address,
  amount: bigint,
  onStep?: (msg: string) => void,
): Promise<void> {
  // Native ETH (buys) is sent as msg.value — no approval flow.
  if (inputToken.toLowerCase() === ETH.toLowerCase()) return;
  const owner = getAddress(account);
  const wc = walletClient(account);

  // 1) ERC20 → Permit2 (one-time max approval).
  const erc20Allowance = (await publicClient.readContract({
    address: inputToken,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [owner, PERMIT2],
  })) as bigint;
  if (erc20Allowance < amount) {
    onStep?.("Approve token for Permit2 — confirm in your wallet…");
    const hash = await wc.writeContract({
      address: inputToken,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [PERMIT2, maxUint256],
    });
    await publicClient.waitForTransactionReceipt({ hash });
  }

  // 2) Permit2 → Universal Router (max amount, far-future expiration).
  const p2 = (await publicClient.readContract({
    address: PERMIT2,
    abi: PERMIT2_ABI,
    functionName: "allowance",
    args: [owner, inputToken, UNIVERSAL_ROUTER],
  })) as readonly [bigint, number, number];
  const now = Math.floor(Date.now() / 1000);
  if (p2[0] < amount || Number(p2[1]) < now) {
    onStep?.("Approve token for Uniswap router — confirm in your wallet…");
    const hash = await wc.writeContract({
      address: PERMIT2,
      abi: PERMIT2_ABI,
      functionName: "approve",
      args: [inputToken, UNIVERSAL_ROUTER, MAX_UINT160, MAX_UINT48],
    });
    await publicClient.waitForTransactionReceipt({ hash });
  }
}

/**
 * Executes an exact-input swap via the Universal Router (v4 single-hop).
 * Returns the transaction hash. Caller must have ensured allowances.
 */
export async function swapExactIn(
  account: string,
  side: Side,
  amountInRaw: bigint,
  minOutRaw: bigint,
): Promise<Hex> {
  const zeroForOne = side === "buy"; // buy = ETH(c0) → AXIS(c1)
  const inputCurrency = side === "buy" ? ETH : AXIS;
  const outputCurrency = side === "buy" ? AXIS : ETH;

  const swapParam = encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "poolKey", type: "tuple", components: POOLKEY_COMPONENTS },
          { name: "zeroForOne", type: "bool" },
          { name: "amountIn", type: "uint128" },
          { name: "amountOutMinimum", type: "uint128" },
          { name: "hookData", type: "bytes" },
        ],
      },
    ],
    [
      {
        poolKey: POOL_KEY,
        zeroForOne,
        amountIn: amountInRaw,
        amountOutMinimum: minOutRaw,
        hookData: "0x",
      },
    ],
  );
  const settleParam = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }],
    [inputCurrency, amountInRaw],
  );
  const takeParam = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }],
    [outputCurrency, minOutRaw],
  );
  const input = encodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes[]" }],
    [ACTIONS_EXACT_IN, [swapParam, settleParam, takeParam]],
  );
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200); // 20 min

  const wc = walletClient(account);
  return wc.writeContract({
    address: UNIVERSAL_ROUTER,
    abi: UNIVERSAL_ROUTER_ABI,
    functionName: "execute",
    args: [CMD_V4_SWAP, [input], deadline],
    // Buys pay native ETH — forward it as msg.value. Sells send no ETH.
    value: side === "buy" ? amountInRaw : 0n,
  });
}

export function inputTokenFor(side: Side): Address {
  return side === "sell" ? AXIS : ETH;
}

export { POOL_ID, UNIVERSAL_ROUTER };
