import { GalleryShell } from "../../components/gallery/shell.js";
import { GalleryFallback } from "../../components/gallery/fallback.js";
import { AccountForm } from "../../components/mobile/account.js";
import { loadFamily } from "../../lib/gallery-server.js";
export const dynamic = "force-dynamic";
export default async function MyPage() {
  try {
    const family = await loadFamily();
    return (
      <GalleryShell
        familyName={family.familyName}
        userId={family.userId}
        familyId={family.familyId}
        active="my"
      >
        <h1>我的</h1>
        <section className="mobile-account-card">
          <h2>{family.displayName}</h2>
          <p>{family.familyName}</p>
          <AccountForm signedIn />
        </section>
        <section className="mobile-account-card">
          <h2>手机使用</h2>
          <p>在鸿蒙6.1浏览器打开这个地址，从浏览器菜单添加桌面快捷方式。</p>
          <p>
            上传只在网页前台进行。重新打开后按提示选择原照片继续；清除站点数据会丢失本地上传记录。
          </p>
        </section>
      </GalleryShell>
    );
  } catch (error) {
    return (
      <GalleryShell familyName="家庭相册" active="my">
        <GalleryFallback error={error} />
      </GalleryShell>
    );
  }
}
