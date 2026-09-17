import { Writable } from "node:stream";

import pino from "pino";
import { describe, expect, it } from "vitest";

import { createLoggerOptions } from "@family-album/config";

describe("authentication log redaction", () => {
  it("removes credentials and token material from actual Pino output", async () => {
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    });
    const secrets = {
      password: "LOG_SECRET_PASSWORD",
      currentPassword: "LOG_SECRET_CURRENT_PASSWORD",
      newPassword: "LOG_SECRET_NEW_PASSWORD",
      cookie: "LOG_SECRET_COOKIE",
      authorization: "LOG_SECRET_AUTHORIZATION",
      sessionToken: "LOG_SECRET_RAW_TOKEN",
      tokenHash: "LOG_SECRET_TOKEN_HASH",
      invitationToken: "LOG_SECRET_INVITATION_TOKEN",
      invitationUrl: "https://album.example/join#token=LOG_SECRET_FRAGMENT",
      token: "LOG_SECRET_GENERIC_TOKEN",
      uploadMetadata: "LOG_SECRET_UPLOAD_METADATA",
      originalFilename: "LOG_SECRET_FILENAME",
      reportedMime: "LOG_SECRET_MIME",
      storagePath: "LOG_SECRET_STORAGE_PATH",
      computedSha256: "LOG_SECRET_MEDIA_HASH",
    };
    const logger = pino(createLoggerOptions(), stream);

    logger.warn({
      password: secrets.password,
      currentPassword: secrets.currentPassword,
      newPassword: secrets.newPassword,
      sessionToken: secrets.sessionToken,
      tokenHash: secrets.tokenHash,
      invitationToken: secrets.invitationToken,
      invitationUrl: secrets.invitationUrl,
      token: secrets.token,
      uploadMetadata: secrets.uploadMetadata,
      originalFilename: secrets.originalFilename,
      reportedMime: secrets.reportedMime,
      storagePath: secrets.storagePath,
      computedSha256: secrets.computedSha256,
      upload: {
        uploadMetadata: secrets.uploadMetadata,
        originalFilename: secrets.originalFilename,
        reportedMime: secrets.reportedMime,
        storagePath: secrets.storagePath,
        computedSha256: secrets.computedSha256,
      },
      body: {
        password: secrets.password,
        currentPassword: secrets.currentPassword,
        newPassword: secrets.newPassword,
        sessionToken: secrets.sessionToken,
        tokenHash: secrets.tokenHash,
        invitationToken: secrets.invitationToken,
        invitationUrl: secrets.invitationUrl,
        uploadMetadata: secrets.uploadMetadata,
        originalFilename: secrets.originalFilename,
        reportedMime: secrets.reportedMime,
        storagePath: secrets.storagePath,
        computedSha256: secrets.computedSha256,
      },
      req: {
        headers: {
          cookie: secrets.cookie,
          authorization: secrets.authorization,
          "upload-metadata": secrets.uploadMetadata,
        },
        body: {
          password: secrets.password,
          currentPassword: secrets.currentPassword,
          newPassword: secrets.newPassword,
          sessionToken: secrets.sessionToken,
          tokenHash: secrets.tokenHash,
          invitationToken: secrets.invitationToken,
          invitationUrl: secrets.invitationUrl,
          uploadMetadata: secrets.uploadMetadata,
          originalFilename: secrets.originalFilename,
          reportedMime: secrets.reportedMime,
          storagePath: secrets.storagePath,
          computedSha256: secrets.computedSha256,
        },
      },
    });
    await new Promise<void>((resolve) => stream.end(resolve));

    const output = chunks.join("");
    for (const secret of Object.values(secrets)) {
      expect(output).not.toContain(secret);
    }
    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain("stack");
  });
});
