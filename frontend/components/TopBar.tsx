"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useWallet } from "@/components/WalletProvider";
import { shortAddress } from "@/lib/wallet";

const LINKS = [
  { href: "/trade/btc", label: "Trade" },
  { href: "/house", label: "House" },
  { href: "/paper", label: "Paper" },
] as const;

export function TopBar() {
  const pathname = usePathname();
  const { address, busy, error, connect, disconnect, reauth } = useWallet();

  return (
    <header className="topbar">
      <Link href="/trade/btc" className="logo">
        Papertrader
      </Link>
      <nav className="nav-links">
        {LINKS.map((link) => {
          const active =
            pathname === link.href ||
            (link.href.startsWith("/trade") && pathname.startsWith("/trade"));
          return (
            <Link
              key={link.href}
              href={link.href}
              className={`nav-link${active ? " active" : ""}`}
            >
              {link.label}
            </Link>
          );
        })}
      </nav>
      <div className="topbar-spacer" />
      <div className="wallet-actions">
        {address ? (
          <>
            <span className="wallet-addr" title={address}>
              {shortAddress(address)}
            </span>
            <button
              type="button"
              className="connect-btn"
              disabled={busy}
              title="New agent + MetaMask set_agent"
              onClick={() => {
                void reauth().catch(() => undefined);
              }}
            >
              {busy ? "Signing…" : "Reauth"}
            </button>
            <button
              type="button"
              className="connect-btn"
              disabled={busy}
              onClick={disconnect}
            >
              Disconnect
            </button>
          </>
        ) : (
          <button
            type="button"
            className="connect-btn"
            disabled={busy}
            title={error ?? "Connect MetaMask + authorize agent"}
            onClick={() => {
              void connect().catch(() => undefined);
            }}
          >
            {busy ? "Connecting…" : "Connect"}
          </button>
        )}
      </div>
    </header>
  );
}
