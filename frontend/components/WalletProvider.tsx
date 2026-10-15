"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { signDigestNative } from "@/lib/agentSign";
import {
  fetchBalances,
  findUsdcToken,
  getBridge,
  parseAvailableRaw,
  prepareAgent,
  prepareBridgeWithdraw,
  preparePaperClaim,
  preparePaperClose,
  preparePaperOpen,
  preparePaperStake,
  preparePaperUnstake,
  preparePaperWithdraw,
  submitSignedTx,
} from "@/lib/bridge";
import { API_URL } from "@/lib/api";
import {
  agentAlreadyAuthorized,
  clearAgent,
  depositToken,
  ensureRethChain,
  getAgent,
  loadOrCreateAgent,
  markAgentAuthorized,
  parseAmount6,
  requestAccount,
  rotateAgent,
  signLightPoolTx,
  walletError,
} from "@/lib/wallet";

const LAST_ACCOUNT_KEY = "lp-last-account";

/** Fingerprint of the current chain bootstrap; changes after clean + redeploy. */
async function fetchAuthEpoch(): Promise<string> {
  let paper = "";
  try {
    const res = await fetch(`${API_URL}/config`);
    if (res.ok) {
      const cfg = (await res.json()) as { paper_market?: string };
      paper = (cfg.paper_market ?? "").trim().toLowerCase();
    }
  } catch {
    // ignore
  }
  let bridgePart = "";
  try {
    const bridge = await getBridge();
    const usdc = findUsdcToken(bridge);
    bridgePart = [
      bridge.evm_bridge?.trim().toLowerCase() ?? "",
      usdc?.lp?.trim().toLowerCase() ?? "",
      usdc?.evm?.trim().toLowerCase() ?? "",
    ].join("|");
  } catch {
    // ignore
  }
  return `${paper}|${bridgePart}`;
}

type OpenPaperInput = {
  market: string;
  instrument: number;
  is_long: boolean;
  margin: number;
  leverage: number;
  fund_from_queued?: boolean;
};

type OpenPaperResult = {
  digest: string;
  block_num: number;
  status: string;
  position?: number | null;
};

type WalletContextValue = {
  address: string | null;
  busy: boolean;
  error: string | null;
  connect: () => Promise<string>;
  /** Clear session; next Connect MetaMask-signs a new agent. */
  disconnect: () => void;
  /** Rotate agent key + MetaMask set_agent (after clean or when agent fails). */
  reauth: () => Promise<string>;
  deposit: (paperMarket: string, amount: string) => Promise<void>;
  withdraw: (paperMarket: string, amount: string) => Promise<void>;
  openPaper: (input: OpenPaperInput) => Promise<OpenPaperResult>;
  closePaper: (market: string, position: number) => Promise<void>;
  stakePaper: (market: string, amount: number) => Promise<void>;
  unstakePaper: (market: string, amount: number) => Promise<void>;
  claimPaper: (market: string) => Promise<void>;
};

const WalletContext = createContext<WalletContextValue | null>(null);

async function waitForLpCredit(
  account: string,
  token: { symbol: string; lp: string; evm: string; inbound: string },
  before: number,
  need: number,
): Promise<void> {
  for (let i = 0; i < 30; i += 1) {
    await new Promise((r) => window.setTimeout(r, 2000));
    try {
      const entries = await fetchBalances(account, [token]);
      const now = parseAvailableRaw(entries[0]);
      if (now >= before + need * 0.99) return;
    } catch {
      // keep polling
    }
  }
  throw new Error("timed out waiting for USDC on LightPool after bridge deposit");
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyCount = useRef(0);
  const connectLock = useRef<Promise<string> | null>(null);

  const begin = useCallback(() => {
    busyCount.current += 1;
    setBusy(true);
    setError(null);
  }, []);

  const end = useCallback(() => {
    busyCount.current = Math.max(0, busyCount.current - 1);
    if (busyCount.current === 0) setBusy(false);
  }, []);

  const authorizeAgent = useCallback(
    async (account: string, opts?: { forceNew?: boolean }) => {
      const epoch = await fetchAuthEpoch();
      const stale =
        !agentAlreadyAuthorized(account, epoch) &&
        getAgent(account)?.authorized === true;

      // New chain (clean/reboot) or explicit reauth → new agent key + MetaMask sign.
      if (opts?.forceNew || stale || !agentAlreadyAuthorized(account, epoch)) {
        if (opts?.forceNew || stale) {
          rotateAgent(account);
        }
        const agent = loadOrCreateAgent(account);
        const prepared = await prepareAgent(account, agent.address);
        // MetaMask eth_signTypedData_v4 for set_agent (same as stocks).
        const signature = await signLightPoolTx(account, prepared.eip712);
        await submitSignedTx(
          prepared.unsigned_tx_hex,
          signature,
          prepared.auth_scheme ?? "eip712",
        );
        markAgentAuthorized(account, epoch);
        return;
      }
      loadOrCreateAgent(account);
    },
    [],
  );

  useEffect(() => {
    void (async () => {
      try {
        const last = sessionStorage.getItem(LAST_ACCOUNT_KEY)?.trim() ?? "";
        if (!last) return;
        const epoch = await fetchAuthEpoch();
        if (agentAlreadyAuthorized(last, epoch)) {
          loadOrCreateAgent(last);
          setAddress(last);
          return;
        }
        // Stale after clean — do not silent-restore; user must Connect + MetaMask.
        clearAgent(last);
        sessionStorage.removeItem(LAST_ACCOUNT_KEY);
      } catch {
        // ignore
      }
    })();
  }, []);

  const connect = useCallback(async () => {
    if (connectLock.current) return connectLock.current;
    const run = (async () => {
      begin();
      try {
        // MetaMask account prompt (eth_requestAccounts).
        const account = await requestAccount();
        try {
          const bridge = await getBridge();
          if (bridge.configured) {
            await ensureRethChain(bridge.evm_chain_id, bridge.evm_rpc);
          }
        } catch {
          // Bridge optional for set_agent; continue.
        }
        // MetaMask EIP-712 set_agent when needed (new / stale epoch).
        await authorizeAgent(account);
        sessionStorage.setItem(LAST_ACCOUNT_KEY, account);
        setAddress(account);
        return account;
      } catch (err) {
        const wrapped = walletError(err);
        setError(wrapped.message);
        throw wrapped;
      } finally {
        end();
      }
    })();
    connectLock.current = run;
    try {
      return await run;
    } finally {
      connectLock.current = null;
    }
  }, [authorizeAgent, begin, end]);

  const disconnect = useCallback(() => {
    const prev = address;
    setAddress(null);
    setError(null);
    try {
      sessionStorage.removeItem(LAST_ACCOUNT_KEY);
      if (prev) clearAgent(prev);
    } catch {
      // ignore
    }
  }, [address]);

  const reauth = useCallback(async () => {
    if (connectLock.current) return connectLock.current;
    const run = (async () => {
      begin();
      try {
        const account = await requestAccount();
        try {
          const bridge = await getBridge();
          if (bridge.configured) {
            await ensureRethChain(bridge.evm_chain_id, bridge.evm_rpc);
          }
        } catch {
          // ignore
        }
        await authorizeAgent(account, { forceNew: true });
        sessionStorage.setItem(LAST_ACCOUNT_KEY, account);
        setAddress(account);
        return account;
      } catch (err) {
        const wrapped = walletError(err);
        setError(wrapped.message);
        throw wrapped;
      } finally {
        end();
      }
    })();
    connectLock.current = run;
    try {
      return await run;
    } finally {
      connectLock.current = null;
    }
  }, [authorizeAgent, begin, end]);

  const requireAccount = useCallback(async () => {
    if (address) {
      const epoch = await fetchAuthEpoch();
      if (agentAlreadyAuthorized(address, epoch)) {
        return address;
      }
    }
    return connect();
  }, [address, connect]);

  const requireAgent = useCallback(
    async (account: string) => {
      await authorizeAgent(account);
      const agent = getAgent(account);
      if (!agent?.privateKey) {
        throw new Error("Missing session agent key; Connect again");
      }
      return agent;
    },
    [authorizeAgent],
  );

  const signWithAgent = useCallback(
    async (account: string, prepared: {
      digest_hex: string;
      unsigned_tx_hex: string;
      auth_scheme?: string | null;
    }) => {
      const agent = await requireAgent(account);
      const signature = signDigestNative(prepared.digest_hex, agent.privateKey);
      return submitSignedTx(
        prepared.unsigned_tx_hex,
        signature,
        prepared.auth_scheme ?? "native",
      );
    },
    [requireAgent],
  );

  const deposit = useCallback(
    async (_paperMarket: string, amount: string) => {
      begin();
      try {
        const account = await requireAccount();
        const amountRaw = parseAmount6(amount);

        // MetaMask ×2: approve + bridge transfer. Available = LP USDC (shared).
        const bridge = await getBridge();
        const usdc = bridge.configured ? findUsdcToken(bridge) : null;
        if (!bridge.configured || !usdc) {
          throw new Error("bridge / USDC is not configured");
        }
        await ensureRethChain(bridge.evm_chain_id, bridge.evm_rpc);
        let before = 0;
        try {
          const entries = await fetchBalances(account, [usdc]);
          before = parseAvailableRaw(entries[0]);
        } catch {
          before = 0;
        }
        await depositToken({
          from: account,
          token: usdc.evm,
          bridge: bridge.evm_bridge,
          amount: amountRaw,
        });
        await waitForLpCredit(account, usdc, before, Number(amountRaw) / 1e6);
      } catch (err) {
        const wrapped = walletError(err);
        setError(wrapped.message);
        throw wrapped;
      } finally {
        end();
      }
    },
    [begin, end, requireAccount],
  );

  const withdraw = useCallback(
    async (paperMarket: string, amount: string) => {
      begin();
      try {
        const market = paperMarket.trim();
        const account = await requireAccount();
        const amountHuman = amount.trim();

        // One-shot migrate: sweep leftover PaperAccount.available if any.
        if (market) {
          try {
            const { getAccount } = await import("@/lib/api");
            const paper = await getAccount(account, market);
            const leftover = Number(paper.available_raw);
            if (Number.isFinite(leftover) && leftover > 0) {
              const prepared = await preparePaperWithdraw({
                user: account,
                market,
                amount: paper.available,
              });
              const signature = await signLightPoolTx(account, prepared.eip712);
              await submitSignedTx(
                prepared.unsigned_tx_hex,
                signature,
                prepared.auth_scheme ?? "eip712",
              );
            }
          } catch {
            // No legacy paper custody — bridge only.
          }
        }

        const bridge = await getBridge();
        const usdc = bridge.configured ? findUsdcToken(bridge) : null;
        if (!bridge.configured || !usdc) {
          throw new Error("bridge / USDC is not configured");
        }
        const bridgePrep = await prepareBridgeWithdraw({
          user: account,
          token: usdc.lp,
          amount: amountHuman,
          inbound: usdc.inbound,
          foreign_recipient: account,
        });
        const bridgeSig = await signLightPoolTx(account, bridgePrep.eip712);
        await submitSignedTx(
          bridgePrep.unsigned_tx_hex,
          bridgeSig,
          bridgePrep.auth_scheme ?? "eip712",
        );
      } catch (err) {
        const wrapped = walletError(err);
        setError(wrapped.message);
        throw wrapped;
      } finally {
        end();
      }
    },
    [begin, end, requireAccount],
  );

  const openPaper = useCallback(
    async (input: OpenPaperInput): Promise<OpenPaperResult> => {
      begin();
      try {
        const account = await requireAccount();
        const agent = await requireAgent(account);
        const prepared = await preparePaperOpen({
          user: account,
          agent: agent.address,
          market: input.market,
          instrument: input.instrument,
          is_long: input.is_long,
          margin: input.margin,
          leverage: input.leverage,
          fund_from_queued: input.fund_from_queued,
        });
        const submitted = await signWithAgent(account, prepared);
        return {
          digest: submitted.digest,
          block_num: submitted.block_num ?? 0,
          status: submitted.status,
          position: submitted.position,
        };
      } catch (err) {
        const wrapped = walletError(err);
        setError(wrapped.message);
        throw wrapped;
      } finally {
        end();
      }
    },
    [begin, end, requireAccount, requireAgent, signWithAgent],
  );

  const closePaper = useCallback(
    async (market: string, position: number) => {
      begin();
      try {
        const account = await requireAccount();
        const agent = await requireAgent(account);
        const prepared = await preparePaperClose({
          user: account,
          agent: agent.address,
          market,
          position,
        });
        await signWithAgent(account, prepared);
      } catch (err) {
        const wrapped = walletError(err);
        setError(wrapped.message);
        throw wrapped;
      } finally {
        end();
      }
    },
    [begin, end, requireAccount, requireAgent, signWithAgent],
  );

  const stakePaper = useCallback(
    async (market: string, amount: number) => {
      begin();
      try {
        const account = await requireAccount();
        const agent = await requireAgent(account);
        const prepared = await preparePaperStake({
          user: account,
          agent: agent.address,
          market,
          amount,
        });
        await signWithAgent(account, prepared);
      } catch (err) {
        const wrapped = walletError(err);
        setError(wrapped.message);
        throw wrapped;
      } finally {
        end();
      }
    },
    [begin, end, requireAccount, requireAgent, signWithAgent],
  );

  const unstakePaper = useCallback(
    async (market: string, amount: number) => {
      begin();
      try {
        const account = await requireAccount();
        const agent = await requireAgent(account);
        const prepared = await preparePaperUnstake({
          user: account,
          agent: agent.address,
          market,
          amount,
        });
        await signWithAgent(account, prepared);
      } catch (err) {
        const wrapped = walletError(err);
        setError(wrapped.message);
        throw wrapped;
      } finally {
        end();
      }
    },
    [begin, end, requireAccount, requireAgent, signWithAgent],
  );

  const claimPaper = useCallback(
    async (market: string) => {
      begin();
      try {
        const account = await requireAccount();
        const agent = await requireAgent(account);
        const prepared = await preparePaperClaim({
          user: account,
          agent: agent.address,
          market,
        });
        await signWithAgent(account, prepared);
      } catch (err) {
        const wrapped = walletError(err);
        setError(wrapped.message);
        throw wrapped;
      } finally {
        end();
      }
    },
    [begin, end, requireAccount, requireAgent, signWithAgent],
  );

  const value = useMemo(
    () => ({
      address,
      busy,
      error,
      connect,
      disconnect,
      reauth,
      deposit,
      withdraw,
      openPaper,
      closePaper,
      stakePaper,
      unstakePaper,
      claimPaper,
    }),
    [
      address,
      busy,
      error,
      connect,
      disconnect,
      reauth,
      deposit,
      withdraw,
      openPaper,
      closePaper,
      stakePaper,
      unstakePaper,
      claimPaper,
    ],
  );

  return (
    <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
  );
}

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used within WalletProvider");
  return ctx;
}
