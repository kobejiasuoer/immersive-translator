/**
 * 隐私与服务协议两版精简说明抽屉（account-onboarding-parity）。
 * 事实源：docs/privacy-policy.md（章节：一、麦克风音频；二、文本内容；三、屏幕截图（OCR）；
 * 四、本地存储；五、账号与订阅；六、你的权利；联系我们），完整承诺以《隐私政策》为准，
 * 本抽屉为原型口径的精简说明、不新增任何承诺。
 * privacy 版四节映射：「本机试用」←四、「登录与同步」←五+四、「录音与通知」←一、「你导入的内容」←二。
 * service 版四节映射：「你的学习内容」←二、「你的账号」←五、「自主安排学习」←二用途+六、「需要帮助时」←联系我们。
 * proto-parity-2026-11-01（对照原型 SHEETS.agreement html:2004-2018）：无卡片纯文本分节
 * （v2-policy-section，节距压缩），「我已了解」主按钮随内容一屏可见；复检 2026-11-02：
 * 四节正文逐字对齐原型简版（原型 privacy rows html:2005-2009），页脚「以上四节分别依据…/
 * 联系我们」为原型外元素已移除，逐节《隐私政策》溯源仅保留在本注释。
 */
import { SheetShell } from "./SheetShell";

const PRIVACY_BRIEF: { title: string; body: string }[] = [
  { title: "本机试用", body: "未登录时，阅读位置、收藏、练习和笔记保存在这台手机。清除浏览器数据或卸载前，请先登录保存或导出。" },
  { title: "登录与同步", body: "登录后可将本机记录并入账号，已有收藏与阅读位置会保留。离线产生的记录先留在本机，联网后继续同步。" },
  { title: "录音与通知", body: "麦克风用于你主动开始的录音练习，识别或评分时音频经加密连接提交处理。拒绝授权后仍能阅读、听示范。学习提醒由你选择开启，也能随时关闭。" },
  { title: "你导入的内容", body: "请只导入你有权使用的内容；导入前可以查看标题与正文，取消不会加入书架。" },
];

const SERVICE_BRIEF: { title: string; body: string }[] = [
  { title: "你的学习内容", body: "你提交的文本仅用于生成翻译、讲解与口语反馈等学习内容，经加密网络连接发送至我们及第三方 AI 服务提供商处理。" },
  { title: "你的账号", body: "登录或购买订阅时，我们按服务需要处理邮箱、订单等必要信息，用于提供与保障服务。" },
  { title: "自主安排学习", body: "学习内容与反馈按你的实际使用生成，我们不出售你的个人信息；你可卸载应用删除本地数据，或联系我们删除账号相关数据。" },
  { title: "需要帮助时", body: "通过 GitHub Issues 联系我们，问题与账号相关数据可按你的要求处理。" },
];

function BriefSheet({ label, heading, sections, onClose }: {
  label: string; heading: string;
  sections: { title: string; body: string }[];
  onClose: () => void;
}) {
  return <SheetShell label={label} title={heading} sub="先了解记录与授权，再决定如何使用。" onClose={onClose}>
    {sections.map(section => (
      <section className="v2-policy-section" key={section.title}>
        <h3>{section.title}</h3>
        <p>{section.body}</p>
      </section>
    ))}
    <button className="btn" onClick={onClose}>我已了解</button>
  </SheetShell>;
}

export function PrivacySheet({ onClose }: { onClose: () => void }) {
  return <BriefSheet
    label="隐私与本机保存说明"
    heading="隐私与本机保存说明"
    sections={PRIVACY_BRIEF}
    onClose={onClose} />;
}

export function ServiceSheet({ onClose }: { onClose: () => void }) {
  return <BriefSheet
    label="服务协议要点"
    heading="服务协议要点"
    sections={SERVICE_BRIEF}
    onClose={onClose} />;
}
