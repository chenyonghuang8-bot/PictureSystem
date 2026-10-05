import { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import type { MemoriesKind } from "../../packages/contracts/src/index.js";
import { Memories } from "../../apps/web/components/gallery/memories.js";
function Host() {
  const [actor, setActor] = useState("7"),
    [family, setFamily] = useState("4");
  const read = () =>
    new URLSearchParams(location.search).get("kind") as MemoriesKind | null;
  const [kind, setKind] = useState(read());
  useEffect(() => {
    const pop = () => setKind(read());
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  return (
    <>
      <button onClick={() => setActor("8")}>切换账号</button>
      <button onClick={() => setFamily("5")}>切换家庭</button>
      <button
        onClick={() => window.dispatchEvent(new Event("family-auth-lost"))}
      >
        退出测试账号
      </button>
      <button
        onClick={() => {
          history.pushState(null, "", "/?kind=LAST_YEAR_WEEK");
          setKind("LAST_YEAR_WEEK");
        }}
      >
        切换回忆类型
      </button>
      <Memories userId={actor} familyId={family} {...(kind ? { kind } : {})} />
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Host />);
