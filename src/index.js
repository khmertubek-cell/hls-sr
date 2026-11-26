const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Range, Content-Type",
  "Access-Control-Expose-Headers":
    "Content-Length, Content-Range, Accept-Ranges"
};

function errorResponse(message, status = 400) {
  return new Response(message, {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function isPlaylist(url) {
  return /\.m3u8?$/i.test(url.pathname);
}

function rewriteUrl(value, base, origin) {
  try {
    const target = new URL(value, base);

    // Never proxy a different hostname.
    if (target.origin !== origin) return value;

    return `/proxy?url=${encodeURIComponent(target.href)}`;
  } catch {
    return value;
  }
}

function rewritePlaylist(text, base, origin) {
  return text
    .split(/\r?\n/)
    .map(line => {
      const trimmed = line.trim();

      if (!trimmed) return line;

      // Rewrite URI attributes, such as encryption keys
      // and alternate audio playlists.
      if (trimmed.startsWith("#")) {
        return line.replace(
          /URI="([^"]+)"/g,
          (_, uri) => `URI="${rewriteUrl(uri, base, origin)}"`
        );
      }

      return rewriteUrl(trimmed, base, origin);
    })
    .join("\n");
}

export default {
  async fetch(request, env) {
    const reqUrl = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    if (!["GET", "HEAD"].includes(request.method)) {
      return errorResponse("Method not allowed", 405);
    }

    if (!env.UPSTREAM_PLAYLIST_URL) {
      return errorResponse("Upstream is not configured", 500);
    }

    let upstreamBase;

    try {
      upstreamBase = new URL(env.UPSTREAM_PLAYLIST_URL);
    } catch {
      return errorResponse("Invalid upstream configuration", 500);
    }

    if (!["https:", "http:"].includes(upstreamBase.protocol)) {
      return errorResponse("Unsupported upstream protocol", 500);
    }

    let target;

    if (reqUrl.pathname === "/") {
      target = upstreamBase;
    } else if (reqUrl.pathname === "/proxy") {
      const rawUrl = reqUrl.searchParams.get("url");

      if (!rawUrl) {
        return errorResponse("Missing url parameter");
      }

      try {
        target = new URL(rawUrl);
      } catch {
        return errorResponse("Invalid URL");
      }
    } else if (reqUrl.pathname === "/health") {
      return new Response("HLS proxy is running", {
        headers: {
          ...corsHeaders,
          "Content-Type": "text/plain"
        }
      });
    } else {
      return errorResponse("Not found", 404);
    }

    // Strict same-origin restriction prevents arbitrary URL fetching.
    if (target.origin !== upstreamBase.origin) {
      return errorResponse("Upstream origin not allowed", 403);
    }

    const headers = new Headers();

    const range = request.headers.get("Range");
    if (range) headers.set("Range", range);

    const fetchUrl = target.href;

    let upstream;

    try {
      upstream = await fetch(fetchUrl, {
        method: request.method,
        headers,
        redirect: "manual"
      });
    } catch {
      return errorResponse("Unable to connect to upstream", 502);
    }

    // Do not follow redirects to an unapproved host.
    if (upstream.status >= 300 && upstream.status < 400) {
      return errorResponse("Upstream redirects are not supported", 502);
    }

    const responseHeaders = new Headers(corsHeaders);

    for (const name of [
      "Content-Type",
      "Content-Range",
      "Accept-Ranges",
      "Last-Modified",
      "ETag"
    ]) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }

    responseHeaders.set("Cache-Control", "no-store");

    const contentType =
      upstream.headers.get("Content-Type") || "";

    const playlist =
      isPlaylist(target) ||
      contentType.includes("mpegurl");

    if (playlist && upstream.ok && request.method === "GET") {
      const body = await upstream.text();

      const rewritten = rewritePlaylist(
        body,
        target,
        upstreamBase.origin
      );

      responseHeaders.set(
        "Content-Type",
        "application/vnd.apple.mpegurl"
      );

      return new Response(rewritten, {
        status: upstream.status,
        headers: responseHeaders
      });
    }

    return new Response(
      request.method === "HEAD" ? null : upstream.body,
      {
        status: upstream.status,
        headers: responseHeaders
      }
    );
  }
};
