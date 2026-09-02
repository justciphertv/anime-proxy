/**
 * M3U8 → MP4 Remux Endpoint.
 *
 * Parses an M3U8 manifest, downloads all segments in parallel,
 * and streams back a single concatenated mp4-compatible stream.
 * Supports both MPEG-TS (.ts) and fragmented MP4 (.m4s) segments.
 */

import type { Context } from "hono";
import { CORS_HEADERS, MEDIA_CACHE_CONTROL } from "./constants.js";
import { generateHeadersOriginal } from "./headers.js";
import { decryptUrl, XOR_KEY } from "./crypto.js";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ParsedSegment {
    url: string;
    byteRange?: { length: number; offset: number };
    /** For m4s: marks the init segment (moov box) */
    isInit?: boolean;
}

interface ParsedManifest {
    type: "media" | "master";
    /** Only set for master playlists */
    variants?: { url: string; bandwidth: number; resolution?: string; codecs?: string }[];
    segments: ParsedSegment[];
    /** Detected segment extension: ts, m4s, mp4, etc. */
    extension: string;
}

// ─── M3U8 Parser ──────────────────────────────────────────────────────────────

function resolveUrl(ref: string, base: URL): string {
    try { return new URL(ref).href; } catch { return new URL(ref, base).href; }
}

function parseM3u8(text: string, baseUrl: URL): ParsedManifest {
    const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
    const isMaster = lines.some((l) => l.startsWith("#EXT-X-STREAM-INF"));

    if (isMaster) {
        return parseMasterPlaylist(lines, baseUrl);
    }
    return parseMediaPlaylist(lines, baseUrl);
}

function parseMasterPlaylist(lines: string[], baseUrl: URL): ParsedManifest {
    const variants: ParsedManifest["variants"] = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.startsWith("#EXT-X-STREAM-INF")) continue;

        const bwMatch = line.match(/BANDWIDTH=(\d+)/);
        const resMatch = line.match(/RESOLUTION=([^\s,]+)/);
        const codecsMatch = line.match(/CODECS="([^"]+)"/);

        const nextLine = lines[i + 1]?.trim();
        if (!nextLine || nextLine.startsWith("#")) continue;

        variants.push({
            url: resolveUrl(nextLine, baseUrl),
            bandwidth: bwMatch ? parseInt(bwMatch[1], 10) : 0,
            resolution: resMatch?.[1],
            codecs: codecsMatch?.[1],
        });
    }

    // Select highest bandwidth variant
    variants.sort((a, b) => b.bandwidth - a.bandwidth);

    return {
        type: "master",
        variants,
        segments: [],
        extension: "ts",
    };
}

function parseMediaPlaylist(lines: string[], baseUrl: URL): ParsedManifest {
    const segments: ParsedSegment[] = [];
    let pendingByteRange: { length: number; offset: number } | undefined;
    let detectedExt = "ts";

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (line.startsWith("#EXT-X-BYTERANGE:")) {
            // #EXT-X-BYTERANGE:123456@0
            const match = line.match(/#EXT-X-BYTERANGE:(\d+)@(\d+)/);
            if (match) {
                pendingByteRange = { length: parseInt(match[1], 10), offset: parseInt(match[2], 10) };
            }
            continue;
        }

        if (line.startsWith("#EXT-X-MAP:")) {
            // Init segment for fMP4/m4s
            const uriMatch = line.match(/URI="([^"]+)"/);
            if (uriMatch) {
                segments.push({
                    url: resolveUrl(uriMatch[1], baseUrl),
                    isInit: true,
                });
            }
            continue;
        }

        if (line.startsWith("#") || line.length === 0) continue;

        // This is a segment URL line
        const segUrl = resolveUrl(line, baseUrl);
        const ext = segUrl.split("?")[0].split(".").pop()?.toLowerCase() ?? "ts";
        if (ext === "m4s" || ext === "mp4") detectedExt = ext;

        const segment: ParsedSegment = { url: segUrl };
        if (pendingByteRange) {
            segment.byteRange = pendingByteRange;
            pendingByteRange = undefined;
        }
        segments.push(segment);
    }

    return { type: "media", segments, extension: detectedExt };
}

// ─── Segment Downloader ───────────────────────────────────────────────────────

async function downloadSegment(
    url: string,
    headers: Record<string, string>,
    byteRange?: { length: number; offset: number },
    retries = 2,
): Promise<ArrayBuffer> {
    const fetchHeaders = { ...headers };
    if (byteRange) {
        const start = byteRange.offset;
        const end = start + byteRange.length - 1;
        fetchHeaders["range"] = `bytes=${start}-${end}`;
    }

    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 30000);

            const resp = await fetch(url, {
                headers: fetchHeaders,
                redirect: "follow",
                signal: controller.signal,
                // @ts-ignore
                tls: { rejectUnauthorized: false },
            });
            clearTimeout(timeout);

            if (!resp.ok) {
                if (attempt < retries) continue;
                throw new Error(`Segment fetch failed: ${resp.status} ${url}`);
            }

            return await resp.arrayBuffer();
        } catch (err) {
            if (attempt < retries) {
                // Exponential backoff: 200ms, 400ms
                await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
                continue;
            }
            throw err;
        }
    }
    throw new Error("Unreachable");
}

async function downloadAllSegments(
    segments: ParsedSegment[],
    headers: Record<string, string>,
    concurrency = 10,
    onProgress?: (done: number, total: number) => void,
): Promise<ArrayBuffer[]> {
    const results: ArrayBuffer[] = new Array(segments.length);
    let completed = 0;
    const total = segments.length;

    // Process in batches of `concurrency`
    for (let i = 0; i < segments.length; i += concurrency) {
        const batch = segments.slice(i, i + concurrency);
        const batchResults = await Promise.all(
            batch.map(async (seg, batchIdx) => {
                const buf = await downloadSegment(seg.url, headers, seg.byteRange);
                results[i + batchIdx] = buf;
                completed++;
                onProgress?.(completed, total);
                return buf;
            }),
        );
    }

    return results;
}

// ─── MP4 Concatenation ────────────────────────────────────────────────────────

/**
 * For MPEG-TS segments: simple concatenation produces a valid TS stream
 * that most players can handle.
 */
function concatTS(buffers: ArrayBuffer[]): Uint8Array {
    const totalLen = buffers.reduce((sum, b) => sum + b.byteLength, 0);
    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (const buf of buffers) {
        result.set(new Uint8Array(buf), offset);
        offset += buf.byteLength;
    }
    return result;
}

/**
 * For fMP4/m4s segments: the init segment (moov) must come first,
 * followed by all media segments (moof+mdat). Simple concatenation
 * produces a valid fMP4 that players accept.
 */
function concatM4S(buffers: ArrayBuffer[]): Uint8Array {
    // Same as TS — fMP4 fragments concatenate cleanly
    return concatTS(buffers);
}

// ─── URL Resolution for Proxy-Rewritten Manifests ────────────────────────────

/**
 * Detect proxy-rewritten segment URLs (from ?url= or ?u= parameters)
 * and decode them to the actual upstream URL.
 * Also generates the correct headers for the upstream domain.
 *
 * @param segUrl   The segment URL as parsed from the M3U8 manifest
 * @param proxyOrigin  The proxy's own origin (e.g. "http://localhost:3002")
 * @returns The resolved segment URL and headers to use for fetching
 */
function resolveSegmentUrl(
    segUrl: string,
    proxyOrigin: string,
): { url: string; headers: Record<string, string> } {
    // Case 1: proxy-rewritten URL — ?url=<encoded> (relative to proxy origin)
    if (segUrl.startsWith("?url=")) {
        const encoded = segUrl.slice(5);
        const actualUrl = decodeURIComponent(encoded);
        try {
            const u = new URL(actualUrl);
            return { url: u.href, headers: generateHeadersOriginal(u) };
        } catch {
            // Fallback: resolve relative to proxy origin
            const resolved = new URL(actualUrl, proxyOrigin);
            return { url: resolved.href, headers: generateHeadersOriginal(resolved) };
        }
    }

    // Case 2: encrypted proxy URL — ?u=<encrypted>
    if (segUrl.startsWith("?u=") && XOR_KEY) {
        const decrypted = decryptUrl(segUrl.slice(3));
        if (decrypted) {
            try {
                const u = new URL(decrypted);
                return { url: u.href, headers: generateHeadersOriginal(u) };
            } catch {
                const resolved = new URL(decrypted, proxyOrigin);
                return { url: resolved.href, headers: generateHeadersOriginal(resolved) };
            }
        }
    }

    // Case 3: plain upstream URL (no proxy rewriting)
    try {
        const u = new URL(segUrl);
        return { url: u.href, headers: generateHeadersOriginal(u) };
    } catch {
        // Relative URL — resolve against proxy origin as fallback
        const resolved = new URL(segUrl, proxyOrigin);
        return { url: resolved.href, headers: generateHeadersOriginal(resolved) };
    }
}

// ─── Hono Handler ─────────────────────────────────────────────────────────────

export async function handleRemux(c: Context) {
    const urlParam = c.req.query("url");
    if (!urlParam) {
        return c.json({ error: "Missing url parameter. Usage: /api/remux?url=<M3U8_URL>" }, 400, CORS_HEADERS);
    }

    const debug = c.req.query("debug") === "1";
    const concurrency = Math.min(parseInt(c.req.query("concurrency") ?? "10", 10), 20);

    // Determine the proxy's own origin for routing proxy-rewritten URLs
    const proxyOrigin = new URL(c.req.url).origin;

    // Step 1: Decode the user-provided URL parameter
    // It might be a plain upstream URL, or a proxy-rewritten URL like
    //   /api/remux?url=https://proxy/?url%3Dhttps%253A%252F%252Fupstream...
    // We need to unwrap nested proxy URLs and extract the actual upstream URL.
    let upstreamManifestUrl: string;
    let manifestFetchUrl: string;

    // Check if urlParam is a proxy-relative URL containing ?url=
    const urlParamObj = new URL(urlParam, proxyOrigin);
    const innerUrl = urlParamObj.searchParams.get("url");

    if (innerUrl) {
        // Nested proxy URL: decode to get the real upstream URL
        upstreamManifestUrl = innerUrl;
        // Fetch through the proxy itself for proper header handling
        manifestFetchUrl = urlParamObj.href;
    } else {
        // Plain URL: use directly
        upstreamManifestUrl = urlParam;
        manifestFetchUrl = urlParam;
    }

    // Parse the upstream manifest URL for header generation
    let upstreamUrl: URL;
    try {
        upstreamUrl = new URL(upstreamManifestUrl);
    } catch {
        return c.json({ error: "Invalid upstream URL" }, 400, CORS_HEADERS);
    }

    // Fetch the manifest
    const upstreamHeaders = generateHeadersOriginal(upstreamUrl);
    let manifestText: string;
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        const resp = await fetch(manifestFetchUrl, {
            headers: upstreamHeaders,
            redirect: "follow",
            signal: controller.signal,
            // @ts-ignore
            tls: { rejectUnauthorized: false },
        });
        clearTimeout(timeout);

        if (!resp.ok) {
            return c.json({ error: `Manifest fetch failed: ${resp.status} ${manifestFetchUrl}` }, 502, CORS_HEADERS);
        }
        manifestText = await resp.text();
    } catch (err) {
        return c.json({ error: `Manifest fetch error: ${err instanceof Error ? err.message : String(err)}` }, 502, CORS_HEADERS);
    }

    // Step 2: Parse the manifest
    let parsed = parseM3u8(manifestText, upstreamUrl);

    // Step 3: If master playlist, fetch the best variant's media playlist
    if (parsed.type === "master") {
        if (!parsed.variants || parsed.variants.length === 0) {
            return c.json({ error: "Master playlist has no variants" }, 422, CORS_HEADERS);
        }
        const best = parsed.variants[0];

        if (debug) {
            return c.json({
                type: "master",
                selectedVariant: best,
                allVariants: parsed.variants,
                message: "Use the selectedVariant.url with /api/remux to get the actual segments.",
            }, 200, CORS_HEADERS);
        }

        try {
            const variantHeaders = generateHeadersOriginal(new URL(best.url));
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 15000);
            const resp = await fetch(best.url, {
                headers: variantHeaders,
                redirect: "follow",
                signal: controller.signal,
                // @ts-ignore
                tls: { rejectUnauthorized: false },
            });
            clearTimeout(timeout);

            if (!resp.ok) {
                return c.json({ error: `Variant playlist fetch failed: ${resp.status}` }, 502, CORS_HEADERS);
            }
            const variantText = await resp.text();
            parsed = parseM3u8(variantText, new URL(best.url));
        } catch (err) {
            return c.json({ error: `Variant fetch error: ${err instanceof Error ? err.message : String(err)}` }, 502, CORS_HEADERS);
        }
    }

    if (parsed.segments.length === 0) {
        return c.json({ error: "No segments found in media playlist" }, 422, CORS_HEADERS);
    }

    // Step 4: Separate init segments from media segments
    const initSegments = parsed.segments.filter((s) => s.isInit);
    const mediaSegments = parsed.segments.filter((s) => !s.isInit);

    // For m4s: init segment(s) first, then media segments
    // For ts: just media segments in order
    const orderedSegments = parsed.extension === "m4s"
        ? [...initSegments, ...mediaSegments]
        : mediaSegments;

    const totalSegments = orderedSegments.length;

    // Step 5: Stream the response using a ReadableStream
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();

    // Background: download and write segments
    (async () => {
        try {
            for (let i = 0; i < orderedSegments.length; i += concurrency) {
                const batch = orderedSegments.slice(i, i + concurrency);
                const batchBuffers = await Promise.all(
                    batch.map(async (seg) => {
                        const resolved = resolveSegmentUrl(seg.url, proxyOrigin);
                        return downloadSegment(resolved.url, resolved.headers, seg.byteRange);
                    }),
                );

                for (const buf of batchBuffers) {
                    await writer.write(new Uint8Array(buf));
                }
            }

            await writer.close();
        } catch (err) {
            console.error("[Remux Error]", err);
            try { await writer.abort(err); } catch {}
        }
    })();

    // Build response headers
    const responseHeaders: Record<string, string> = {
        ...CORS_HEADERS,
        "Content-Type": parsed.extension === "m4s" ? "video/mp4" : "video/mp2t",
        "Cache-Control": MEDIA_CACHE_CONTROL,
        "X-Remux-Segments": String(totalSegments),
        "X-Remux-Extension": parsed.extension,
        "Transfer-Encoding": "chunked",
    };

    if (debug) {
        responseHeaders["X-Debug-Segments"] = String(totalSegments);
        responseHeaders["X-Debug-Extension"] = parsed.extension;
        responseHeaders["X-Debug-HasInit"] = String(initSegments.length > 0);
    }

    return new Response(readable, {
        status: 200,
        headers: responseHeaders,
    });
}
