export function SignedOut() {
  return (
    <section className="gallery-state" role="status">
      <h1>需要登录</h1>
      <p>登录后才能查看家庭相册。</p>
    </section>
  );
}

export function EmptyPhotos() {
  return (
    <section className="gallery-state" role="status">
      <h1>还没有照片</h1>
      <p>可以查看的照片会显示在这里。</p>
    </section>
  );
}

export function EmptyAlbums() {
  return (
    <section className="gallery-state" role="status">
      <h1>还没有相册</h1>
      <p>可以查看的相册会显示在这里。</p>
    </section>
  );
}

export function NotFoundState() {
  return (
    <section className="gallery-state" role="status">
      <h1>没有找到</h1>
      <p>这个内容不存在，或者当前账号不能查看。</p>
    </section>
  );
}

export function UnavailableState() {
  return (
    <section className="gallery-state" role="status">
      <h1>暂时无法加载</h1>
      <p>请稍后再试。</p>
      <a className="gallery-text-button" href="">
        再试一次
      </a>
    </section>
  );
}

export function PhotoPlaceholder() {
  return <span className="gallery-placeholder" aria-hidden="true" />;
}
