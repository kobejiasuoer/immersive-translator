import Foundation

/// 关于页「隐私政策」卡文案（对齐 Windows src/views/privacyPolicy.ts，逐字同口径）。
/// 与 Microsoft Store 提交（属性 → 隐私策略文本）保持同一份口径：修改此处时需同步
/// Windows privacyPolicy.ts、docs/privacy-policy.md 与商店提交里的文本，四者保持一致
///（PrivacyPolicyContentTests 会直接对账 Windows 源文件）。
/// 纯常量、无 UI 依赖，便于 XCTest 逐字断言；完全离线，不发任何网络请求。
enum PrivacyPolicyContent {
    /// 更新日期（Windows PRIVACY_POLICY_UPDATED_AT）。
    static let updatedAt = "2026年10月26日"

    /// 导语（Windows PRIVACY_POLICY_INTRO）。
    static let intro = "「沉浸口语」（以下简称“本应用”）是面向语言学习者的桌面应用。我们高度重视你的隐私，说明如下："

    /// 政策的一节：标题 + 正文（Windows PrivacySection）。
    struct Section: Equatable {
        let title: String
        let body: String
    }

    /// 六节正文（Windows PRIVACY_SECTIONS，顺序与文案逐字一致）。
    static let sections: [Section] = [
        Section(
            title: "一、麦克风音频",
            body: "使用口语跟读、发音评测等功能时，本应用会请求麦克风权限以采集音频，仅用于语音识别与发音评测，不用于广告或与本应用功能无关的用途。"
        ),
        Section(
            title: "二、文本内容",
            body: "使用翻译、AI 口语对话等功能时，你所提交的文本会通过加密网络连接发送至我们及第三方 AI 服务提供商（如大语言模型、机器翻译与语音合成服务商）进行处理，以生成学习内容与反馈。"
        ),
        Section(
            title: "三、屏幕截图（OCR）",
            body: "使用截图取词或屏幕翻译功能时，截图仅在本地或本次请求中用于识别文字，处理后即行丢弃。"
        ),
        Section(
            title: "四、本地存储",
            body: "生词本、阅读记录、练习记录与偏好设置默认保存在你的设备本地。仅在你明确开启同步或备份功能时，相关数据才会按你的指示上传。"
        ),
        Section(
            title: "五、账号与订阅",
            body: "如你选择登录账号或购买订阅，我们会按服务需要处理你的邮箱、订单等必要信息，用于提供与保障服务。"
        ),
        Section(
            title: "六、你的权利",
            body: "我们不会出售你的个人信息。你可随时通过卸载应用删除本地数据，或通过下方渠道联系我们删除与账号相关的数据。"
        )
    ]

    /// 联系方式（Windows PRIVACY_CONTACT_TEXT）。与 Windows 一致只作文本展示（可选中复制），不做可点击链接。
    static let contact = "联系我们：https://github.com/kobejiasuoer/immersive-translator/issues"

    /// 卡标题（Windows PrivacyPolicyCard 的 h3）。
    static let cardTitle = "隐私政策"

    /// 卡副标题（Windows PrivacyPolicyCard：`数据怎么收集、怎么使用（更新于 {PRIVACY_POLICY_UPDATED_AT}）`）。
    static var cardSubtitle: String {
        "数据怎么收集、怎么使用（更新于 \(updatedAt)）"
    }
}

/// 隐私政策卡的展开/收起状态（Windows PrivacyPolicyCard 组件内 `useState(false)` 的可测等价物）：
/// 内存态、不落盘；默认收起，按钮文案在「查看完整政策」/「收起」之间翻转。
/// 正文是否渲染由视图按 `isOpen` 条件渲染（收起即整段移除，对齐 Windows `{open && …}`）。
struct PrivacyPolicyDisclosure: Equatable {
    private(set) var isOpen = false

    /// 点按钮翻转（Windows `setOpen(!open)`）。
    mutating func toggle() {
        isOpen.toggle()
    }

    /// 按钮文案：收起态「查看完整政策」，展开态「收起」。
    var actionTitle: String {
        isOpen ? "收起" : "查看完整政策"
    }
}
