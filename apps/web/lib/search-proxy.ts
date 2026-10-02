// A narrow boundary avoids Next external-proxy errors logging private search URLs.
// The API remains the authority for strict queries, sessions and album visibility.
export async function forwardFamilySearch(
  request: Request,
  context: { params: Promise<{ familyId: string }> },
  resource: "search" | "search/options",
) {
  try {
    const { familyId } = await context.params;
    const origin = new URL(
      process.env.FAMILY_ALBUM_API_ORIGIN ?? "http://127.0.0.1:4000",
    );
    if (!["http:", "https:"].includes(origin.protocol)) throw new Error();
    const target = new URL(
      `/api/v1/families/${encodeURIComponent(familyId)}/${resource}`,
      origin.origin,
    );
    target.search = new URL(request.url).search;
    const headers = new Headers();
    // Preserve Cookie/Bearer mixing for the API to reject; never authenticate here.
    for (const name of [
      "cookie",
      "authorization",
      "origin",
      "content-type",
      "accept",
    ]) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    const upstream = await fetch(target, {
      method: "GET",
      headers,
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]),
    });
    const responseHeaders = new Headers({
      "cache-control": "private, no-store",
    });
    const contentType = upstream.headers.get("content-type");
    if (contentType) responseHeaders.set("content-type", contentType);
    return new Response(await upstream.arrayBuffer(), {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (error) {
    // Only fixed categories are emitted. Raw exceptions can carry target URLs.
    let category = "UPSTREAM_FAILURE";
    if (error instanceof Error) {
      const cause = error.cause;
      const code =
        cause && typeof cause === "object" && "code" in cause
          ? cause.code
          : undefined;
      if (code === "ECONNREFUSED") category = "ECONNREFUSED";
      else if (code === "ETIMEDOUT" || error.name === "TimeoutError")
        category = "TIMEOUT";
      else if (error.name === "AbortError") category = "REQUEST_ABORTED";
    }
    console.error(
      JSON.stringify({
        event: "family_search_proxy_failed",
        errorCategory: category,
      }),
    );
    return new Response("Internal Server Error", {
      status: 500,
      headers: {
        "cache-control": "private, no-store",
        "content-type": "text/plain; charset=utf-8",
      },
    });
  }
}
