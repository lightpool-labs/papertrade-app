"use client";

import { useEffect, useState } from "react";
import { useWallet } from "@/components/WalletProvider";
import { parseAmount6 } from "@/lib/wallet";

type FundKind = "deposit" | "withdraw";

type FundDialogProps = {
  kind: FundKind;
  paperMarket: string;
  onClose: () => void;
  onDone?: () => void | Promise<void>;
};

export function FundDialog({
  kind,
  paperMarket,
  onClose,
  onDone,
}: FundDialogProps) {
  const { busy, deposit, withdraw } = useWallet();
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && !busy) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  async function onConfirm() {
    setError(null);
    setStatus(null);
    try {
      parseAmount6(amount);
      if (!paperMarket.trim()) {
        throw new Error("paper market is not ready");
      }
      if (kind === "deposit") {
        setStatus("Depositing…");
        await deposit(paperMarket, amount);
        setStatus("Deposit submitted");
      } else {
        setStatus("Withdrawing…");
        await withdraw(paperMarket, amount);
        setStatus("Withdraw submitted");
      }
      await onDone?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : `${kind} failed`);
      setStatus(null);
    }
  }

  const title = kind === "deposit" ? "Deposit USDC" : "Withdraw USDC";

  return (
    <div className="fund-dialog-backdrop" role="presentation" onClick={onClose}>
      <div
        className="fund-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fund-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="fund-dialog-header">
          <h3 id="fund-dialog-title">{title}</h3>
          <button
            type="button"
            className="fund-dialog-close"
            disabled={busy}
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <label className="field" htmlFor="fund-dialog-amount">
          <span>Amount (USDC)</span>
          <input
            id="fund-dialog-amount"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            placeholder="100"
            disabled={busy}
            autoFocus
          />
        </label>

        <p className="fund-dialog-hint">
          {kind === "deposit"
            ? "MetaMask: approve + transfer to bridge. Paper Available is credited by your agent."
            : "Move Available to LP wallet, then bridge out when configured."}
        </p>

        {status ? <p className="fund-status">{status}</p> : null}
        {error ? <p className="fund-status error">{error}</p> : null}

        <div className="fund-dialog-actions">
          <button type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="fund-dialog-confirm"
            disabled={busy || !amount.trim()}
            onClick={() => void onConfirm()}
          >
            {busy ? "Working…" : "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}
