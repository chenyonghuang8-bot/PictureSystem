import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";

import { writeBackpressured } from "./sender.js";

describe("original attachment sender", () => {
  it("waits for both write callback and drain", async () => {
    const response = new EventEmitter() as EventEmitter & {
      write: (bytes: Buffer, callback: (error?: Error) => void) => boolean;
    };
    let callback: (() => void) | undefined;
    response.write = (_bytes, done) => {
      callback = done;
      return false;
    };
    let settled = false;
    const pending = writeBackpressured(
      response as unknown as ServerResponse,
      Buffer.from("abc"),
      new AbortController().signal,
    ).then(() => {
      settled = true;
    });
    callback!();
    await Promise.resolve();
    expect(settled).toBe(false);
    response.emit("drain");
    await pending;
    expect(settled).toBe(true);
    expect(response.listenerCount("drain")).toBe(0);
    expect(response.listenerCount("error")).toBe(0);
    expect(response.listenerCount("close")).toBe(0);
  });

  it("cancels a backpressure wait without leaking listeners", async () => {
    const response = new EventEmitter() as EventEmitter & {
      write: (bytes: Buffer, callback: (error?: Error) => void) => boolean;
    };
    response.write = (_bytes, callback) => {
      callback();
      return false;
    };
    const controller = new AbortController();
    const pending = writeBackpressured(
      response as unknown as ServerResponse,
      Buffer.from("abc"),
      controller.signal,
    );
    controller.abort(new Error("idle timeout"));
    await expect(pending).rejects.toThrow("idle timeout");
    expect(response.listenerCount("drain")).toBe(0);
    expect(response.listenerCount("error")).toBe(0);
    expect(response.listenerCount("close")).toBe(0);
  });
});
