/**
 * Shared access-control helpers for mediator and arbitrator route guards.
 *
 * Centralises the ADMIN_STELLAR_PUBKEYS check so every controller and service
 * reads the allowlist from the same place rather than duplicating the parsing
 * logic inline.
 */

/** Returns the set of mediator/arbitrator addresses from the environment. */
export function getMediatorAllowlist(): Set<string> {
  return new Set(
    (process.env.ADMIN_STELLAR_PUBKEYS ?? "")
      .split(",")
      .map((a: string) => a.trim())
      .filter(Boolean)
  );
}

/** Returns true when `address` appears in the ADMIN_STELLAR_PUBKEYS allowlist. */
export function isMediatorAddress(address: string): boolean {
  return getMediatorAllowlist().has(address);
}
