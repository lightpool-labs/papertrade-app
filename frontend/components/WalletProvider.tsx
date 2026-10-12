"use client";

import { createContext, useContext, useMemo, useState } from "react";
import { defaultDevAddress } from "@/lib/wallet";

type WalletContextValue = {
  address: string;
};

const WalletContext = createContext<WalletContextValue | null>(null);

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [address] = useState(() => defaultDevAddress());

  const value = useMemo(() => ({ address }), [address]);

  return (
    <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
  );
}

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used within WalletProvider");
  return ctx;
}
