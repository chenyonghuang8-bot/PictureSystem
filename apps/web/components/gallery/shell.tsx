import type { ReactNode } from "react";

const LATER = ["回忆", "地图", "收藏", "家庭成员", "管理后台"] as const;

export function GalleryShell({
  familyName,
  active,
  aside,
  children,
}: {
  familyName: string;
  active: "photos" | "albums";
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="gallery-shell">
      <nav className="gallery-nav" aria-label="主导航">
        <p className="gallery-family">{familyName}</p>
        <a href="/" aria-current={active === "photos" ? "page" : undefined}>
          照片
        </a>
        <a
          href="/albums"
          aria-current={active === "albums" ? "page" : undefined}
        >
          相册
        </a>
        {LATER.map((label) => (
          <button key={label} type="button" disabled>
            {label}
          </button>
        ))}
      </nav>
      <main className="gallery-main">{children}</main>
      <aside className="gallery-aside" aria-label="辅助信息">
        {aside ?? <p className="gallery-aside-note">这里会显示辅助信息。</p>}
      </aside>
    </div>
  );
}
