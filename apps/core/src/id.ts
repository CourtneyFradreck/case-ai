import { createHash } from "node:crypto";

// Stable 10-hex-char finding IDs, shared by all rule sets.
export const fid = (...parts: string[]) =>
  createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 10);
