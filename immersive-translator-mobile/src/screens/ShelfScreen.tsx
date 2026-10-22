/**
 * 书架（Tab 3）—— §3.3：文章列表（进度墨线 + 断点）、导入四路、
 * 左滑删除（撤销 toast 5s）、在读书置顶「继续读」。
 */
import { actions, useApp } from "../store";
import { Icon } from "../ui/icons";
import { Meter, SwipeRow } from "../ui/kit";
import { useNav } from "../ui/nav";
import type { Article } from "../core/types";

export default function ShelfScreen() {
  const nav = useNav();
  const articles = useApp((s) => s.articles);
  const progress = useApp((s) => s.progress);

  /* 「继续读」钉标：已开始（progress 已写入）且未读完的集合里取进度最深的一篇，
     读完文不再参与竞争（修 P-28：置顶篇 100% 后钉标整体消失） */
  const pinId = [...articles]
    .filter((a) => {
      const s = progress[a.id];
      return s !== undefined && s < a.sentences.length - 1;
    })
    .sort((a, b) => (progress[b.id] ?? 0) - (progress[a.id] ?? 0))[0]?.id;

  /* 钉标文真正置顶（治 home-7）：此前只按 progress 句索引降序——读完的长文（len-1）
     压过钉标文排最前，且跨文章句索引不可比（长书 50/200 句排在短文 8/10 前），
     与文件头「在读书置顶」注释不符 */
  const sorted = [...articles].sort(
    (a, b) => Number(b.id === pinId) - Number(a.id === pinId) || (progress[b.id] ?? 0) - (progress[a.id] ?? 0),
  );

  return (
    <div>
      <button className="iconbtn plus-nav" aria-label="导入文章" onClick={() => actions.setSheet({ kind: "import", tab: "lib" })}>
        <Icon name="plus" size={20} />
      </button>
      <div className="h1" style={{ paddingRight: 56 }}>
        书架
      </div>
      {articles.length === 0 && (
        <div style={{ textAlign: "center", padding: "90px 20px 0" }}>
          <div className="serif" style={{ fontSize: 22, fontWeight: 600, lineHeight: "32px" }}>
            先把一篇东西放进书架
          </div>
          <div className="meta" style={{ marginTop: 8 }}>
            文库、粘贴、链接、文件，四条路都通向这里
          </div>
          <button
            className="btn"
            style={{ marginTop: 20 }}
            onClick={() => actions.setSheet({ kind: "import", tab: "lib" })}
          >
            <Icon name="plus" size={16} />
            导入文章
          </button>
        </div>
      )}
      <div style={{ marginTop: 4 }}>
        {sorted.map((a: Article) => {
          /* progress 未写入 = 未开始：不按 0（=第 1 句）参与计算，墨线 0%、文案「未开始」（修 P-26） */
          const raw = progress[a.id];
          const sent = raw ?? 0;
          const pct = raw === undefined ? 0 : Math.round(((sent + 1) / a.sentences.length) * 100);
          const isReading = a.id === pinId;
          return (
            <SwipeRow key={a.id} onDelete={() => actions.deleteArticle(a.id)}>
              {/* U-01：行主体可点 → button（width:100% + text-align:left） */}
              <button style={{ width: "100%", textAlign: "left" }} onClick={() => nav.push("reader", { articleId: a.id })}>
                {isReading && <div className="pin">继续读</div>}
                <div className="art-title" style={{ marginTop: isReading ? 6 : 0 }}>
                  {a.title}
                </div>
                <div className="meta">
                  {a.titleCn} · {a.sentences.length} 句 ·{" "}
                  {raw === undefined ? "未开始" : pct >= 100 ? "已读完" : `读到第 ${sent + 1} 句`}
                </div>
                <Meter pct={pct} />
              </button>
            </SwipeRow>
          );
        })}
      </div>
      {articles.length > 0 && (
        <div className="meta" style={{ margin: "14px 0 24px" }}>
          左滑一篇文章可以删除，5 秒内可撤销。
        </div>
      )}
    </div>
  );
}
