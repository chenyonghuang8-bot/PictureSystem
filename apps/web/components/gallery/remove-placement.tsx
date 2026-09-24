"use client";

export function RemovePlacement({
  confirming,
  message,
  onAsk,
  onConfirm,
  onCancel,
}: {
  confirming: boolean;
  message: string;
  onAsk: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!confirming) {
    return (
      <button type="button" className="gallery-quiet-button" onClick={onAsk}>
        从相册移除
      </button>
    );
  }
  return (
    <section className="gallery-confirm" aria-label="从相册移除">
      <h2>从相册移除</h2>
      <p>照片会留在家庭中，其他相册不受影响。</p>
      {message ? <p>{message}</p> : null}
      <div>
        <button type="button" onClick={onConfirm}>
          从相册移除
        </button>
        <button type="button" onClick={onCancel}>
          取消
        </button>
      </div>
    </section>
  );
}
