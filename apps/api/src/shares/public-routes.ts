import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  createAuthErrorResponse,
  galleryMediaQuerySchema,
  publicSharePageSchema,
} from "@family-album/contracts";

import { PublicAuthError } from "../auth/service.js";
import type { PublicShareService } from "./public-service.js";

export function registerPublicShareRoutes(
  app: FastifyInstance,
  options: { publicShareService: PublicShareService },
) {
  const { publicShareService } = options;

  app.get("/api/v1/share/:token", async (request, reply) =>
    handlePublic(request, reply, async () => {
      const token = routeToken(request.params);
      const query = galleryMediaQuerySchema.safeParse(request.query);
      if (!query.success) throw new PublicAuthError(404, "NOT_FOUND");
      const opened = await publicShareService.openAlbum(token, {
        limit: query.data.limit,
        ...(query.data.cursor ? { cursor: query.data.cursor } : {}),
      });
      request.log.info(
        {
          event: "share_access",
          requestId: request.id,
          resultCode: "SUCCESS",
          timestamp: new Date().toISOString(),
          shareId: opened.shareId,
        },
        "security event",
      );
      return publicHeaders(reply).send(
        publicSharePageSchema.parse({
          album: opened.album,
          media: opened.media,
          nextCursor: opened.nextCursor,
        }),
      );
    }),
  );

  app.get(
    "/api/v1/share/:token/media/:mediaId/derived/:kind",
    async (request, reply) =>
      handlePublic(request, reply, async () => {
        const params = request.params as {
          token?: unknown;
          mediaId?: unknown;
          kind?: unknown;
        };
        const served = await publicShareService.openDerived(
          params.token,
          typeof params.mediaId === "string" ? params.mediaId : "",
          typeof params.kind === "string" ? params.kind : "",
        );
        request.log.info(
          {
            event: "share_derived",
            requestId: request.id,
            resultCode: "SUCCESS",
            timestamp: new Date().toISOString(),
            kind:
              params.kind === "thumbnail" || params.kind === "preview"
                ? params.kind
                : "hidden",
          },
          "security event",
        );
        return publicHeaders(reply)
          .header("content-type", served.contentType)
          .header("content-length", String(served.bytes.length))
          .send(served.bytes);
      }),
  );
}

function routeToken(params: unknown) {
  if (!params || typeof params !== "object" || !("token" in params)) {
    return "";
  }
  return (params as { token: unknown }).token;
}

function publicHeaders(reply: FastifyReply) {
  return reply
    .header("cache-control", "private, no-store")
    .header("referrer-policy", "no-referrer");
}

async function handlePublic(
  request: FastifyRequest,
  reply: FastifyReply,
  operation: () => Promise<unknown>,
) {
  try {
    return await operation();
  } catch (error) {
    const category =
      error instanceof PublicAuthError ? error.errorCategory : undefined;
    request.log.warn(
      {
        event: "share_public",
        requestId: request.id,
        resultCode: "NOT_FOUND",
        ...(category ? { errorCategory: category } : {}),
        timestamp: new Date().toISOString(),
      },
      "security event",
    );
    return publicHeaders(reply)
      .status(404)
      .send(createAuthErrorResponse("NOT_FOUND", request.id));
  }
}
