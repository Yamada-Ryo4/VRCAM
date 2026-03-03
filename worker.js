/**
 * VRChat Asset Manager — Cloudflare Worker
 * Proxies VRChat API calls to bypass CORS restrictions.
 * The browser handles S3 uploads directly for maximum speed.
 */

const VRC_API = "https://api.vrchat.cloud/api/1";
const API_KEY = "JlGlobalv959ay9puS6p99En0asKuAk";
const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-VRC-Auth",
    "Access-Control-Expose-Headers": "X-VRC-Auth",
};

function jsonResp(data, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...extraHeaders },
    });
}

/**
 * Forward a request to VRChat API, preserving auth cookies.
 * Auth cookies are passed via X-VRC-Auth header (base64-encoded cookie string)
 * since Workers can't share browser cookies cross-origin.
 */
async function vrcFetch(path, options = {}, authCookies = "") {
    const url = `${VRC_API}${path}${path.includes("?") ? "&" : "?"}apiKey=${API_KEY}`;
    const headers = {
        "User-Agent": USER_AGENT,
        ...(options.headers || {}),
    };
    if (authCookies) {
        headers["Cookie"] = authCookies;
    }
    if (options.json) {
        headers["Content-Type"] = "application/json";
        options.body = JSON.stringify(options.json);
        delete options.json;
    }

    const resp = await fetch(url, {
        method: options.method || "GET",
        headers,
        body: options.body,
        redirect: "manual",
    });

    // Collect set-cookie headers to pass back
    const setCookies = resp.headers.getAll
        ? resp.headers.getAll("set-cookie")
        : [resp.headers.get("set-cookie")].filter(Boolean);

    return { resp, setCookies };
}

function getAuth(request) {
    const header = request.headers.get("X-VRC-Auth") || "";
    if (!header) return "";
    try {
        return atob(header);
    } catch {
        return header;
    }
}

function mergeCookies(existing, newCookies) {
    const map = {};
    // Parse existing
    if (existing) {
        existing.split(";").forEach((c) => {
            const [k, ...v] = c.trim().split("=");
            if (k) map[k.trim()] = v.join("=");
        });
    }
    // Parse new set-cookie headers
    newCookies.forEach((sc) => {
        const [pair] = sc.split(";");
        const [k, ...v] = pair.split("=");
        if (k) map[k.trim()] = v.join("=");
    });
    return Object.entries(map)
        .map(([k, v]) => `${k}=${v}`)
        .join("; ");
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const path = url.pathname;

        // Handle CORS preflight
        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        // Serve index.html for root
        if (path === "/" || path === "/index.html") {
            // In production, this would be served from Workers Sites / Pages
            // For local dev, wrangler serves static files from the bucket
            return env.ASSETS
                ? env.ASSETS.fetch(request)
                : new Response("Serve index.html via wrangler pages or static site", { status: 200 });
        }

        // ── API Routes ──
        const auth = getAuth(request);

        // POST /api/login
        if (path === "/api/login" && request.method === "POST") {
            const body = await request.json();
            const basicAuth = btoa(`${body.username}:${body.password}`);

            const { resp, setCookies } = await vrcFetch("/auth/user", {
                method: "GET",
                headers: { Authorization: `Basic ${basicAuth}` },
            });

            const data = await resp.json();
            const cookies = mergeCookies("", setCookies);

            if (resp.status === 200) {
                const needs2FA =
                    data.requiresTwoFactorAuth && data.requiresTwoFactorAuth.length > 0;
                return jsonResp(
                    { ok: true, needs2FA, user: data },
                    200,
                    { "X-VRC-Auth": btoa(cookies) }
                );
            }
            return jsonResp({ ok: false, message: data.error?.message || "Login failed" }, resp.status);
        }

        // POST /api/2fa
        if (path === "/api/2fa" && request.method === "POST") {
            const body = await request.json();
            const { resp, setCookies } = await vrcFetch(
                "/auth/twofactorauth/totp/verify",
                {
                    method: "POST",
                    json: { code: body.code },
                    headers: {},
                },
                auth
            );

            const data = await resp.json();
            const cookies = mergeCookies(auth, setCookies);

            if (resp.status === 200 && data.verified) {
                return jsonResp({ ok: true }, 200, { "X-VRC-Auth": btoa(cookies) });
            }
            return jsonResp({ ok: false, message: "Invalid code" }, 400);
        }

        // GET /api/avatars
        if (path === "/api/avatars" && request.method === "GET") {
            // Get current user first
            const { resp: userResp } = await vrcFetch("/auth/user", {}, auth);
            if (userResp.status !== 200) {
                return jsonResp({ error: "Not authenticated" }, 401);
            }

            const user = await userResp.json();
            const avatarIds = user.currentAvatarAssetUrl
                ? [user.currentAvatar, ...(user.fallbackAvatar ? [user.fallbackAvatar] : [])]
                : [];

            // Fetch all owned avatars
            let allAvatars = [];
            let offset = 0;
            const limit = 100;
            while (true) {
                const { resp } = await vrcFetch(
                    `/avatars?releaseStatus=all&user=me&n=${limit}&offset=${offset}`,
                    {},
                    auth
                );
                if (resp.status !== 200) break;
                const batch = await resp.json();
                if (!batch || batch.length === 0) break;
                allAvatars = allAvatars.concat(batch);
                if (batch.length < limit) break;
                offset += limit;
            }

            return jsonResp(allAvatars);
        }

        // Proxy any /api/vrc/* to VRChat API
        if (path.startsWith("/api/vrc/")) {
            const vrcPath = path.replace("/api/vrc", "");
            const method = request.method;
            let body = null;
            let headers = {};

            if (["POST", "PUT", "PATCH"].includes(method)) {
                const ct = request.headers.get("content-type") || "";
                if (ct.includes("application/json")) {
                    body = await request.text();
                    headers["Content-Type"] = "application/json";
                }
            }

            const { resp, setCookies } = await vrcFetch(
                vrcPath + url.search,
                { method, body, headers },
                auth
            );

            const respBody = await resp.text();
            const cookies = mergeCookies(auth, setCookies);

            return new Response(respBody, {
                status: resp.status,
                headers: {
                    "Content-Type": resp.headers.get("content-type") || "application/json",
                    ...CORS_HEADERS,
                    "X-VRC-Auth": btoa(cookies),
                },
            });
        }
        // GET /api/download?url=...&filename=... — Proxy download with correct filename
        // Since this response is same-origin, browser `a.download` attribute works correctly.
        if (path === "/api/download" && request.method === "GET") {
            const vrcUrl = url.searchParams.get("url");
            const filename = url.searchParams.get("filename") || "avatar.vrca";
            if (!vrcUrl) return jsonResp({ error: "Missing url param" }, 400);

            // Step 1: Resolve VRChat file URL → S3 CDN URL (follows one redirect with auth)
            const step1 = await fetch(vrcUrl, {
                method: "GET",
                headers: { "User-Agent": USER_AGENT, ...(auth ? { "Cookie": auth } : {}) },
                redirect: "manual",
            });

            let cdnUrl = vrcUrl;
            if (step1.status === 301 || step1.status === 302) {
                cdnUrl = step1.headers.get("Location") || vrcUrl;
            } else if (step1.status === 401) {
                return jsonResp({ error: "VRChat auth expired" }, 401);
            }

            // Step 2: Fetch from CDN and stream back with Content-Disposition
            const cdnResp = await fetch(cdnUrl, { method: "GET" });
            if (!cdnResp.ok) return jsonResp({ error: `CDN fetch failed: ${cdnResp.status}` }, cdnResp.status);

            const safeFilename = encodeURIComponent(filename);
            return new Response(cdnResp.body, {
                status: 200,
                headers: {
                    "Content-Type": "application/octet-stream",
                    "Content-Disposition": `attachment; filename="${filename}"; filename*=UTF-8''${safeFilename}`,
                    "Content-Length": cdnResp.headers.get("Content-Length") || "",
                    ...CORS_HEADERS,
                },
            });
        }

        // POST /api/resolve-url — Resolve a VRChat file URL to a real CDN URL (follows redirects with auth)
        if (path === "/api/resolve-url" && request.method === "POST") {
            const body = await request.json();
            const vrcUrl = body.url;
            if (!vrcUrl) return jsonResp({ error: "Missing url" }, 400);

            // Fetch with auth cookies; VRChat /file/.../file returns 302 -> S3 presigned URL
            const resp = await fetch(vrcUrl, {
                method: "GET",
                headers: {
                    "User-Agent": USER_AGENT,
                    ...(auth ? { "Cookie": auth } : {}),
                },
                redirect: "manual",   // Don't auto-follow — grab the Location header
            });

            // Expect a 302 redirect to the real CDN URL
            if (resp.status === 302 || resp.status === 301) {
                const cdnUrl = resp.headers.get("Location");
                if (cdnUrl) return jsonResp({ cdnUrl }, 200);
            }

            // Some older URLs redirect multiple times — follow once more
            if (resp.status >= 200 && resp.status < 300) {
                // Directly returned the file — shouldn't happen but handle gracefully
                return jsonResp({ cdnUrl: vrcUrl }, 200);
            }

            if (resp.status === 401) return jsonResp({ error: "VRChat auth expired, please log out and back in" }, 401);

            return jsonResp({ error: `VRChat returned ${resp.status}` }, resp.status);
        }

        // POST /api/s3proxy — Proxy S3 uploads (bypass CORS)
        // Body: raw file data, Headers: X-S3-Url (the pre-signed URL), optional Content-Type/Content-MD5
        if (path === "/api/s3proxy" && request.method === "PUT") {
            const s3Url = request.headers.get("X-S3-Url");
            if (!s3Url) return jsonResp({ error: "Missing X-S3-Url header" }, 400);

            const s3Headers = {};
            const ct = request.headers.get("X-S3-Content-Type");
            if (ct) s3Headers["Content-Type"] = ct;
            const cmd5 = request.headers.get("X-S3-Content-MD5");
            if (cmd5) s3Headers["Content-MD5"] = cmd5;

            const s3Resp = await fetch(s3Url, {
                method: "PUT",
                headers: s3Headers,
                body: request.body,
            });

            const etag = s3Resp.headers.get("ETag") || "";
            if (s3Resp.ok) {
                return jsonResp({ ok: true, etag: etag.replace(/"/g, "") }, 200);
            } else {
                const errText = await s3Resp.text();
                return jsonResp({ ok: false, status: s3Resp.status, error: errText.substring(0, 500) }, s3Resp.status);
            }
        }

        return jsonResp({ error: "Not found" }, 404);
    },
};
