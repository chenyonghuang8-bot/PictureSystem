import { digestStringAsync, CryptoDigestAlgorithm } from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import {
  invitationToken,
  invitationPreviewResponseSchema,
} from "@family-album/contracts";
import { request } from "./session";
const key = "family.album.invitation.v1";
let invitationEpoch = 0;
let intake: Promise<unknown> = Promise.resolve();
let handled: { hash: string; until: number } | null = null;
export async function acceptLink(url: string): Promise<boolean> {
  const task = intake.then(() => acceptSerial(url));
  intake = task.catch(() => {});
  return task;
}
async function acceptSerial(url: string) {
  const token = invitationToken(url);
  if (!token) return false;
  const hash = await digestStringAsync(CryptoDigestAlgorithm.SHA256, token);
  if (handled && handled.until > Date.now() && handled.hash === hash)
    return false;
  const old = await pendingInvitation();
  if (old?.token === token) return true;
  if (old) throw new Error("请先处理或取消当前邀请");
  invitationEpoch++;
  await SecureStore.setItemAsync(
    key,
    JSON.stringify({ token, until: Date.now() + 15 * 60000 }),
  );
  return true;
}
export async function pendingInvitation(): Promise<{
  token: string;
  until: number;
} | null> {
  const raw = await SecureStore.getItemAsync(key);
  if (!raw) return null;
  try {
    const x = JSON.parse(raw);
    if (
      typeof x.until !== "number" ||
      x.until < Date.now() ||
      !invitationToken("familyalbum://invite?token=" + x.token)
    )
      throw new Error();
    return x;
  } catch {
    await clearInvitation();
    return null;
  }
}
export async function clearInvitation() {
  invitationEpoch++;
  const old = await SecureStore.getItemAsync(key);
  if (old) {
    try {
      const x = JSON.parse(old);
      if (typeof x.token === "string")
        handled = {
          hash: await digestStringAsync(CryptoDigestAlgorithm.SHA256, x.token),
          until: Math.min(
            Date.now() + 15 * 60000,
            Number(x.until) || Date.now(),
          ),
        };
    } catch {
      /* No untrusted data in messages. */
    }
  }
  await SecureStore.deleteItemAsync(key);
}
export async function previewInvitation() {
  const x = await pendingInvitation();
  if (!x) return null;
  const epoch = invitationEpoch;
  const result = invitationPreviewResponseSchema.parse(
    await (
      await request(
        "/api/v1/android/invitations/preview",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: x.token }),
        },
        true,
      )
    ).json(),
  );
  if (epoch !== invitationEpoch) throw new Error("INVITATION_CHANGED");
  return result;
}
export async function consumeInvitation(username: string, password: string) {
  const x = await pendingInvitation();
  if (!x) throw new Error("邀请已过期");
  const epoch = invitationEpoch;
  await request(
    "/api/v1/android/invitations/consume",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: x.token, username, password }),
    },
    true,
  );
  if (epoch === invitationEpoch) await clearInvitation();
}
