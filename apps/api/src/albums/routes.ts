import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

import {
  albumParamsSchema,
  albumMemberMutationResponseSchema,
  albumMemberParamsSchema,
  albumMembersResponseSchema,
  albumResponseSchema,
  albumsResponseSchema,
  familyTimelinePageSchema,
  familyTimelineParamsSchema,
  galleryMediaDetailSchema,
  galleryMediaPageSchema,
  galleryMediaParamsSchema,
  galleryMediaQuerySchema,
  createAlbumRequestSchema,
  createAuthErrorResponse,
  deleteAlbumRequestSchema,
  deleteAlbumMemberRequestSchema,
  listAlbumsQuerySchema,
  putAlbumMemberRequestSchema,
  updateAlbumRequestSchema,
} from "@family-album/contracts";

import {
  readWebSessionCookie,
  requireTrustedJsonOrigin,
} from "../auth/http.js";
import { PublicAuthError, type AuthService } from "../auth/service.js";
import {
  decodeGalleryCursor,
  encodeGalleryCursor,
  familyTimelineItem,
  galleryMediaDetail,
  galleryMediaItem,
  type AlbumService,
} from "./service.js";

export function registerAlbumRoutes(
  app: FastifyInstance,
  options: {
    authService: AuthService;
    albumService: AlbumService;
    trustedOrigins: ReadonlySet<string>;
  },
) {
  const { authService, albumService, trustedOrigins } = options;

  app.addHook("onSend", async (request, reply) => {
    if (request.url.startsWith("/api/v1/albums")) {
      void reply.header("cache-control", "no-store");
    }
  });

  app.post("/api/v1/albums", { bodyLimit: 16_384 }, async (request, reply) =>
    handleAlbum(request, reply, "album_create", async () => {
      requireTrustedJsonOrigin(request, trustedOrigins);
      const body = createAlbumRequestSchema.parse(request.body);
      const context = await authenticate(request, authService);
      const created = await albumService.create(context, body);
      logAlbumEvent(request, "album_created", {
        actorUserId: context.identity.userId,
        actorMemberId: created.actorMemberId,
        familyId: created.familyId,
        albumId: created.id,
        revision: created.revision,
      });
      return reply.status(201).send(albumDto(created));
    }),
  );

  app.get("/api/v1/albums", async (request, reply) =>
    handleAlbum(request, reply, "album_list", async () => {
      const query = listAlbumsQuerySchema.parse(request.query);
      const context = await authenticate(request, authService);
      const albums = await albumService.list(context, {
        familyId: query.familyId,
        limit: query.limit,
        ...(query.afterId !== undefined ? { afterId: query.afterId } : {}),
      });
      return reply.send(
        albumsResponseSchema.parse({
          albums: albums.map(albumDto),
          nextAfterId: albums.length === query.limit ? albums.at(-1)!.id : null,
        }),
      );
    }),
  );

  app.get("/api/v1/families/:familyId/timeline", async (request, reply) =>
    handleAlbum(request, reply, "family_timeline", async () => {
      const { familyId } = familyTimelineParamsSchema.parse(request.params);
      const query = galleryMediaQuerySchema.parse(request.query);
      const context = await authenticate(request, authService);
      const cursor =
        query.cursor === undefined
          ? undefined
          : decodeGalleryCursor(query.cursor);
      const rows = await albumService.listTimeline(context, familyId, {
        limit: query.limit,
        ...(cursor ? { cursor } : {}),
      });
      const media = rows.map(familyTimelineItem);
      return reply.header("cache-control", "no-store").send(
        familyTimelinePageSchema.parse({
          media,
          nextCursor:
            media.length === query.limit
              ? encodeGalleryCursor(media.at(-1)!)
              : null,
        }),
      );
    }),
  );

  app.get("/api/v1/albums/:albumId/media", async (request, reply) =>
    handleAlbum(request, reply, "album_media_list", async () => {
      const { albumId } = albumParamsSchema.parse(request.params);
      const query = galleryMediaQuerySchema.parse(request.query);
      const context = await authenticate(request, authService);
      const cursor =
        query.cursor === undefined
          ? undefined
          : decodeGalleryCursor(query.cursor);
      const rows = await albumService.listMedia(context, albumId, {
        limit: query.limit,
        ...(cursor ? { cursor } : {}),
      });
      const media = rows.map(galleryMediaItem);
      const page = galleryMediaPageSchema.parse({
        media,
        nextCursor:
          media.length === query.limit
            ? encodeGalleryCursor(media.at(-1)!)
            : null,
      });
      logAlbumEvent(request, "album_media_list", {
        actorUserId: context.identity.userId,
        albumId,
      });
      return reply.send(page);
    }),
  );

  app.get("/api/v1/albums/:albumId/media/:mediaId", async (request, reply) =>
    handleAlbum(request, reply, "album_media_get", async () => {
      const { albumId, mediaId } = galleryMediaParamsSchema.parse(
        request.params,
      );
      const context = await authenticate(request, authService);
      const row = await albumService.getMedia(context, albumId, mediaId);
      logAlbumEvent(request, "album_media_get", {
        actorUserId: context.identity.userId,
        albumId,
      });
      return reply.send(
        galleryMediaDetailSchema.parse(galleryMediaDetail(row)),
      );
    }),
  );

  app.get("/api/v1/albums/:albumId", async (request, reply) =>
    handleAlbum(request, reply, "album_get", async () => {
      const { albumId } = albumParamsSchema.parse(request.params);
      const context = await authenticate(request, authService);
      return reply.send(albumDto(await albumService.get(context, albumId)));
    }),
  );

  app.patch(
    "/api/v1/albums/:albumId",
    { bodyLimit: 16_384 },
    async (request, reply) =>
      handleAlbum(request, reply, "album_update", async () => {
        requireTrustedJsonOrigin(request, trustedOrigins);
        const { albumId } = albumParamsSchema.parse(request.params);
        const body = updateAlbumRequestSchema.parse(request.body);
        const context = await authenticate(request, authService);
        const updated = await albumService.update(context, albumId, body);
        if (updated.changedFields.some((field) => field !== "visibility")) {
          logAlbumEvent(request, "album_updated", {
            actorUserId: context.identity.userId,
            actorMemberId: updated.actorMemberId,
            familyId: updated.familyId,
            albumId,
            revision: updated.revision,
            changedFields: updated.changedFields,
          });
        }
        if (updated.changedFields.includes("visibility")) {
          logAlbumEvent(request, "album_visibility_changed", {
            actorUserId: context.identity.userId,
            actorMemberId: updated.actorMemberId,
            familyId: updated.familyId,
            albumId,
            revision: updated.revision,
            changedFields: ["visibility"],
          });
        }
        return reply.send(albumDto(updated));
      }),
  );

  app.delete(
    "/api/v1/albums/:albumId",
    { bodyLimit: 16_384 },
    async (request, reply) =>
      handleAlbum(request, reply, "album_delete", async () => {
        requireTrustedJsonOrigin(request, trustedOrigins);
        const { albumId } = albumParamsSchema.parse(request.params);
        const { expectedRevision } = deleteAlbumRequestSchema.parse(
          request.body,
        );
        const context = await authenticate(request, authService);
        const deleted = await albumService.remove(
          context,
          albumId,
          expectedRevision,
        );
        logAlbumEvent(request, "album_deleted", {
          actorUserId: context.identity.userId,
          actorMemberId: deleted.actorMemberId,
          familyId: deleted.familyId,
          albumId,
          revision: deleted.revision,
        });
        return reply.status(204).send();
      }),
  );

  app.get("/api/v1/albums/:albumId/members", async (request, reply) =>
    handleAlbum(request, reply, "album_member_list", async () => {
      const { albumId } = albumParamsSchema.parse(request.params);
      const context = await authenticate(request, authService);
      const members = await albumService.listMembers(context, albumId);
      return reply.send(albumMembersResponseSchema.parse({ members }));
    }),
  );

  app.put(
    "/api/v1/albums/:albumId/members/:memberId",
    { bodyLimit: 16_384 },
    async (request, reply) =>
      handleAlbum(request, reply, "album_member_put", async () => {
        requireTrustedJsonOrigin(request, trustedOrigins);
        const { albumId, memberId } = albumMemberParamsSchema.parse(
          request.params,
        );
        const body = putAlbumMemberRequestSchema.parse(request.body);
        const context = await authenticate(request, authService);
        const result = await albumService.putMember(
          context,
          albumId,
          memberId,
          body,
        );
        if (result.action !== "NONE") {
          logAlbumEvent(
            request,
            result.action === "ADDED"
              ? "album_member_added"
              : "album_permission_changed",
            {
              actorUserId: context.identity.userId,
              actorMemberId: result.actorMemberId,
              targetMemberId: memberId,
              familyId: result.familyId,
              albumId,
              revision: result.revision,
            },
          );
        }
        return reply.send(
          albumMemberMutationResponseSchema.parse({
            revision: result.revision,
          }),
        );
      }),
  );

  app.delete(
    "/api/v1/albums/:albumId/members/:memberId",
    { bodyLimit: 16_384 },
    async (request, reply) =>
      handleAlbum(request, reply, "album_member_remove", async () => {
        requireTrustedJsonOrigin(request, trustedOrigins);
        const { albumId, memberId } = albumMemberParamsSchema.parse(
          request.params,
        );
        const { expectedRevision } = deleteAlbumMemberRequestSchema.parse(
          request.body,
        );
        const context = await authenticate(request, authService);
        const result = await albumService.removeMember(
          context,
          albumId,
          memberId,
          expectedRevision,
        );
        if (result.changed) {
          logAlbumEvent(request, "album_member_removed", {
            actorUserId: context.identity.userId,
            actorMemberId: result.actorMemberId,
            targetMemberId: memberId,
            familyId: result.familyId,
            albumId,
            revision: result.revision,
          });
        }
        return reply.status(204).send();
      }),
  );
}

async function authenticate(request: FastifyRequest, service: AuthService) {
  const token = readWebSessionCookie(request);
  if (!token) throw new PublicAuthError(401, "UNAUTHENTICATED");
  return service.authenticate(token);
}

async function handleAlbum(
  request: FastifyRequest,
  reply: FastifyReply,
  event: string,
  operation: () => Promise<unknown>,
) {
  try {
    return await operation();
  } catch (error) {
    const publicError =
      error instanceof PublicAuthError
        ? error
        : error instanceof ZodError
          ? new PublicAuthError(400, "INVALID_REQUEST")
          : new PublicAuthError(503, "SERVICE_UNAVAILABLE");
    logAlbumFailure(
      request,
      event,
      publicError.code,
      publicError.errorCategory,
    );
    return reply
      .status(publicError.statusCode)
      .send(createAuthErrorResponse(publicError.code, request.id));
  }
}

function albumDto(album: {
  id: string;
  familyId: string;
  ownerMemberId: string;
  name: string;
  description: string | null;
  visibility: "FAMILY" | "CUSTOM";
  revision: string;
  createdAt: Date;
  updatedAt: Date;
  effectivePermissions: {
    canView: boolean;
    canUpload: boolean;
    canEdit: boolean;
    canDelete: boolean;
    canManageMembers: boolean;
  };
}) {
  return albumResponseSchema.parse({
    id: album.id,
    familyId: album.familyId,
    ownerMemberId: album.ownerMemberId,
    name: album.name,
    description: album.description,
    visibility: album.visibility,
    revision: album.revision,
    createdAt: album.createdAt.toISOString(),
    updatedAt: album.updatedAt.toISOString(),
    effectivePermissions: album.effectivePermissions,
  });
}

type AlbumIdentifiers = {
  actorUserId?: string;
  actorMemberId?: string;
  familyId?: string;
  albumId?: string;
  revision?: string;
  changedFields?: string[];
  targetMemberId?: string;
};

export function logAlbumEvent(
  request: FastifyRequest,
  event: string,
  identifiers: AlbumIdentifiers,
) {
  request.log.info(
    {
      event,
      requestId: request.id,
      resultCode: "SUCCESS",
      timestamp: new Date().toISOString(),
      ...withoutUndefined({
        actorUserId: identifiers.actorUserId,
        actorMemberId: identifiers.actorMemberId,
        familyId: identifiers.familyId,
        albumId: identifiers.albumId,
        revision: identifiers.revision,
        changedFields: identifiers.changedFields,
        targetMemberId: identifiers.targetMemberId,
      }),
    },
    "security event",
  );
}

function withoutUndefined(input: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(input).filter((entry) => entry[1] !== undefined),
  );
}

function logAlbumFailure(
  request: FastifyRequest,
  event: string,
  resultCode: string,
  errorCategory?: string,
) {
  request.log.warn(
    {
      event,
      requestId: request.id,
      resultCode,
      ...(errorCategory ? { errorCategory } : {}),
      timestamp: new Date().toISOString(),
    },
    "security event",
  );
}
