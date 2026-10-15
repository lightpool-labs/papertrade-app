"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTransition } from "react";
import { useWallet } from "@/components/WalletProvider";
import { shortAddress } from "@/lib/wallet";

const LINKS = [
  { href: "/trade/btc", label: "Trade" },
  { href: "/house", label: "House" },
  { href: "/paper", label: "Paper" },
] as const;

export function TopBar() {
  const pathname = usePathname();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const { address, busy, error, connect } = useWallet();

  return (
    <header className="topbar">
      <Link href="/trade/btc" className="logo">
        Papertrader
      </Link>
      <nav className="nav-links" aria-busy={pending || undefined}>
        {LINKS.map((link) => {
          const active =
            pathname === link.href ||
            (link.href.startsWith("/trade") && pathname.startsWith("/trade"));
          return (
            <Link
              key={link.href}
              href={link.href}
              prefetch
              className={`nav-link${active ? " active" : ""}`}
              onClick={(e) => {
                if (
                  e.metaKey ||
                  e.ctrlKey ||
                  e.shiftKey ||
                  e.altKey ||
                  e.button !== 0
                ) {
                  return;
                }
                e.preventDefault();
                if (active && !link.href.startsWith("/trade")) return;
                // Yield past Paper WS/chart work so the route change is not starved.
                startTransition(() => {
                  router.push(link.href);
                });
              }}
            >
              {link.label}
            </Link>
          );
        })}
      </nav>
      <div className="topbar-spacer" />
      <button
        type="button"
        className="connect-btn"
        disabled={busy}
        title={error ?? (address ? address : "Connect MetaMask")}
        onClick={() => {
          void connect().catch(() => undefined);
        }}
      >
        {address ? shortAddress(address) : busy ? "Connecting…" : "Connect"}
      </button>
    </header>
  );
}
