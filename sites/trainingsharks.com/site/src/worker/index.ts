interface Env {
  ASSETS: { fetch: (request: Request) => Promise<Response> };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // www and apex are both bound to this worker; without this Google sees
    // identical content on two hosts. Apex is canonical.
    if (url.hostname === "www.trainingsharks.com") {
      url.hostname = "trainingsharks.com";
      return Response.redirect(url.toString(), 301);
    }
    if (url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }

    const res = await env.ASSETS.fetch(request);
    const headers = new Headers(res.headers);
    // The engine is a hand-rolled wasm module with no threading, so unlike
    // 0xroulette this site needs no COOP/COEP isolation. Do not add it
    // speculatively — it breaks ad iframes for no benefit here.
    if (url.pathname.endsWith(".wasm")) {
      headers.set("Content-Type", "application/wasm");
      headers.set("Cache-Control", "public, max-age=31536000, immutable");
    }
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
};
