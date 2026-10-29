// 隐私政策文案：与 Microsoft Store 提交（属性 → 隐私策略文本）保持同一份口径。
// 修改此处时需同步 docs/privacy-policy.md 与商店提交里的文本，三者保持一致。
export const PRIVACY_POLICY_UPDATED_AT = "2026年10月26日";

export const PRIVACY_POLICY_INTRO =
  "「沉浸口语」（以下简称“本应用”）是面向语言学习者的桌面应用。我们高度重视你的隐私，说明如下：";

export interface PrivacySection {
  title: string;
  body: string;
}

export const PRIVACY_SECTIONS: PrivacySection[] = [
  {
    title: "一、麦克风音频",
    body: "使用口语跟读、发音评测等功能时，本应用会请求麦克风权限以采集音频，仅用于语音识别与发音评测，不用于广告或与本应用功能无关的用途。",
  },
  {
    title: "二、文本内容",
    body: "使用翻译、AI 口语对话等功能时，你所提交的文本会通过加密网络连接发送至我们及第三方 AI 服务提供商（如大语言模型、机器翻译与语音合成服务商）进行处理，以生成学习内容与反馈。",
  },
  {
    title: "三、屏幕截图（OCR）",
    body: "使用截图取词或屏幕翻译功能时，截图仅在本地或本次请求中用于识别文字，处理后即行丢弃。",
  },
  {
    title: "四、本地存储",
    body: "生词本、阅读记录、练习记录与偏好设置默认保存在你的设备本地。仅在你明确开启同步或备份功能时，相关数据才会按你的指示上传。",
  },
  {
    title: "五、账号与订阅",
    body: "如你选择登录账号或购买订阅，我们会按服务需要处理你的邮箱、订单等必要信息，用于提供与保障服务。",
  },
  {
    title: "六、你的权利",
    body: "我们不会出售你的个人信息。你可随时通过卸载应用删除本地数据，或通过下方渠道联系我们删除与账号相关的数据。",
  },
];

export const PRIVACY_CONTACT_TEXT =
  "联系我们：https://github.com/kobejiasuoer/immersive-translator/issues";
