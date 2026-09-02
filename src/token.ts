/**
 * HMAC-signed token proxy.
 *
 * Generates time-limited signed URLs that hide the upstream source.
 * The browser only sees your proxy domain — the real URL is inside
 * an HMAC-signed token that expires.
 *
 * Token format (query params):
 *   /proxy?url=<base64url(upstream)>&exp=<unix_seconds>&sig=<hmac_hex>
 *
 * When PROXY_SECRET is not set, falls back to plain ?url= encoding.
 */

const SECRET = process.env.PROXY_SECRET ?? "";
const DEFAULT_TTL = 300; // 5 minutes

function b64url(input: string): string {
    return Buffer.from(input, "utf-8")
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}

function unb64url(input: string): string {
    let base64 = input.replace(/-/g, "+").replace(/_/g, "/");
    while (base64.length % 4) base64 += "=";
    return Buffer.from(base64, "base64").toString("utf-8");
}

async function hmacSign(data: string, secret: string): Promise<string> {
    const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
    return Array.from(new Uint8Array(sig))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

async function hmacVerify(data: string, sig: string, secret: string): Promise<boolean> {
    const expected = await hmacSign(data, secret);
    // Constant-time comparison
    if (expected.length !== sig.length) return false;
    let result = 0;
    for (let i = 0; i < expected.length; i++) {
        result |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
    }
    return result === 0;
}

/**
 * Sign a URL and return the proxy path with token.
 * Returns null if PROXY_SECRET is not configured.
 */
export async function signUrl(url: string, ttlSeconds = DEFAULT_TTL): Promise<string | null> {
    if (!SECRET) return null;

    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const payload = `${b64url(url)}:${exp}`;
    const sig = await hmacSign(payload, SECRET);

    return `/proxy?url=${b64url(url)}&exp=${exp}&sig=${sig}`;
}

/**
 * Verify a signed proxy request and return the upstream URL.
 * Returns null if token is invalid or expired.
 */
export async function verifyToken(
    urlB64: string,
    expStr: string,
    sig: string,
): Promise<string | null> {
    if (!SECRET) return null;

    const exp = parseInt(expStr, 10);
    if (isNaN(exp) || Date.now() / 1000 > exp) return null;

    const payload = `${urlB64}:${expStr}`;
    const valid = await hmacVerify(payload, sig, SECRET);
    if (!valid) return null;

    try {
        return unb64url(urlB64);
    } catch {
        return null;
    }
}

/**
 * Check if token-based proxy is enabled.
 */
export function isTokenProxyEnabled(): boolean {
    return !!SECRET;
}
