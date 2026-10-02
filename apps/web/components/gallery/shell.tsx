import type { ReactNode } from "react";

const LATER = ["回忆", "地图", "收藏", "家庭成员", "管理后台"] as const;

export function GalleryShell({
  familyName,
  active,
  aside,
  children,
}: {
  familyName: string;
  active: "photos" | "albums" | "trash";
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="gallery-shell">
      <nav className="gallery-nav" aria-label="主导航">
        <p className="gallery-family">{familyName}</p>
        <p className="gallery-nav-label">浏览</p>
        <div className="gallery-nav-group">
          <a
            className="gallery-nav-link"
            href="/"
            aria-current={active === "photos" ? "page" : undefined}
          >
            <span aria-hidden="true">◉</span>
            <span>照片</span>
          </a>
          <a
            className="gallery-nav-link"
            href="/albums"
            aria-current={active === "albums" ? "page" : undefined}
          >
            <span aria-hidden="true">▦</span>
            <span>相册</span>
          </a>
          <a
            className="gallery-nav-link"
            href="/trash"
            aria-current={active === "trash" ? "page" : undefined}
          >
            <span aria-hidden="true">♧</span>
            <span>回收站</span>
          </a>
        </div>
        <p className="gallery-nav-label">更多</p>
        <div className="gallery-nav-group">
          {LATER.map((label) => (
            <button key={label} type="button" disabled>
              <span aria-hidden="true">·</span>
              <span>{label}</span>
            </button>
          ))}
        </div>
      </nav>
      <main className="gallery-main">{children}</main>
      <aside className="gallery-aside" aria-label="辅助信息">
        <div className="gallery-aside-stack">
          <section className="gallery-aside-card">
            {aside ?? (
              <p className="gallery-aside-note">这里会显示辅助信息。</p>
            )}
          </section>
          <section
            className="gallery-aside-placeholder"
            aria-label="更多家庭内容"
          >
            <span className="gallery-aside-placeholder-icon" aria-hidden="true">
              ✦
            </span>
            <div>
              <p>更多家庭内容</p>
              <small>新的家庭功能会在这里出现。</small>
            </div>
          </section>
        </div>
      </aside>
    </div>
  );
}
