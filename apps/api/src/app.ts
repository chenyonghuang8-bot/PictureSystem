import Fastify, { LogController } from "fastify";
import { createLoggerOptions } from "@family-album/config";
import { healthResponseSchema } from "@family-album/contracts";
import { handleAuthFrameworkError, registerAuthRoutes } from "./auth/routes.js";
import type { AuthService } from "./auth/service.js";
import { registerPhase1CRoutes } from "./phase1c/routes.js";
import type { Phase1CService } from "./phase1c/service.js";
import { registerAlbumRoutes } from "./albums/routes.js";
import type { AlbumService } from "./albums/service.js";
import { registerUploadRoutes } from "./uploads/routes.js";
import type { UploadService } from "./uploads/service.js";
import type { UploadMutex } from "./uploads/mutex.js";

export function createApp(options?: {
  authService: AuthService;
  phase1cService?: Phase1CService;
  albumService?: AlbumService;
  uploadService?: UploadService;
  publicApiOrigin?: string;
  trustedOrigins: ReadonlySet<string>;
  trustedProxies?: readonly string[];
  uploadMutex?: UploadMutex;
}) {
  const app = Fastify({
    logger: createLoggerOptions(),
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy:
      options?.trustedProxies && options.trustedProxies.length > 0
        ? [...options.trustedProxies]
        : false,
  });

  app.get("/health", async () =>
    healthResponseSchema.parse({
      status: "ok",
      service: "api",
      timestamp: new Date().toISOString(),
    }),
  );

  if (options) {
    registerAuthRoutes(app, {
      service: options.authService,
      trustedOrigins: options.trustedOrigins,
    });
    if (options.phase1cService) {
      registerPhase1CRoutes(app, {
        authService: options.authService,
        phase1cService: options.phase1cService,
        trustedOrigins: options.trustedOrigins,
      });
    }
    if (options.albumService) {
      registerAlbumRoutes(app, {
        authService: options.authService,
        albumService: options.albumService,
        trustedOrigins: options.trustedOrigins,
      });
    }
    if (options.uploadService && options.publicApiOrigin) {
      registerUploadRoutes(app, {
        authService: options.authService,
        uploadService: options.uploadService,
        trustedOrigins: options.trustedOrigins,
        publicApiOrigin: options.publicApiOrigin,
        ...(options.uploadMutex ? { mutex: options.uploadMutex } : {}),
      });
    }
    app.setErrorHandler(handleAuthFrameworkError);
  }

  return app;
}
