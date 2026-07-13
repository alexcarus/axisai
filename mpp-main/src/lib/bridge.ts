// ---------------------------------------------------------------------------
// AXIS AI — real cross-chain bridging via the LayerZero OFT bridge.
//
// Base ⇄ Robinhood Chain. Bridging OUT of Base locks AXIS in the adapter and
// mints a 1:1 representation on Robinhood; bridging back burns on Robinhood and
// unlocks on Base. Global supply is conserved at 84,000,000 across both chains.
// The bridge contracts are ownerless/renounced — no admin, no config changes.
//
// Contracts (verified on-chain):
//   Base   AxisOFTAdapter  0x2FD7E1Af2248e4eC3143741229B139118cE98385  (escrows AXIS)
//   Robinhood AxisOFT      0xcDbEb868D5955C04aD3A471388b5ebAeE65AcaE4  (mint/burn)
//   AXIS (Base)            0x6DBBd1910BeFC6736b818d4DcaD3ff833b9e06D7
// Enforced lzReceive options (200k) are set on-chain, so extraOptions = "0x".
// ---------------------------------------------------------------------------

import {
  type Address,
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  getAddress,
  type Hex,
  http,
  maxUint256,
  pad,
} from "viem";
import { base } from "viem/chains";

export const AXIS = "0x6DBBd1910BeFC6736b818d4DcaD3ff833b9e06D7" as Address;
export const ADAPTER_BASE =
  "0x2FD7E1Af2248e4eC3143741229B139118cE98385" as Address;
export const OFT_ROBINHOOD =
  "0xcDbEb868D5955C04aD3A471388b5ebAeE65AcaE4" as Address;

export const BASE_EID = 30184;
export const ROBINHOOD_EID = 30416;

export const BASE_CHAIN_ID = 8453;
export const BASE_CHAIN_HEX = "0x2105";
export const ROBINHOOD_CHAIN_ID = 4663;
export const ROBINHOOD_CHAIN_HEX = "0x1237";

const BASE_RPC =
  (import.meta.env?.VITE_BASE_RPC_URL as string | undefined) ||
  "https://base-rpc.publicnode.com";
const ROBINHOOD_RPC = "https://rpc.mainnet.chain.robinhood.com";

// Robinhood Chain isn't in viem/chains — define it (Arbitrum-Orbit L2, ETH gas).
export const robinhood = defineChain({
  id: ROBINHOOD_CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [ROBINHOOD_RPC] } },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" },
  },
});

export const baseClient = createPublicClient({ chain: base, transport: http(BASE_RPC) });
export const hoodClient = createPublicClient({
  chain: robinhood,
  transport: http(ROBINHOOD_RPC),
});

// OFT bridges at 6 "shared decimals" — amounts are floored to 1e-6 AXIS so the
// on-chain dust check can't revert the send.
const SHARED_GRANULARITY = 10n ** 12n; // 18 - 6 decimals
const floorShared = (raw: bigint) => raw - (raw % SHARED_GRANULARITY);

export type Dir = "toRobinhood" | "toBase";

type Leg = {
  contract: Address;
  dstEid: number;
  needsApprove: boolean; // Base→Robinhood locks real AXIS (approve); reverse burns (no approve)
  walletChain: typeof base | typeof robinhood;
  chainId: number;
  chainHex: string;
};

function leg(dir: Dir): Leg {
  return dir === "toRobinhood"
    ? {
        contract: ADAPTER_BASE,
        dstEid: ROBINHOOD_EID,
        needsApprove: true,
        walletChain: base,
        chainId: BASE_CHAIN_ID,
        chainHex: BASE_CHAIN_HEX,
      }
    : {
        contract: OFT_ROBINHOOD,
        dstEid: BASE_EID,
        needsApprove: false,
        walletChain: robinhood,
        chainId: ROBINHOOD_CHAIN_ID,
        chainHex: ROBINHOOD_CHAIN_HEX,
      };
}

// The read client for a direction's source chain.
const srcClient = (dir: Dir) => (dir === "toRobinhood" ? baseClient : hoodClient);

// ABIs ----------------------------------------------------------------------

const ERC20_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "allowance", type: "function", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

const SEND_PARAM = {
  type: "tuple",
  name: "sendParam",
  components: [
    { name: "dstEid", type: "uint32" },
    { name: "to", type: "bytes32" },
    { name: "amountLD", type: "uint256" },
    { name: "minAmountLD", type: "uint256" },
    { name: "extraOptions", type: "bytes" },
    { name: "composeMsg", type: "bytes" },
    { name: "oftCmd", type: "bytes" },
  ],
} as const;
const MESSAGING_FEE = {
  type: "tuple",
  name: "fee",
  components: [
    { name: "nativeFee", type: "uint256" },
    { name: "lzTokenFee", type: "uint256" },
  ],
} as const;

const OFT_ABI = [
  { name: "quoteSend", type: "function", stateMutability: "view", inputs: [SEND_PARAM, { name: "payInLzToken", type: "bool" }], outputs: [MESSAGING_FEE] },
  { name: "send", type: "function", stateMutability: "payable", inputs: [SEND_PARAM, MESSAGING_FEE, { name: "refundAddress", type: "address" }], outputs: [] },
] as const;

// Wallet plumbing -----------------------------------------------------------

type Eip1193 = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, cb: (...a: unknown[]) => void) => void;
  removeListener?: (event: string, cb: (...a: unknown[]) => void) => void;
};

export function injected(): Eip1193 | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { ethereum?: Eip1193 }).ethereum ?? null;
}
export function hasWallet(): boolean {
  return !!injected();
}

async function ensureChain(eth: Eip1193, l: Leg): Promise<void> {
  const cid = (await eth.request({ method: "eth_chainId" })) as string;
  if (Number.parseInt(cid, 16) === l.chainId) return;
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: l.chainHex }] });
  } catch (e: unknown) {
    if ((e as { code?: number })?.code === 4902) {
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [
          l.chainId === ROBINHOOD_CHAIN_ID
            ? {
                chainId: ROBINHOOD_CHAIN_HEX,
                chainName: "Robinhood Chain",
                nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
                rpcUrls: [ROBINHOOD_RPC],
                blockExplorerUrls: ["https://robinhoodchain.blockscout.com"],
              }
            : {
                chainId: BASE_CHAIN_HEX,
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

export async function connectWallet(dir: Dir): Promise<string> {
  const eth = injected();
  if (!eth) throw new Error("No wallet found. Install MetaMask or Coinbase Wallet.");
  const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
  if (!accounts?.length) throw new Error("No account authorized.");
  await ensureChain(eth, leg(dir));
  return getAddress(accounts[0]);
}

export async function currentAccount(): Promise<string | null> {
  const eth = injected();
  if (!eth) return null;
  try {
    const a = (await eth.request({ method: "eth_accounts" })) as string[];
    return a?.length ? getAddress(a[0]) : null;
  } catch {
    return null;
  }
}

function walletClient(account: string, l: Leg) {
  const eth = injected();
  if (!eth) throw new Error("No browser wallet found.");
  return createWalletClient({ account: getAddress(account), chain: l.walletChain, transport: custom(eth) });
}

// Reads ---------------------------------------------------------------------

export type BridgeBalances = {
  axisBaseRaw: bigint; // AXIS on Base
  axisHoodRaw: bigint; // bridged AXIS on Robinhood
  ethBaseRaw: bigint;
  ethHoodRaw: bigint;
};

export async function getBridgeBalances(account: string): Promise<BridgeBalances> {
  const owner = getAddress(account);
  const [axisBaseRaw, axisHoodRaw, ethBaseRaw, ethHoodRaw] = await Promise.all([
    baseClient.readContract({ address: AXIS, abi: ERC20_ABI, functionName: "balanceOf", args: [owner] }) as Promise<bigint>,
    hoodClient.readContract({ address: OFT_ROBINHOOD, abi: ERC20_ABI, functionName: "balanceOf", args: [owner] }) as Promise<bigint>,
    baseClient.getBalance({ address: owner }),
    hoodClient.getBalance({ address: owner }),
  ]);
  return { axisBaseRaw, axisHoodRaw, ethBaseRaw, ethHoodRaw };
}

function buildSendParam(dstEid: number, to: string, amountRaw: bigint) {
  const amt = floorShared(amountRaw);
  return {
    dstEid,
    to: pad(getAddress(to), { size: 32 }) as Hex,
    amountLD: amt,
    minAmountLD: amt, // same-asset OFT, dust-floored → no slippage
    extraOptions: "0x" as Hex, // enforced options set on-chain
    composeMsg: "0x" as Hex,
    oftCmd: "0x" as Hex,
  };
}

/** LayerZero messaging fee (native gas on the source chain) for this bridge. */
export async function quoteBridge(
  dir: Dir,
  account: string,
  amountRaw: bigint,
): Promise<{ nativeFee: bigint; amountLD: bigint }> {
  const l = leg(dir);
  const sp = buildSendParam(l.dstEid, account, amountRaw);
  const fee = (await srcClient(dir).readContract({
    address: l.contract,
    abi: OFT_ABI,
    functionName: "quoteSend",
    args: [sp, false],
  })) as { nativeFee: bigint; lzTokenFee: bigint };
  return { nativeFee: fee.nativeFee, amountLD: sp.amountLD };
}

// Writes --------------------------------------------------------------------

/** Base→Robinhood only: approve the adapter to pull AXIS via one max approval. */
export async function ensureApproval(
  dir: Dir,
  account: string,
  amountRaw: bigint,
  onStep?: (m: string) => void,
): Promise<void> {
  const l = leg(dir);
  if (!l.needsApprove) return;
  const owner = getAddress(account);
  const allowance = (await baseClient.readContract({
    address: AXIS,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [owner, ADAPTER_BASE],
  })) as bigint;
  if (allowance >= amountRaw) return;
  onStep?.("Approve AXIS for the bridge — confirm in your wallet…");
  const wc = walletClient(account, l);
  const hash = await wc.writeContract({ address: AXIS, abi: ERC20_ABI, functionName: "approve", args: [ADAPTER_BASE, maxUint256] });
  await baseClient.waitForTransactionReceipt({ hash });
}

/** Executes the bridge send. Returns the source-chain tx hash. */
export async function sendBridge(
  dir: Dir,
  account: string,
  amountRaw: bigint,
): Promise<{ hash: Hex; amountLD: bigint }> {
  const l = leg(dir);
  const eth = injected();
  if (eth) await ensureChain(eth, l);
  const sp = buildSendParam(l.dstEid, account, amountRaw);
  const { nativeFee } = await quoteBridge(dir, account, amountRaw);
  const wc = walletClient(account, l);
  const hash = await wc.writeContract({
    address: l.contract,
    abi: OFT_ABI,
    functionName: "send",
    args: [sp, { nativeFee, lzTokenFee: 0n }, getAddress(account)],
    value: nativeFee,
  });
  return { hash, amountLD: sp.amountLD };
}

export function explorerTx(dir: Dir, hash: string): string {
  return dir === "toRobinhood"
    ? `https://basescan.org/tx/${hash}`
    : `https://robinhoodchain.blockscout.com/tx/${hash}`;
}
