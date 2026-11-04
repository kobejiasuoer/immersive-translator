/**
 * 同步与本机保存规则说明（proto-parity-2026-11-01，对照原型 SHEETS.syncRule html:2019）：
 * 抽屉头「记录保存在什么地方？」+ 右上 × + 分隔线；四节平铺列表（线性图标 + 加粗标题 +
 * 描述，无卡片边框）；底部整宽 primary「明白了」。四节文案逐条对照 services/sync.ts 实际行为，
 * 不夸大——
 * · 未登录不同步：startSync 对无账号直接 return（sync.ts schedule/local 分支）；
 * · 同步集合仅七类 COLLECTIONS，录音原声经 withoutAudio 剥离、仅在录制设备保存；
 * · settings（朗读音色/提醒时间等）与系统权限不在任何同步集合里，按设备生效；
 * · 离线错误进 offline 相位、联网 online 事件重排；双端同改按 updatedAt 合并，
 *   不可变内容冲突抛错保留本机记录（applyRemote）。
 * 图标沿用原型：phone / sync / lock / info。
 */
import { SheetShell } from "./SheetShell";
import { Icon } from "../../ui/icons";

const RULES: { title: string; body: string; icon: string }[] = [
  { title: "本机试用", body: "不登录也能读文章、收藏生词、做练习和复习。这些记录保存在这台手机的本地存储里，删除应用即一并清除。", icon: "phone" },
  { title: "登录后跟账号走", body: "登录后，文章、生词、笔记、练习与复习记录、翻译历史和术语表会同步到账号云端，换设备登录同一账号即可接续。录音原声不参与跨设备同步；使用语音识别或发音评测时，会通过加密连接提交处理。", icon: "sync" },
  { title: "这台设备自己决定", body: "朗读音色、麦克风授权与提醒权限由这台手机管理，不覆盖电脑的权限。", icon: "lock" },
  { title: "离线与同一篇文章", body: "离线时的改动先保存在本机，联网后自动补同步。同一篇文章在两台设备都有改动时按更新时间合并；遇到无法自动合并的冲突会提示你，本机记录不会被删除。", icon: "info" },
];

export function SyncRulesSheet({ onClose }: { onClose: () => void }) {
  return <SheetShell label="同步与本机保存" title="记录保存在什么地方？" onClose={onClose}>
    {RULES.map(section => (
      <section className="v2-policy-section" key={section.title}>
        <h3><Icon name={section.icon} size={16} />{section.title}</h3>
        <p>{section.body}</p>
      </section>
    ))}
    <button className="btn" onClick={onClose}>明白了</button>
  </SheetShell>;
}
