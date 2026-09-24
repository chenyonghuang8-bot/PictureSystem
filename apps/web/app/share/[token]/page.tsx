import type { Metadata } from "next";

import {
  PublicShare,
  PublicShareMissing,
} from "../../../components/gallery/public-share.js";
import { UnavailableState } from "../../../components/gallery/states.js";
import { GalleryClientError } from "../../../lib/gallery-client.js";
import { loadPublicShare } from "../../../lib/share-server.js";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "分享",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

const PAGE_SIZE = 24;

export default async function PublicSharePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  try {
    const page = await loadPublicShare(token, { limit: PAGE_SIZE });
    return <PublicShare token={token} initial={page} />;
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === "SHARE_TOKEN_INVALID" ||
        (error instanceof GalleryClientError && error.code === "NOT_FOUND"))
    ) {
      return <PublicShareMissing />;
    }
    return (
      <main className="gallery-public">
        <UnavailableState />
      </main>
    );
  }
}
