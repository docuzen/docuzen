// Who may talk to the sidecar. It listens on loopback, but loopback is not private: any
// web page the user has open can reach 127.0.0.1, and a WebSocket is not bound by CORS.
// So every client presents the per-launch token (the app shell generates it and hands it
// to both the sidecar and the webview), and a browser client must also come from the
// app's own origin.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Origins the app's own webview loads from: macOS/Linux (custom scheme) and Windows. */
const WEBVIEW_ORIGINS = new Set(["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"]);
/** Loopback hosts, as `URL.hostname` spells them, for the Vite dev server in `tauri dev` and the tools. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A fresh launch token: 256 bits from the OS RNG, hex. */
export function newLaunchToken(): string {
  return randomBytes(32).toString("hex");
}

/** Constant-time comparison (hashing first makes the length of `given` irrelevant too). */
export function tokenMatches(given: string | null | undefined, expected: string): boolean {
  if (!expected || typeof given !== "string") return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Whether a browser-sent `Origin` may open a WebSocket: the Tauri webview, or a page served
 * over plain http from a loopback host (the Vite dev server). A request without an Origin
 * header is not a browser page and is judged by its token alone.
 */
export function isAllowedOrigin(origin: string): boolean {
  if (WEBVIEW_ORIGINS.has(origin)) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false; // "null" (sandboxed frames, file: pages) and anything malformed
  }
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname) && url.origin === origin;
}
