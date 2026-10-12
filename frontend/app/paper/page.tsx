"use client";

import { TopBar } from "@/components/TopBar";
import { WalletProvider } from "@/components/WalletProvider";

export default function PaperPage() {
  return (
    <WalletProvider>
      <div className="stub-shell">
        <TopBar />
        <main className="stub-page">
          Paper (staker) lands in app P3 (stake / claim via indexer).
        </main>
      </div>
    </WalletProvider>
  );
}
