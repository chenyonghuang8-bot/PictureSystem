export function HomeHeader({
  familyName,
  displayName,
}: {
  familyName: string;
  displayName: string;
}) {
  return (
    <header className="gallery-home-header">
      <div>
        <p className="gallery-eyebrow">家庭照片</p>
        <h1 className="gallery-home-title">{familyName}</h1>
        <p className="gallery-home-subtitle">记录一起度过的每个季节</p>
      </div>
      <div className="gallery-member-area" aria-label="当前成员">
        <span className="gallery-avatar" aria-hidden="true">
          {displayName.slice(0, 1).toUpperCase()}
        </span>
        <span className="gallery-avatar-placeholder" aria-hidden="true" />
        <span className="gallery-member-name">{displayName}</span>
      </div>
    </header>
  );
}
