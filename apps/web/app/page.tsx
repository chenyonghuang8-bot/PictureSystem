export default function HomePage() {
  return (
    <main className="foundation-shell">
      <section className="foundation-card" aria-labelledby="page-title">
        <span className="eyebrow">Family Album</span>
        <h1 id="page-title">张家的时光</h1>
        <p>温暖、安静、照片优先的家庭相册正在准备中。</p>
        <div className="status" role="status">
          <span aria-hidden="true" />
          Phase 0 foundation ready
        </div>
      </section>
    </main>
  );
}
