import type { ReactNode } from "react";
import { MobileUploadPanel } from "../mobile/upload-panel.js";

const LATER = ["地图", "收藏", "家庭成员", "管理后台"] as const;

export function GalleryShell({
  familyName,
  userId,
  familyId,
  active,
  aside,
  children,
}: {
  familyName: string;
  userId?: string;
  familyId?: string;
  active: "photos" | "albums" | "trash" | "memories" | "my";
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
            className="gallery-nav-link desktop-trash"
            href="/trash"
            aria-current={active === "trash" ? "page" : undefined}
          >
            <span aria-hidden="true">♧</span>
            <span>回收站</span>
          </a>
          <a
            className="gallery-nav-link"
            href="/memories"
            aria-current={active === "memories" ? "page" : undefined}
          >
            <span aria-hidden="true">✦</span>
            <span>回忆</span>
          </a>
        </div>
        <a
          className="gallery-nav-link mobile-my"
          href="/my"
          aria-current={active === "my" ? "page" : undefined}
        >
          <span aria-hidden="true">◉</span>
          <span>我的</span>
        </a>
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
      <main className="gallery-main">
        {children}
        {userId && familyId ? (
          <MobileUploadPanel
            key={`${userId}:${familyId}`}
            userId={userId}
            familyId={familyId}
          />
        ) : null}
      </main>
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
