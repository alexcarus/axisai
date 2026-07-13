// ---------------------------------------------------------------------------
// AXIS AI — swaps on Robinhood Chain (ETH ⇄ AXIS).  ⚠️ NOT YET LIVE.
//
// This mirrors ../lib/uniswap-v4.ts (Base) but targets Robinhood Chain and the
// bridged AXIS (the OFT). It CANNOT run until:
//   1. A DEX pool exists on Robinhood Chain (seed ETH + bridged AXIS), and
//   2. You fill in the four TODO_VERIFY addresses below with the DEX's real,
//      explorer-VERIFIED contract addresses on Robinhood Chain.
//
// Assumes Uniswap v4 (same interfaces as Base). If Robinhood Chain uses a
// different DEX, swap the ABIs/addresses accordingly — the swap flow is the same.
// `isConfigured()` returns false until the addresses are set; every call guards
// on it, so importing this file is safe and can't accidentally hit a wrong pool.
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
  keccak256,
  maxUint256,
} from "viem";
import { robinhood } from "./bridge";

export const CHAIN_ID = 4663;
export const CHAIN_HEX = "0x1237";
const RPC = "https://rpc.mainnet.chain.robinhood.com";

// Tokens on Robinhood Chain. AXIS here is the bridged OFT representation.
export const AXIS = "0xcDbEb868D5955C04aD3A471388b5ebAeE65AcaE4" as Address; // AxisOFT
export const ETH = "0x0000000000000000000000000000000000000000" as Address; // native (v4 currency0)
export const AXIS_DECIMALS = 18;

// Permit2 is deployed at the same deterministic address on every chain.
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address;
const HOOKS_NONE = "0x0000000000000000000000000000000000000000" as Address;

// ⚠️ TODO_VERIFY — Uniswap v4 (or the chosen DEX) contracts on Robinhood Chain.
// Get these from the official deployments list and CONFIRM each on
// robinhoodchain.blockscout.com before any real trade. Leave as-is until then.
const TODO = "0x0000000000000000000000000000000000000000" as Address;
const STATE_VIEW: Address = TODO; // TODO_VERIFY
const V4_QUOTER: Address = TODO; // TODO_VERIFY
const UNIVERSAL_ROUTER: Address = TODO; // TODO_VERIFY

// Pool params — mirror Base: currency0 = ETH (0x0) < currency1 = AXIS, 1% fee,
// tickSpacing 200, no hooks. Seed the Robinhood pool with THESE params so the
// derived poolId matches.
const POOL_FEE = 10000;
const TICK_SPACING = 200;
const POOL_KEY = { currency0: ETH, currency1: AXIS, fee: POOL_FEE, tickSpacing: TICK_SPACING, hooks: HOOKS_NONE } as const;

const POOLKEY_COMPONENTS = [
  { name: "currency0", type: "address" },
  { name: "currency1", type: "address" },
  { name: "fee", type: "uint24" },
  { name: "tickSpacing", type: "int24" },
  { name: "hooks", type: "address" },
] as const;

// Deterministic poolId = keccak256(abi.encode(PoolKey)). Valid once the pool is
// initialized on-chain with the exact params above.
export const POOL_ID = keccak256(
  encodeAbiParameters([{ type: "tuple", components: POOLKEY_COMPONENTS }], [POOL_KEY]),
) as Hex;

/** True once the DEX addresses are filled in — every write/quote guards on this. */
export function isConfigured(): boolean {
  return [STATE_VIEW, V4_QUOTER, UNIVERSAL_ROUTER].every((a) => a !== TODO);
}
function assertConfigured() {
  if (!isConfigured())
    throw new Error(
      "Robinhood swap is not configured yet — seed a pool and set the verified DEX addresses in robinhood-swap.ts.",
    );
}

// ABIs (identical shapes to the Base v4 lib) ---------------------------------

const ERC20_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "allowance", type: "function", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;
const STATE_VIEW_ABI = [
  { name: "getSlot0", type: "function", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint160" }, { type: "int24" }, { type: "uint24" }, { type: "uint24" }] },
] as const;
const QUOTER_ABI = [
  {
    name: "quoteExactInputSingle", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "params", type: "tuple", components: [{ name: "poolKey", type: "tuple", components: POOLKEY_COMPONENTS }, { name: "zeroForOne", type: "bool" }, { name: "exactAmount", type: "uint128" }, { name: "hookData", type: "bytes" }] }],
    outputs: [{ name: "amountOut", type: "uint256" }, { name: "gasEstimate", type: "uint256" }],
  },
] as const;
const PERMIT2_ABI = [
  { name: "allowance", type: "function", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }, { type: "address" }], outputs: [{ type: "uint160" }, { type: "uint48" }, { type: "uint48" }] },
  { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "address" }, { type: "uint160" }, { type: "uint48" }], outputs: [] },
] as const;
const UNIVERSAL_ROUTER_ABI = [
  { name: "execute", type: "function", stateMutability: "payable", inputs: [{ name: "commands", type: "bytes" }, { name: "inputs", type: "bytes[]" }, { name: "deadline", type: "uint256" }], outputs: [] },
] as const;

const CMD_V4_SWAP = "0x10" as Hex;
const ACTIONS_EXACT_IN = "0x060c0f" as Hex; // SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL
const MAX_UINT160 = (1n << 160n) - 1n;
const MAX_UINT48 = 281_474_976_710_655;

type Eip1193 = { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };
export function injected(): Eip1193 | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { ethereum?: Eip1193 }).ethereum ?? null;
}
export function hasWallet(): boolean {
  return !!injected();
}

export const publicClient = createPublicClient({ chain: robinhood, transport: http(RPC) });

function walletClient(account: string) {
  const eth = injected();
  if (!eth) throw new Error("No browser wallet found.");
  return createWalletClient({ account: getAddress(account), chain: robinhood, transport: custom(eth) });
}

async function ensureChain(eth: Eip1193): Promise<void> {
  const cid = (await eth.request({ method: "eth_chainId" })) as string;
  if (Number.parseInt(cid, 16) === CHAIN_ID) return;
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_HEX }] });
  } catch (e: unknown) {
    if ((e as { code?: number })?.code === 4902) {
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [{ chainId: CHAIN_HEX, chainName: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: [RPC], blockExplorerUrls: ["https://robinhoodchain.blockscout.com"] }],
      });
    } else throw e;
  }
}

export async function connectWallet(): Promise<string> {
  const eth = injected();
  if (!eth) throw new Error("No wallet found. Install MetaMask or Coinbase Wallet.");
  const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
  if (!accounts?.length) throw new Error("No account authorized.");
  await ensureChain(eth);
  return getAddress(accounts[0]);
}

export type Side = "buy" | "sell";

export async function getSpotEth(): Promise<number> {
  assertConfigured();
  const s = (await publicClient.readContract({ address: STATE_VIEW, abi: STATE_VIEW_ABI, functionName: "getSlot0", args: [POOL_ID] })) as readonly [bigint, number, number, number];
  const axisPerEth = (Number(s[0]) / 2 ** 96) ** 2;
  return axisPerEth > 0 ? 1 / axisPerEth : 0;
}

export async function quoteExactIn(side: Side, amountInRaw: bigint): Promise<bigint> {
  assertConfigured();
  const data = encodeFunctionData({ abi: QUOTER_ABI, functionName: "quoteExactInputSingle", args: [{ poolKey: POOL_KEY, zeroForOne: side === "buy", exactAmount: amountInRaw, hookData: "0x" }] });
  const { data: ret } = await publicClient.call({ to: V4_QUOTER, data });
  if (!ret) throw new Error("No quote returned.");
  const decoded = decodeFunctionResult({ abi: QUOTER_ABI, functionName: "quoteExactInputSingle", data: ret }) as readonly [bigint, bigint];
  return decoded[0];
}

export async function ensureAllowances(account: string, inputToken: Address, amount: bigint, onStep?: (m: string) => void): Promise<void> {
  assertConfigured();
  if (inputToken.toLowerCase() === ETH.toLowerCase()) return; // native ETH buys need no approval
  const owner = getAddress(account);
  const wc = walletClient(account);
  const erc = (await publicClient.readContract({ address: inputToken, abi: ERC20_ABI, functionName: "allowance", args: [owner, PERMIT2] })) as bigint;
  if (erc < amount) {
    onStep?.("Approve AXIS for Permit2 — confirm in your wallet…");
    const h = await wc.writeContract({ address: inputToken, abi: ERC20_ABI, functionName: "approve", args: [PERMIT2, maxUint256] });
    await publicClient.waitForTransactionReceipt({ hash: h });
  }
  const p2 = (await publicClient.readContract({ address: PERMIT2, abi: PERMIT2_ABI, functionName: "allowance", args: [owner, inputToken, UNIVERSAL_ROUTER] })) as readonly [bigint, number, number];
  if (p2[0] < amount || Number(p2[1]) < Math.floor(Date.now() / 1000)) {
    onStep?.("Approve AXIS for the router — confirm in your wallet…");
    const h = await wc.writeContract({ address: PERMIT2, abi: PERMIT2_ABI, functionName: "approve", args: [inputToken, UNIVERSAL_ROUTER, MAX_UINT160, MAX_UINT48] });
    await publicClient.waitForTransactionReceipt({ hash: h });
  }
}

export async function swapExactIn(account: string, side: Side, amountInRaw: bigint, minOutRaw: bigint): Promise<Hex> {
  assertConfigured();
  const zeroForOne = side === "buy";
  const inputCurrency = side === "buy" ? ETH : AXIS;
  const outputCurrency = side === "buy" ? AXIS : ETH;
  const swapParam = encodeAbiParameters(
    [{ type: "tuple", components: [{ name: "poolKey", type: "tuple", components: POOLKEY_COMPONENTS }, { name: "zeroForOne", type: "bool" }, { name: "amountIn", type: "uint128" }, { name: "amountOutMinimum", type: "uint128" }, { name: "hookData", type: "bytes" }] }],
    [{ poolKey: POOL_KEY, zeroForOne, amountIn: amountInRaw, amountOutMinimum: minOutRaw, hookData: "0x" }],
  );
  const settleParam = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [inputCurrency, amountInRaw]);
  const takeParam = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [outputCurrency, minOutRaw]);
  const input = encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [ACTIONS_EXACT_IN, [swapParam, settleParam, takeParam]]);
  const wc = walletClient(account);
  return wc.writeContract({
    address: UNIVERSAL_ROUTER,
    abi: UNIVERSAL_ROUTER_ABI,
    functionName: "execute",
    args: [CMD_V4_SWAP, [input], BigInt(Math.floor(Date.now() / 1000) + 1200)],
    value: side === "buy" ? amountInRaw : 0n,
  });
}

export function inputTokenFor(side: Side): Address {
  return side === "sell" ? AXIS : ETH;
}
