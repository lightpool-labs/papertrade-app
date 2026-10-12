/** Anvil / Hardhat account #0 — funded by paper-bootstrap on localnet. */
export const ANVIL_ACCOUNT_0 =
  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

/** Localnet default trader; override with NEXT_PUBLIC_DEV_ADDRESS. */
export function defaultDevAddress(): string {
  const fromEnv = process.env.NEXT_PUBLIC_DEV_ADDRESS?.trim();
  if (fromEnv && /^0x[0-9a-fA-F]{40}$/.test(fromEnv)) {
    return fromEnv;
  }
  return ANVIL_ACCOUNT_0;
}

export function shortAddress(address: string): string {
  if (address.length < 10) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
