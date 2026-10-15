"use client";

import { WalletProvider } from "@/components/WalletProvider";

export function Providers({ children }: { children: React.ReactNode }) {
  return <WalletProvider>{children}</WalletProvider>;
}
