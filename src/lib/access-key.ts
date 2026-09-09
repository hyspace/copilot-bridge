import { timingSafeEqual } from "node:crypto";

/** Optional inbound access control for local wrappers and trusted-LAN use. Never forward this key upstream. */
export function validBridgeKey(candidate: string | undefined, expected: string): boolean {
  if (!candidate) return false;
  const left = Buffer.from(candidate), right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
