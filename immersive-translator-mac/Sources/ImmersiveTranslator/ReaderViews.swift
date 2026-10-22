import SwiftUI
import UniformTypeIdentifiers
import ReaderCore
import XfyunCore

// MARK: - 主题环境

private struct ReaderPaletteKey: EnvironmentKey {
    static let defaultValue: ReaderPalette = .palette(for: .light)
}

extension EnvironmentValues {
    var readerPalette: ReaderPalette {
        get { self[ReaderPaletteKey.self] }
        set { self[ReaderPaletteKey.self] = newValue }
    }
}

// MARK: - 根视图

/// 阅读室根（ReaderApp.tsx 的 .reader-root）：双光晕画布 + 顶部悬浮导航舞台 +
/// 路由主体（书架首页 / 阅读 / 口语 / 复习 / 笔记）+ 播放条；书架浮层挂在根顶层。
struct ReaderRootView: View {
    @ObservedObject var vm: ReaderViewModel

    var body: some View {
        let settings = vm.effectiveSettings
        let palette = ReaderPalette.palette(for: settings.theme)
        // M-02：播放条不再占 VStack 通栏——改为底部悬浮胶囊（overlay），
        // 正文从胶囊两侧滚过（ReaderScroll 底部 84pt 安全留白）。
        let dockVisible = vm.route == .reading && !settings.zenMode
        // 短文结课条在场（与 ReadingStageView 的显示条件同源）时胶囊抬高避让。
        let finishBarVisible = vm.article != nil && vm.finishCard?.articleId == vm.article?.id
        ZStack(alignment: .topLeading) {
            VStack(spacing: 0) {
                ReaderTopStageView(vm: vm)
                if vm.route == .reading, settings.showProgress, let article = vm.article, !settings.zenMode {
                    InkProgressBar(percent: article.progress.percent)
                }
                ReaderBodyView(vm: vm)
            }
            // 书架浮层（原型 .floating-folio-sheet：top 66 / left 28 / 310 宽 / 18 圆角）。
            // 挡板只盖顶栏以下区域：外点收起，而顶栏上的导航岛 / 控制胶囊仍可直接点
            //（它们各自的动作都会顺手收起浮层，和 Windows「mousedown 关 + click 导航」等效）。
            if vm.folioOpen {
                FolioDismissScrim(topInset: ReaderTopStageView.height) { vm.closeFolio() }
                    .zIndex(40)
                FolioSheetView(vm: vm)
                    .padding(.top, ReaderTopStageView.height + 2)
                    .padding(.leading, 28)
                    .transition(
                        .opacity
                            .combined(with: .offset(y: -8))
                            .combined(with: .scale(scale: 0.98, anchor: .topLeading))
                    )
                    .zIndex(45)
            }
        }
        .animation(ReaderMotion.folio, value: vm.folioOpen)
        .background(ReaderCanvasBackground(palette: palette))
        .overlay(alignment: .bottom) {
            // 底部悬浮走带胶囊（原型 .floating-sonic-dock：bottom 18 / 居中 / 999 圆角
            // 玻璃 + blur(24) + shadow-spatial + 顶内高光）；正文收尾条在场时抬高避让。
            if dockVisible {
                PlayBarView(vm: vm)
                    .padding(.bottom, finishBarVisible ? 68 : 18)
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
        }
        .animation(ReaderMotion.folio, value: dockVisible)
        .overlay(alignment: .bottom) {
            if vm.route == .reading, settings.zenMode {
                ZenControlsView(vm: vm).padding(.bottom, 20)
            }
        }
        .environment(\.readerPalette, palette)
        .environment(\.colorScheme, palette.colorScheme)
        .sheet(isPresented: $vm.importSheetShown) {
            ReaderImportSheet(vm: vm)
        }
        .sheet(isPresented: $vm.noteDialogShown) {
            ReaderNoteDialogView(vm: vm)
        }
        .overlay {
            if vm.settingsDrawerShown {
                ReaderSettingsDrawer(vm: vm)
            }
        }
        .overlay {
            if vm.bookTocShown, let book = vm.tocBook {
                BookTocView(vm: vm, book: book)
            }
        }
        .overlay {
            if let chapterEnd = vm.chapterEnd {
                ChapterEndCardView(vm: vm, summary: chapterEnd)
            }
        }
        // 跟读报告卡（failed 相位浮在 PlayBar 上方）与差词抽屉（遮罩盖住 PlayBar）：
        // 均 wrapper 直观察控制器（ShadowReportOverlay / ShadowDrillOverlay），
        // 不依赖 vm 重渲；抽屉在报告卡之上。
        .overlay(alignment: .bottom) {
            ShadowReportOverlay(vm: vm)
        }
        .overlay {
            ShadowDrillOverlay(vm: vm)
        }
        // toast 置顶：差词抽屉的提示（没听到声音/未配置凭据…）不能被抽屉 sheet 盖住
        .overlay(alignment: .bottom) {
            if !vm.toast.isEmpty {
                ReaderToast(text: vm.toast, action: vm.toastAction)
                    // 悬浮走带在场时 toast 再抬 28pt（自带 56）→ 落在胶囊上方不叠压。
                    .padding(.bottom, dockVisible ? 28 : 0)
            }
        }
        .onChange(of: vm.activeSentenceIdx) { idx in
            vm.noteReadProgress(idx: idx)
        }
    }
}

/// 全画布：同色系底 + 双极柔和径向光晕（原型 .spatial-universe / reader.css:6302），
/// 换肤 350ms 弹性过渡——底色与光晕一起渐变，不闪白。
private struct ReaderCanvasBackground: View {
    let palette: ReaderPalette

    var body: some View {
        GeometryReader { geo in
            let radius = max(geo.size.width, geo.size.height) * 0.48
            ZStack {
                palette.background
                RadialGradient(
                    colors: [palette.aura1, .clear],
                    center: UnitPoint(x: 0.14, y: 0.18),
                    startRadius: 0,
                    endRadius: radius
                )
                RadialGradient(
                    colors: [palette.aura2, .clear],
                    center: UnitPoint(x: 0.86, y: 0.82),
                    startRadius: 0,
                    endRadius: radius * 1.08
                )
            }
        }
        .ignoresSafeArea()
        .animation(ReaderMotion.skin, value: palette.theme)
    }
}

/// 书架浮层的外点挡板：顶栏以下全透明一层，点到即收（触发胶囊在顶栏，不在挡板里）。
private struct FolioDismissScrim: View {
    let topInset: CGFloat
    let onDismiss: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            Color.clear.frame(height: topInset).allowsHitTesting(false)
            Color.black.opacity(0.001)
                .contentShape(Rectangle())
                .onTapGesture(perform: onDismiss)
        }
        .ignoresSafeArea()
    }
}

// MARK: - 顶部悬浮导航舞台（v0.8 Phase 1，对齐 ReaderTopBar.tsx / reader.css:6313-6464）

/// 三胶囊舞台：左 brand-folio-pill（monogram「I」回书架 + 「书架 · 当前面名」浮层触发器）·
/// 中 center-nav-island（阅读 / 口语 / 笔记与复习，vault 档角标 = 到期 + 未整理）·
/// 右 right-controls-island（全文检索 / 主题循环 / 阅读设置）。
struct ReaderTopStageView: View {
    @ObservedObject var vm: ReaderViewModel
    /// 舞台固定高度：上 14 + 胶囊 40 + 下 10（书架浮层 top:66 以此对位）。
    static let height: CGFloat = 64

    @State private var searchActive = false
    @State private var searchText = ""
    @FocusState private var searchFocused: Bool
    @Namespace private var islandNamespace

    var body: some View {
        let palette = ReaderPalette.palette(for: vm.effectiveSettings.theme)
        HStack(spacing: 16) {
            brandPill(palette)
            Spacer(minLength: 8)
            navIsland(palette)
            Spacer(minLength: 8)
            rightIsland(palette)
        }
        // M-01：fullSizeContentView 后交通灯叠在画布左上（约占 x 0…70），
        // 左胶囊 leading 留出 ~78pt 让位，三胶囊与交通灯同处一条顶带。
        .padding(.leading, 78)
        .padding(.trailing, 28)
        .padding(.top, 14)
        .padding(.bottom, 10)
        .frame(height: Self.height)
        .frame(maxWidth: .infinity)
        .contentShape(Rectangle())
        // 舞台空白处点一下也收浮层（按钮自己的手势优先，不受影响）。
        .onTapGesture {
            if vm.folioOpen { vm.closeFolio() }
        }
        .zIndex(30)
    }

    // MARK: 左：品牌书卷胶囊

    private func brandPill(_ palette: ReaderPalette) -> some View {
        HStack(spacing: 10) {
            Button {
                vm.openShelf()
            } label: {
                Text("I")
                    .font(readerDisplayFont(17))
                    .italic()
                    .foregroundColor(palette.onInk)
                    .frame(width: 28, height: 28)
                    .background(Circle().fill(palette.text))
            }
            .buttonStyle(.plain)
            .help("回到书架")
            .accessibilityLabel("回到书架")

            FolioTriggerButton(
                title: vm.folioTriggerLabel,
                open: vm.folioOpen,
                palette: palette
            ) {
                vm.toggleFolio()
            }
        }
        .padding(.leading, 6)
        .padding(.trailing, 12)
        .padding(.vertical, 5)
        .modifier(GlassPillStyle(palette: palette))
    }

    // MARK: 中：毛玻璃导航岛

    private func navIsland(_ palette: ReaderPalette) -> some View {
        HStack(spacing: 4) {
            IslandTabButton(
                surface: .reading, icon: ReaderIcons.navReading, badge: 0,
                active: vm.islandSurface == .reading, palette: palette, namespace: islandNamespace,
                help: "阅读：书架首页与当前文章"
            ) { vm.navigate(to: .reading) }
            IslandTabButton(
                surface: .speak, icon: ReaderIcons.navSpeak, badge: 0,
                active: vm.islandSurface == .speak, palette: palette, namespace: islandNamespace,
                help: "口语陪练：场景对话开口说"
            ) { vm.navigate(to: .speak) }
            IslandTabButton(
                surface: .vault, icon: ReaderIcons.navVault, badge: vm.vaultBadge,
                active: vm.islandSurface == .vault, palette: palette, namespace: islandNamespace,
                help: "生词复习与笔记都在这一档（角标 = 到期 + 未整理）"
            ) { vm.navigate(to: .vault) }
        }
        .padding(4)
        .modifier(GlassPillStyle(palette: palette))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("主导航")
    }

    // MARK: 右：控制胶囊

    private func rightIsland(_ palette: ReaderPalette) -> some View {
        HStack(spacing: 6) {
            if searchActive {
                TextField("在本文中检索…", text: $searchText)
                    .textFieldStyle(.plain)
                    .font(.system(size: 11.5))
                    .foregroundColor(palette.text)
                    .focused($searchFocused)
                    .frame(width: 150)
                    .padding(.horizontal, 10)
                    .frame(height: 26)
                    .background(Capsule().fill(palette.glassElevated))
                    .overlay(Capsule().strokeBorder(palette.glassBorderStrong, lineWidth: 1))
                    .onSubmit {
                        let q = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
                        if !q.isEmpty { vm.searchInArticle(q) }
                    }
                    .onExitCommand {
                        searchActive = false
                        searchText = ""
                    }
                    .transition(.opacity.combined(with: .move(edge: .trailing)))
            }
            GhostPillButton(icon: ReaderIcons.search, active: searchActive, palette: palette, help: "全文检索（Enter 跳转，Esc 关闭）") {
                vm.closeFolio()
                withAnimation(ReaderMotion.hover) { searchActive.toggle() }
                if searchActive { searchFocused = true } else { searchText = "" }
            }
            GhostPillButton(
                text: "主题：\(vm.effectiveSettings.theme.label)",
                palette: palette,
                help: "主题：\(vm.effectiveSettings.theme.label)（点击切换：纸书 → 深色 → 护眼 → 纯黑）"
            ) {
                vm.closeFolio()
                // 350ms 弹性换肤：整棵视图树里颜色一起渐变（原型 --ease-spring）。
                withAnimation(ReaderMotion.skin) {
                    vm.patchSettings { $0.theme = $0.theme.next }
                }
            }
            GhostPillButton(icon: ReaderIcons.gear, active: vm.settingsDrawerShown, palette: palette, help: "阅读设置") {
                vm.closeFolio()
                vm.settingsDrawerShown = true
            }
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 4)
        .modifier(GlassPillStyle(palette: palette))
    }
}

/// 毛玻璃胶囊（.brand-folio-pill / .center-nav-island / .right-controls-island 共用）：
/// 玻璃底色 + 系统材质 + 发丝边 + 顶部内高光 + 双层投影（--shadow-pill）。
private struct GlassPillStyle: ViewModifier {
    let palette: ReaderPalette

    func body(content: Content) -> some View {
        content
            .background(
                Capsule()
                    .fill(palette.glassPill)
                    .background(.ultraThinMaterial, in: Capsule())
            )
            .overlay(
                Capsule()
                    .strokeBorder(palette.glassBorder, lineWidth: 1)
            )
            .overlay(
                // inset 0 1px 0 glass-highlight：顶部一道受光高光
                Capsule()
                    .strokeBorder(
                        LinearGradient(
                            colors: [palette.glassHighlight, .clear],
                            startPoint: .top, endPoint: .center
                        ),
                        lineWidth: 1
                    )
                    .padding(1)
            )
            .shadow(color: palette.shadowPill, radius: 16, y: 8)
            .shadow(color: palette.shadowPill.opacity(0.5), radius: 4, y: 2)
    }
}

/// 毛玻璃卡片（原型 .scenario-card / .harmonic-stage-card / .notebook-sheet-card /
/// .challenge-stage-box / .dialogue-turn.mine / .recent-session-row 共用的材质阶梯）：
/// 玻璃底色 + 系统材质 + 发丝边 + 顶部内高光 + 投影（pill 轻 / spatial 重）。
/// 圆角阶梯沿用原型：22 手账大卡 / 20 场景与声波舞台 / 18 用户气泡 / 14 recent 行。
struct GlassCardStyle: ViewModifier {
    let palette: ReaderPalette
    var radius: CGFloat = 20
    /// true = glass-elevated（浮起面板：用户气泡 / 悬停场景卡 / 挑战大卡）。
    var elevated: Bool = false
    /// true = --shadow-spatial（大表面），false = --shadow-pill（小卡片）。
    var heavyShadow: Bool = false
    /// 边线覆写（hover 加深等场景）；nil = glass-border-strong。
    var borderColor: Color? = nil

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        return content
            .background(
                shape
                    .fill(elevated ? palette.glassElevated : palette.glassSurface)
                    .background(.regularMaterial, in: shape)
            )
            .overlay(shape.strokeBorder(borderColor ?? palette.glassBorderStrong, lineWidth: 1))
            .overlay(
                // inset 0 1px 0 glass-highlight：顶部一道受光高光
                RoundedRectangle(cornerRadius: max(1, radius - 1), style: .continuous)
                    .strokeBorder(
                        LinearGradient(
                            colors: [palette.glassHighlight, .clear],
                            startPoint: .top, endPoint: .center
                        ),
                        lineWidth: 1
                    )
                    .padding(1)
            )
            .shadow(
                color: heavyShadow ? palette.shadowSpatial : palette.shadowPill,
                radius: heavyShadow ? 18 : 12,
                y: heavyShadow ? 8 : 5
            )
    }
}

extension View {
    /// 套用毛玻璃卡片材质（GlassCardStyle 的便捷入口）。
    func glassCard(
        palette: ReaderPalette,
        radius: CGFloat = 20,
        elevated: Bool = false,
        heavyShadow: Bool = false
    ) -> some View {
        modifier(GlassCardStyle(palette: palette, radius: radius, elevated: elevated, heavyShadow: heavyShadow))
    }
}

/// 「书架 · 当前书名」浮层触发器（.folio-drawer-trigger）。
private struct FolioTriggerButton: View {
    let title: String
    let open: Bool
    let palette: ReaderPalette
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 7) {
                Image(systemName: ReaderIcons.folio)
                    .font(.system(size: 12, weight: .medium))
                Text(title)
                    .font(.system(size: 12.5, weight: .semibold))
                    .lineLimit(1)
                    .truncationMode(.tail)
                Image(systemName: ReaderIcons.caret)
                    .font(.system(size: 8.5, weight: .bold))
                    .opacity(0.45)
                    .rotationEffect(.degrees(open ? 180 : 0))
            }
            .foregroundColor(palette.text)
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .background(
                Capsule().fill(hover || open ? palette.glassBorder : Color.clear)
            )
            .frame(maxWidth: 320)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .onHover { h in
            withAnimation(ReaderMotion.hover) { hover = h }
        }
        .help("打开书架浮层（切换书 / 短文，继续读）")
        .accessibilityLabel(title)
        .accessibilityAddTraits(open ? [.isSelected] : [])
    }
}

/// 导航岛单档（.island-tab）：当前档深色胶囊 + 画布色文字 + 图标；角标走 accent-soft，
/// 激活档角标反转为 accent 实底白字。高亮胶囊在三档之间 200ms 弹性滑移。
private struct IslandTabButton: View {
    let surface: IslandSurface
    let icon: String
    let badge: Int
    let active: Bool
    let palette: ReaderPalette
    let namespace: Namespace.ID
    let help: String
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button {
            withAnimation(ReaderMotion.islandTab) { action() }
        } label: {
            HStack(spacing: 7) {
                Image(systemName: icon)
                    .font(.system(size: 12.5, weight: .medium))
                Text(surface.label)
                    .font(.system(size: 12.5, weight: active ? .semibold : .medium))
                if badge > 0 {
                    Text("\(badge)")
                        .font(.system(size: 10.5, weight: .semibold, design: .monospaced))
                        .monospacedDigit()
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(Capsule().fill(active ? palette.accent : palette.accentSoft))
                        .foregroundColor(active ? .white : palette.accent)
                        .accessibilityLabel("\(badge) 项待处理")
                }
            }
            .foregroundColor(active ? palette.onInk : (hover ? palette.text : palette.textSecondary))
            .padding(.horizontal, 14)
            .frame(height: 32)
            .background {
                if active {
                    Capsule()
                        .fill(palette.text)
                        .shadow(color: Color.black.opacity(0.14), radius: 6, y: 4)
                        .matchedGeometryEffect(id: "island-active", in: namespace)
                }
            }
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .onHover { h in
            withAnimation(ReaderMotion.hover) { hover = h }
        }
        .help(help)
        .accessibilityAddTraits(active ? [.isSelected] : [])
    }
}

/// 右控制胶囊里的幽灵按钮（.pill-Ghost-btn）：悬停玻璃边底 + 墨色；active-lens 态走 accent-soft。
private struct GhostPillButton: View {
    var icon: String? = nil
    var text: String? = nil
    var active: Bool = false
    let palette: ReaderPalette
    let help: String
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                if let icon {
                    Image(systemName: icon).font(.system(size: 12, weight: .medium))
                }
                if let text {
                    Text(text).font(.system(size: 11.5, weight: active ? .semibold : .medium))
                }
            }
            .foregroundColor(active ? palette.accent : (hover ? palette.text : palette.textSecondary))
            .padding(.horizontal, 10)
            .frame(height: 28)
            .background(
                Capsule().fill(active ? palette.accentSoft : (hover ? palette.glassBorder : Color.clear))
            )
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .onHover { h in
            withAnimation(ReaderMotion.hover) { hover = h }
        }
        .help(help)
    }
}

// MARK: - 弹出式书架浮层（v0.8 FolioSheet，对齐 ReaderShelf.tsx / reader.css:6526-6680）

/// 由顶栏左上「书架 · 书名」触发：当前书 hero 卡（书名 / 作者 · 第 N/M 章 · 已读% · 进度条，
/// 点击直达断点章）+ 短文行（标题 / 百分比或「读完」/ 悬停删除）+「＋ 导入文件」。
/// Esc 与外点关闭；选中即收起；删除后保持打开（删除契约：章文章与进度删、生词保留）。
struct FolioSheetView: View {
    @ObservedObject var vm: ReaderViewModel
    @Environment(\.readerPalette) private var palette
    @State private var contentHeight: CGFloat = 0

    /// 浮层内容区最大高度（原型 max-height: calc(100vh - 120px)，窗口最小 620 → 500）。
    private let maxBodyHeight: CGFloat = 500

    private var currentBook: BookMeta? {
        vm.currentBook ?? vm.bookList.first
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("我的书架")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(palette.textTertiary)
                Spacer()
                Button {
                    vm.openImportFromFolio()
                } label: {
                    Text("＋ 导入文件")
                        .font(.system(size: 11.5, weight: .semibold))
                        .foregroundColor(palette.accent)
                        .padding(.horizontal, 10)
                        .frame(height: 24)
                        .background(Capsule().fill(palette.accentSoft))
                }
                .buttonStyle(.plain)
                .help("导入文章 / 整本 EPUB")
            }
            .padding(.bottom, 12)

            ScrollView(showsIndicators: false) {
                VStack(alignment: .leading, spacing: 0) {
                    if let book = currentBook {
                        FolioBookHero(book: book, palette: palette) {
                            vm.openBookAt(bookId: book.id)   // openArticle 内部收起浮层
                        } onDelete: {
                            vm.deleteBook(bookId: book.id)   // 删除后浮层保持打开
                        }
                        .padding(.bottom, 14)
                    }
                    if !vm.articleList.isEmpty {
                        Text("短文")
                            .font(.system(size: 11.5))
                            .foregroundColor(palette.textTertiary)
                            .padding(.bottom, 6)
                        ForEach(vm.articleList) { summary in
                            FolioArticleRow(
                                summary: summary,
                                active: summary.id == vm.article?.id,
                                palette: palette,
                                onSelect: { vm.openArticle(id: summary.id) },
                                onDelete: { vm.deleteArticle(id: summary.id) }
                            )
                        }
                    }
                    if vm.articleList.isEmpty, currentBook == nil {
                        Text("还没有书或短文。点「＋ 导入文件」，或在网页 / 文档里选中文字，按阅读室快捷键送进来（默认 ⌃⇧R，可在设置里改）。")
                            .font(.system(size: 11.5))
                            .lineSpacing(4)
                            .foregroundColor(palette.textTertiary)
                            .padding(.horizontal, 2)
                            .padding(.vertical, 4)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .background(
                    GeometryReader { geo in
                        Color.clear.preference(key: FolioContentHeightKey.self, value: geo.size.height)
                    }
                )
            }
            .onPreferenceChange(FolioContentHeightKey.self) { contentHeight = $0 }
            .frame(height: min(maxBodyHeight, max(1, contentHeight)))
        }
        .padding(18)
        .frame(width: 310)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(palette.glassElevated)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(palette.glassBorderStrong, lineWidth: 1)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(
                    LinearGradient(colors: [palette.glassHighlight, .clear], startPoint: .top, endPoint: .center),
                    lineWidth: 1
                )
                .padding(1)
        )
        // --shadow-spatial：0 20px 50px -12px + 0 4px 14px -2px
        .shadow(color: palette.shadowSpatial, radius: 25, y: 20)
        .shadow(color: palette.shadowSpatial.opacity(0.5), radius: 7, y: 4)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("我的书架")
        .accessibilityAddTraits(.isModal)
    }
}

private struct FolioContentHeightKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

/// 当前书卡（.folio-book-hero）：书名 / 作者 · 第 N/M 章 · 已读% / 进度条；点击直达断点章。
private struct FolioBookHero: View {
    let book: BookMeta
    let palette: ReaderPalette
    let onContinue: () -> Void
    let onDelete: () -> Void
    @State private var hover = false

    var body: some View {
        let chapterIdx = bookChapterIndexOf(book: book, chapterId: book.progress.chapterId)
        let percent = Int(bookOverallPercent(book: book).rounded())
        VStack(alignment: .leading, spacing: 0) {
            Text(book.title)
                .font(readerDisplayFont(22))
                .foregroundColor(palette.text)
                .lineLimit(1)
                .truncationMode(.tail)
                .help(book.title)
            Text("\(book.author.map { "\($0) · " } ?? "")第 \(min(chapterIdx + 1, book.chapters.count))/\(book.chapters.count) 章 · 已读 \(percent)%")
                .font(.system(size: 12))
                .monospacedDigit()
                .foregroundColor(palette.textTertiary)
                .padding(.top, 4)
                .padding(.bottom, 10)
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(palette.glassBorderStrong)
                    Capsule()
                        .fill(palette.accent)
                        .frame(width: max(0, geo.size.width * CGFloat(percent) / 100))
                        .animation(.easeOut(duration: 0.4), value: percent)
                }
            }
            .frame(height: 3)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(palette.background))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(hover ? palette.glassBorderStrong : palette.glassBorder, lineWidth: 1)
        )
        .overlay(alignment: .topTrailing) {
            if hover {
                FolioDeleteButton(palette: palette, help: "删除这本书（章文章与进度删除，生词保留）") {
                    confirmDelete()
                }
                .padding(8)
            }
        }
        .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .onTapGesture(perform: onContinue)
        .onHover { h in
            withAnimation(ReaderMotion.hover) { hover = h }
        }
        .help("继续读：打开这本书的断点章")
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
    }

    private func confirmDelete() {
        let alert = NSAlert()
        alert.messageText = "删除《\(book.title)》？"
        alert.informativeText = "将删除全部 \(book.chapters.count) 章内容与这本书的阅读进度，不可恢复；生词本不受影响。"
        alert.alertStyle = .warning
        alert.addButton(withTitle: "删除")
        alert.addButton(withTitle: "取消")
        if alert.runModal() == .alertFirstButtonReturn {
            onDelete()
        }
    }
}

/// 短文行（.folio-article-row）：标题（衬线）+ 百分比 / 读完（声波青）+ 悬停删除。
private struct FolioArticleRow: View {
    let summary: ArticleSummary
    let active: Bool
    let palette: ReaderPalette
    let onSelect: () -> Void
    let onDelete: () -> Void
    @State private var hover = false

    var body: some View {
        let pct = Int(summary.article.progress.percent.rounded())
        let done = pct >= 100
        HStack(spacing: 8) {
            Text(summary.article.title)
                .font(.system(size: 12.5, design: .serif))
                .foregroundColor(palette.text)
                .lineLimit(1)
                .truncationMode(.tail)
                .help(summary.article.title)
            Spacer(minLength: 0)
            Text(done ? "读完" : "\(pct)%")
                .font(.system(size: 12.5))
                .monospacedDigit()
                .foregroundColor(done ? palette.sonicTeal : palette.textTertiary)
            if hover {
                FolioDeleteButton(palette: palette, help: "删除文章（生词本不受影响）") {
                    confirmDelete()
                }
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 7)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(active ? palette.accentSoft : (hover ? palette.glassBorder : Color.clear))
        )
        .contentShape(Rectangle())
        .onTapGesture(perform: onSelect)
        .onHover { h in
            withAnimation(ReaderMotion.hover) { hover = h }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(active ? [.isButton, .isSelected] : [.isButton])
    }

    private func confirmDelete() {
        let alert = NSAlert()
        alert.messageText = "删除《\(summary.article.title)》？"
        alert.informativeText = "生词本不受影响。"
        alert.alertStyle = .warning
        alert.addButton(withTitle: "删除")
        alert.addButton(withTitle: "取消")
        if alert.runModal() == .alertFirstButtonReturn {
            onDelete()
        }
    }
}

/// 浮层里的删除小按钮（.folio-del）：20×20，悬停转红底。
private struct FolioDeleteButton: View {
    let palette: ReaderPalette
    let help: String
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            Image(systemName: ReaderIcons.trash)
                .font(.system(size: 10, weight: .medium))
                .foregroundColor(hover ? palette.err : palette.ink4)
                .frame(width: 20, height: 20)
                .background(Circle().fill(hover ? palette.errSoft : Color.clear))
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
        .help(help)
    }
}

struct InkProgressBar: View {
    let percent: Double
    @Environment(\.readerPalette) private var palette

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Rectangle()
                    .fill(palette.border.opacity(0.3))
                Rectangle()
                    .fill(palette.accent)
                    .frame(width: geo.size.width * min(1, max(0, percent / 100)))
            }
        }
        .frame(height: 2)
    }
}

// MARK: - 主体（路由舞台 + 词典栏；书架是首页，v0.8 起左栏书架移交整页书架与浮层）

struct ReaderBodyView: View {
    @ObservedObject var vm: ReaderViewModel
    /// 「减弱动态效果」：切档退化 120ms 纯淡入（REVIEW-04，apple-design §14）。
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// 窄窗断点（量整窗宽，含透镜卡占位）：≤1080px 书脊列隐藏，不挤压正文。
    static let spineBreakpoint: CGFloat = 1080

    var body: some View {
        GeometryReader { geo in
            // REVIEW-04 切档动线：ZStack 让新旧两档在 200ms 内叠合走 opacity 交叉
            // 淡入（对齐 islandTab 同一条曲线）——原先 HStack 内瞬切，导航岛胶囊
            // 还在滑、底下正文已整屏啪一下换掉。reading 档的「正文 + 透镜卡」双列
            // 在分支内自理；各分支显式铺满舞台，保证淡入的两帧逐点重合。
            ZStack(alignment: .topLeading) {
                switch vm.route {
                case .shelf:
                    ShelfHomeView(vm: vm)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                        .transition(.opacity)
                case .reading:
                    HStack(alignment: .top, spacing: 0) {
                        ReadingStageView(vm: vm, spineVisible: geo.size.width > Self.spineBreakpoint)
                        // v0.8 透镜卡常驻右栏（句子解析 / 查词双 Tab，DictColumn.tsx
                        // spatial-lens-card）；无文章或禅模式（隐藏侧栏）不占位。
                        if vm.article != nil, !vm.effectiveSettings.zenMode {
                            DictColumnView(vm: vm)
                                .frame(width: 340)
                        }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    .transition(.opacity)
                case .review, .notes:
                    // 「笔记与复习」三合一容器（v0.8 VaultPage）：review/notes 两条
                    // 兼容路由共用（openReview 落挑战档 / openNotes 落 md 档），
                    // 顶栏三档玩法 + 右侧内化看板同屏并存。
                    ReaderVaultView(vm: vm)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                        .transition(.opacity)
                case .speak:
                    SpeakView(vm: vm, controller: vm.speak)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                        .transition(.opacity)
                }
            }
            .frame(maxHeight: .infinity)
            // 只在 route 变化时为舞台注入切档动画；岛内按钮自带的 islandTab
            // 事务在此被同名曲线接管（同一条 200ms 弹性曲线，两处动效同步呼吸）。
            .animation(
                reduceMotion ? ReaderMotion.routeFadeReduced : ReaderMotion.routeFade,
                value: vm.route
            )
        }
    }
}

// MARK: - 整页书架（首页；对齐 Windows ShelfPage.tsx）

/// 书架首页：头部（书架 + 书/短文分段 + 数量 + 导入）· 书卡网格（封面 / 章进度 /
/// 断点直达 / 目录 / 删除）· 短文行（标题 / 百分比）· 底部今日卡（阅读目标环 +
/// 复习进度）。口语陪练 / 生词复习入口在顶部导航岛，不再在书架重复留按钮。
struct ShelfHomeView: View {
    @ObservedObject var vm: ReaderViewModel
    /// 阅读目标配置（ReviewTouchpointManager.config.readGoalMin；提醒设置组同源）。
    @ObservedObject private var touchpoint = ReviewTouchpointManager.shared
    @Environment(\.readerPalette) private var palette

    private enum Tab: Equatable {
        case books, articles
    }

    @State private var tab: Tab = .books

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                head
                if tab == .books { booksSection } else { articlesSection }
                ShelfTodayCard(
                    reviewedToday: vm.stats.reviewedToday,
                    dueNow: vm.stats.dueNow,
                    streak: vm.stats.streak,
                    readSecondsToday: vm.readSecondsToday,
                    goalMin: touchpoint.config.readGoalMin,
                    onGoReview: { vm.openReview() }
                )
            }
            .padding(.horizontal, 40)
            .padding(.top, 20)
            .padding(.bottom, 48)
            .frame(maxWidth: 1080)
            .frame(maxWidth: .infinity)
            .animation(ReaderMotion.islandTab, value: tab)
        }
        .onAppear {
            // 只有短文没有书：默认落在短文页，别让用户面对一个空 tab。
            if tab == .books, vm.bookList.isEmpty, !vm.articleList.isEmpty {
                tab = .articles
            }
        }
    }

    // MARK: 头部

    private var countText: String {
        if tab == .books {
            let words = vm.bookList.reduce(0) { n, b in n + b.chapters.reduce(0) { m, c in m + c.wordCount } }
            return vm.bookList.isEmpty ? "还没有书" : "\(vm.bookList.count) 本书 · \(words.formatted()) 词"
        }
        return vm.articleList.isEmpty ? "还没有短文" : "\(vm.articleList.count) 篇短文"
    }

    private var head: some View {
        HStack(alignment: .firstTextBaseline, spacing: 16) {
            Text("书架")
                .font(readerDisplayFont(30))
                .foregroundColor(palette.text)
            HStack(spacing: 3) {
                ShelfSegTab(label: "书", active: tab == .books, palette: palette) {
                    tab = .books
                }
                ShelfSegTab(label: "短文", active: tab == .articles, palette: palette) {
                    tab = .articles
                }
            }
            .padding(3)
            .modifier(GlassPillStyle(palette: palette))
            Text(countText)
                .font(.system(size: 12))
                .foregroundColor(palette.textTertiary)
            Spacer(minLength: 12)
            Button {
                vm.importSheetShown = true
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: ReaderIcons.plus).font(.system(size: 11, weight: .semibold))
                    Text("导入").font(.system(size: 12.5, weight: .semibold))
                }
                .foregroundColor(.white)
                .padding(.horizontal, 14)
                .frame(height: 30)
                .background(Capsule().fill(palette.accent))
                .shadow(color: palette.accentGlow, radius: 8, y: 3)
            }
            .buttonStyle(.plain)
            .help("导入向导 · 新增 EPUB 长书 / 短文")
        }
    }

    // MARK: 书卡网格

    @ViewBuilder
    private var booksSection: some View {
        if vm.bookList.isEmpty {
            ShelfEmptyCard(
                icon: ReaderIcons.book,
                title: "导入整本 EPUB",
                subtitle: "自动分章 · 断点续读 · 生词进复习闭环；也可以先读内置文库的短篇",
                palette: palette
            ) {
                vm.importSheetShown = true
            }
        } else {
            LazyVGrid(
                columns: [GridItem(.adaptive(minimum: 330, maximum: 540), spacing: 16)],
                alignment: .leading,
                spacing: 16
            ) {
                ForEach(vm.bookList) { book in
                    ShelfBookCard(
                        book: book,
                        palette: palette,
                        onContinue: { vm.openBookAt(bookId: book.id) },
                        onOpenToc: { vm.openBookToc(bookId: book.id) },
                        onDelete: { vm.deleteBook(bookId: book.id) }
                    )
                }
            }
        }
    }

    // MARK: 短文列表

    @ViewBuilder
    private var articlesSection: some View {
        if vm.articleList.isEmpty {
            ShelfEmptyCard(
                icon: ReaderIcons.book,
                title: "添加一篇短文",
                subtitle: "内置文库 · 网页链接 · Word / PDF · 粘贴文本",
                palette: palette
            ) {
                vm.importSheetShown = true
            }
        } else {
            VStack(spacing: 0) {
                ForEach(Array(vm.articleList.enumerated()), id: \.element.id) { idx, summary in
                    ShelfArticleRow(
                        summary: summary,
                        palette: palette,
                        onSelect: { vm.openArticle(id: summary.id) },
                        onDelete: { vm.deleteArticle(id: summary.id) }
                    )
                    if idx < vm.articleList.count - 1 {
                        Rectangle()
                            .fill(palette.glassBorder)
                            .frame(height: 1)
                            .padding(.leading, 14)
                    }
                }
            }
            .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(palette.glassSurface.opacity(0.5)))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(palette.glassBorder, lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
    }
}

/// 头部分段小 tab（书 / 短文）。
private struct ShelfSegTab: View {
    let label: String
    let active: Bool
    let palette: ReaderPalette
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(label)
                .font(.system(size: 12, weight: active ? .semibold : .medium))
                .foregroundColor(active ? palette.onInk : palette.textSecondary)
                .padding(.horizontal, 12)
                .frame(height: 26)
                .background(Capsule().fill(active ? palette.text : Color.clear))
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(active ? [.isSelected] : [])
    }
}

/// 书架空态卡（.shelf-empty）：虚线框邀请导入。
private struct ShelfEmptyCard: View {
    let icon: String
    let title: String
    let subtitle: String
    let palette: ReaderPalette
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            VStack(spacing: 8) {
                Image(systemName: icon)
                    .font(.system(size: 20, weight: .light))
                    .foregroundColor(palette.textTertiary)
                Text(title)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundColor(palette.text)
                Text(subtitle)
                    .font(.system(size: 12))
                    .foregroundColor(palette.textTertiary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 420)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 40)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(hover ? palette.glassSurface : Color.clear)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(
                        hover ? palette.accent.opacity(0.55) : palette.glassBorderStrong,
                        style: StrokeStyle(lineWidth: 1, dash: [6, 5])
                    )
            )
            .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(.plain)
        .onHover { h in
            withAnimation(ReaderMotion.hover) { hover = h }
        }
    }
}

/// 书卡（.bookcard）：封面 + 标题 / 作者 · 章数 + 词量·时长 chips + 进度条 +
/// 「继续读 第 N 章 · 第 M 句」/「查看目录」 + 悬停删除。整卡点按 = 查看目录
///（Windows 同款：进入书目录再挑章）。
private struct ShelfBookCard: View {
    let book: BookMeta
    let palette: ReaderPalette
    let onContinue: () -> Void
    let onOpenToc: () -> Void
    let onDelete: () -> Void
    @State private var hover = false

    var body: some View {
        let chapterIdx = bookChapterIndexOf(book: book, chapterId: book.progress.chapterId)
        let percent = Int(bookOverallPercent(book: book).rounded())
        let words = book.chapters.reduce(0) { $0 + $1.wordCount }
        let minutes = max(1, Int((Double(words) / 135).rounded()))
        let started = book.progress.percent > 0 || chapterIdx > 0
        HStack(alignment: .top, spacing: 16) {
            ZStack(alignment: .bottom) {
                Group {
                    if let cover = BookCoverImage.image(fromDataURL: book.cover) {
                        Image(nsImage: cover)
                            .resizable()
                            .aspectRatio(contentMode: .fill)
                    } else {
                        VStack(spacing: 4) {
                            Spacer()
                            Text(String(book.title.prefix(1)).uppercased())
                                .font(readerDisplayFont(28))
                                .foregroundColor(.white.opacity(0.92))
                            Text(book.title)
                                .font(.system(size: 8.5))
                                .foregroundColor(.white.opacity(0.75))
                                .lineLimit(2)
                                .multilineTextAlignment(.center)
                            Text(book.author ?? "")
                                .font(.system(size: 7.5))
                                .foregroundColor(.white.opacity(0.6))
                                .lineLimit(1)
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, 4)
                    }
                }
                .frame(width: 76, height: 108)
                .background(
                    LinearGradient(
                        colors: [
                            Color(hue: 0.08, saturation: 0.42, brightness: 0.62),
                            Color(hue: 0.02, saturation: 0.38, brightness: 0.48)
                        ],
                        startPoint: .topLeading, endPoint: .bottomTrailing
                    )
                )
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                if percent >= 100 {
                    Text("已读完 ✓")
                        .font(.system(size: 9.5, weight: .semibold))
                        .foregroundColor(.white)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2)
                        .frame(maxWidth: .infinity)
                        .background(palette.sonicTeal)
                }
            }
            VStack(alignment: .leading, spacing: 6) {
                Text(book.title)
                    .font(readerDisplayFont(18))
                    .foregroundColor(palette.text)
                    .lineLimit(2)
                    .help(book.title)
                Text("\(book.author ?? "未知作者") · 共 \(book.chapters.count) 章")
                    .font(.system(size: 12))
                    .foregroundColor(palette.textTertiary)
                HStack(spacing: 6) {
                    ShelfChip(text: "\(book.chapters.count) 章", palette: palette)
                    ShelfChip(text: "\(words.formatted()) 词", palette: palette)
                    ShelfChip(text: minutes >= 60 ? String(format: "约 %.1f 小时", Double(minutes) / 60) : "约 \(minutes) 分钟", palette: palette)
                }
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 8) {
                        Text("\(percent)%")
                            .font(.system(size: 12.5, weight: .bold))
                            .monospacedDigit()
                            .foregroundColor(palette.text)
                        Text(percent >= 100 ? "已读完" : (started ? "已读至第 \(chapterIdx + 1) / \(book.chapters.count) 章" : "尚未开始"))
                            .font(.system(size: 11))
                            .foregroundColor(palette.textTertiary)
                    }
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            Capsule().fill(palette.glassBorderStrong)
                            Capsule()
                                .fill(palette.accent)
                                .frame(width: max(0, geo.size.width * CGFloat(percent) / 100))
                                .animation(.easeOut(duration: 0.4), value: percent)
                        }
                    }
                    .frame(height: 3)
                }
                .padding(.top, 2)
                HStack(spacing: 8) {
                    Button(action: onContinue) {
                        HStack(spacing: 5) {
                            Image(systemName: ReaderIcons.play).font(.system(size: 9, weight: .bold))
                            Text(started ? "继续读 第 \(chapterIdx + 1) 章 · 第 \(book.progress.sentenceIdx + 1) 句" : "开始阅读")
                                .font(.system(size: 11.5, weight: .semibold))
                        }
                        .foregroundColor(.white)
                        .padding(.horizontal, 11)
                        .frame(height: 26)
                        .background(Capsule().fill(palette.accent))
                    }
                    .buttonStyle(.plain)
                    .help("直达这本书的断点章")
                    GhostPillButton(text: "查看目录", palette: palette, help: "本书目录：各章词数与生词数，点章即跳") {
                        onOpenToc()
                    }
                    if book.radar.kaoyan > 0 {
                        ShelfChip(text: "考研 · 大纲词 \(book.radar.kaoyan.formatted())", palette: palette)
                            .help("选书雷达：考研大纲词覆盖数")
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(palette.glassSurface.opacity(0.55))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(hover ? palette.glassBorderStrong : palette.glassBorder, lineWidth: 1)
        )
        .overlay(alignment: .topTrailing) {
            if hover {
                FolioDeleteButton(palette: palette, help: "移出书架（生词本不受影响）") {
                    confirmDelete()
                }
                .padding(10)
            }
        }
        .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .onTapGesture(perform: onOpenToc)
        .onHover { h in
            withAnimation(ReaderMotion.hover) { hover = h }
        }
    }

    private func confirmDelete() {
        let alert = NSAlert()
        alert.messageText = "删除《\(book.title)》？"
        alert.informativeText = "将删除全部 \(book.chapters.count) 章内容与这本书的阅读进度，不可恢复；生词本不受影响。"
        alert.alertStyle = .warning
        alert.addButton(withTitle: "删除")
        alert.addButton(withTitle: "取消")
        if alert.runModal() == .alertFirstButtonReturn {
            onDelete()
        }
    }
}

/// 短文行（.artrow）：级别 chip + 标题 / 中文副题 + 百分比 + 悬停删除；发丝线分隔。
private struct ShelfArticleRow: View {
    let summary: ArticleSummary
    let palette: ReaderPalette
    let onSelect: () -> Void
    let onDelete: () -> Void
    @State private var hover = false

    var body: some View {
        let article = summary.article
        HStack(spacing: 12) {
            if let level = article.level, !level.isEmpty {
                ShelfChip(text: level, palette: palette)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(article.title)
                    .font(.system(size: 14, design: .serif))
                    .foregroundColor(palette.text)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .help(article.title)
                if let titleCn = article.titleCn, !titleCn.isEmpty {
                    Text(titleCn)
                        .font(.system(size: 11.5))
                        .foregroundColor(palette.textTertiary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 12)
            Text("\(Int(article.progress.percent.rounded()))%")
                .font(.system(size: 12.5))
                .monospacedDigit()
                .foregroundColor(palette.textTertiary)
            if hover {
                FolioDeleteButton(palette: palette, help: "删除文章（生词本不受影响）") {
                    confirmDelete()
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .onTapGesture(perform: onSelect)
        .onHover { h in
            withAnimation(ReaderMotion.hover) { hover = h }
        }
    }

    private func confirmDelete() {
        let alert = NSAlert()
        alert.messageText = "删除《\(summary.article.title)》？"
        alert.informativeText = "这篇短文将从书架移除；生词本不受影响。"
        alert.alertStyle = .warning
        alert.addButton(withTitle: "删除")
        alert.addButton(withTitle: "取消")
        if alert.runModal() == .alertFirstButtonReturn {
            onDelete()
        }
    }
}

/// 胶带风 chip（--tape-* 令牌）：级别 / 词量 / 雷达徽标。
private struct ShelfChip: View {
    let text: String
    let palette: ReaderPalette

    var body: some View {
        Text(text)
            .font(.system(size: 11))
            .foregroundColor(palette.tapeInk)
            .padding(.horizontal, 7)
            .padding(.vertical, 2.5)
            .background(RoundedRectangle(cornerRadius: 5, style: .continuous).fill(palette.tapeBg))
            .overlay(RoundedRectangle(cornerRadius: 5, style: .continuous).strokeBorder(palette.tapeBorder, lineWidth: 1))
            .fixedSize()
    }
}

/// 书架底部今日卡（.todaycard）：阅读目标环 + 今日已读/连续天数 + 今日复习进度与「继续复习」。
private struct ShelfTodayCard: View {
    let reviewedToday: Int
    let dueNow: Int
    let streak: Int
    let readSecondsToday: Double
    let goalMin: Int
    let onGoReview: () -> Void
    @Environment(\.readerPalette) private var palette

    private var todayTotal: Int { reviewedToday + dueNow }
    private var readMinutes: Int { max(0, Int((readSecondsToday / 60).rounded())) }
    private var goalRatio: Double { goalMin > 0 ? min(1, Double(readMinutes) / Double(goalMin)) : 0 }
    private var reviewRatio: Double { todayTotal > 0 ? Double(reviewedToday) / Double(todayTotal) : 0 }

    var body: some View {
        HStack(alignment: .center, spacing: 20) {
            // 阅读目标环（今日已读 M / N 分钟）
            ZStack {
                Circle().stroke(palette.glassBorderStrong, lineWidth: 4)
                Circle()
                    .trim(from: 0, to: goalRatio)
                    .stroke(goalRatio >= 1 ? palette.sonicTeal : palette.accent, style: StrokeStyle(lineWidth: 4, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                    .animation(ReaderMotion.islandTab, value: goalRatio)
                Text(goalMin > 0 ? "\(readMinutes)/\(goalMin)" : "\(readMinutes)′")
                    .font(.system(size: 11, weight: .bold, design: .monospaced))
                    .monospacedDigit()
                    .foregroundColor(palette.text)
            }
            .frame(width: 56, height: 56)
            .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 4) {
                Text("今日已读 \(readMinutes) \(goalMin > 0 ? "/ \(goalMin)" : "") 分钟")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(palette.text)
                Text(
                    goalMin > 0
                        ? (readMinutes >= goalMin ? "阅读目标已达成 ✓ · 明天继续保持" : "阅读目标还差 \(goalMin - readMinutes) 分钟达成")
                        : "可在阅读设置里定每日阅读目标"
                )
                .font(.system(size: 11))
                .foregroundColor(palette.textTertiary)
                HStack(spacing: 4) {
                    Image(systemName: ReaderIcons.flame).font(.system(size: 11))
                    Text("连续阅读 \(streak) 天").monospacedDigit()
                }
                .font(.system(size: 11, weight: .semibold))
                .foregroundColor(palette.warn)
            }

            Spacer(minLength: 12)

            VStack(alignment: .leading, spacing: 6) {
                Text("今日复习 \(reviewedToday) / \(todayTotal)")
                    .font(.system(size: 13, weight: .semibold))
                    .monospacedDigit()
                    .foregroundColor(palette.text)
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Capsule().fill(palette.glassBorderStrong)
                        Capsule()
                            .fill(palette.accent)
                            .frame(width: max(0, geo.size.width * reviewRatio))
                            .animation(ReaderMotion.islandTab, value: reviewRatio)
                    }
                }
                .frame(width: 220, height: 4)
                Text(dueNow > 0 ? "还差 \(dueNow) 个清空今天到期" : (todayTotal > 0 ? "今天的到期已清空 ✓" : "今天没有到期生词"))
                    .font(.system(size: 11))
                    .foregroundColor(palette.textTertiary)
                // 无到期词时点了只会进空队列，像「点了没反应」——禁用并写明原因。
                Button {
                    onGoReview()
                } label: {
                    Text(dueNow > 0 ? "继续复习" : "今日已清空")
                        .font(.system(size: 11.5, weight: .semibold))
                        .foregroundColor(.white)
                        .padding(.horizontal, 12)
                        .frame(height: 26)
                        .background(Capsule().fill(dueNow > 0 ? palette.accent : palette.ink4))
                }
                .buttonStyle(.plain)
                .disabled(dueNow == 0)
                .help(dueNow > 0 ? "去复习 \(dueNow) 个到期生词" : (todayTotal > 0 ? "今天的到期已清空，明天再来" : "暂无到期生词。先在阅读里查词收藏，明天会出现在这里"))
                .padding(.top, 2)
            }
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(palette.glassSurface.opacity(0.55)))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(palette.glassBorder, lineWidth: 1))
        .accessibilityElement(children: .combine)
    }
}

// MARK: - 阅读舞台

struct ReadingStageView: View {
    @ObservedObject var vm: ReaderViewModel
    /// 书脊列可见性（ReaderBodyView 按整窗宽度算好传入）。
    var spineVisible: Bool
    @State private var editingIdx: Int?
    @State private var editDraft = ""

    var body: some View {
        HStack(spacing: 0) {
            if spineVisible, let article = vm.article {
                EditorialSpineColumn(
                    article: article,
                    book: vm.currentBook,
                    activeIdx: vm.activeSentenceIdx
                )
                .frame(width: 56)
            }
            VStack(spacing: 0) {
                if let article = vm.article {
                    ReaderScroll(article: article, vm: vm, editingIdx: $editingIdx, editDraft: $editDraft)
                    // 短文结课条：读完后的本篇收获快照，常驻底部直到关闭。
                    if let finish = vm.finishCard, article.id == finish.articleId {
                        Divider().opacity(0.5)
                        ReaderFinishBarView(vm: vm, summary: finish)
                    }
                } else {
                    EmptyStateView {
                        vm.importSheetShown = true
                    }
                }
            }
            .frame(maxWidth: .infinity)
        }
    }
}

// MARK: - 书脊列（v0.8 画报版式，reader.css:6722-6761）

/// 正文左侧书脊列：超大当前句码（44px 斜体 · 墨 18%）+「当前句」小注 +
/// 竖排书名/文章标题 + 全书进度百分比（与顶部墨线同源 article.progress.percent）。
private struct EditorialSpineColumn: View {
    let article: Article
    let book: BookMeta?
    let activeIdx: Int
    @Environment(\.readerPalette) private var palette

    private var spineLabel: String {
        if let book {
            return "\(book.title) · CHAPTER \(bookChapterIndexOf(book: book, chapterId: article.id) + 1)"
        }
        return article.title
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 4) {
                Text(String(format: "%02d", min(activeIdx + 1, 99)))
                    .font(readerDisplayFont(44).italic())
                    .monospacedDigit()
                    .foregroundColor(palette.text.opacity(0.18))
                Text("当前句")
                    .font(.system(size: 10.5, design: .monospaced))
                    .foregroundColor(palette.textTertiary)
            }
            Spacer(minLength: 16)
            verticalLabel
            Spacer(minLength: 16)
            Text("\(Int(article.progress.percent.rounded()))%")
                .font(.system(size: 11, weight: .semibold, design: .monospaced))
                .monospacedDigit()
                .foregroundColor(palette.accent)
        }
        .padding(.top, 20)
        .padding(.bottom, 12)
        .accessibilityHidden(true)
    }

    /// 竖排书脊（writing-mode: vertical-rl + rotate(180deg) 的原生等价物：
    /// 整段逆时针 90°，自下而上读；40% 高度封顶溢出截断）。
    private var verticalLabel: some View {
        GeometryReader { geo in
            let maxLength = geo.size.height * 0.4
            let label = spineLabel.uppercased()
            // 等宽 10.5pt ≈ 6.3pt/字符：预算内截断（overflow: hidden 同语义）。
            let budget = max(4, Int(maxLength / 6.3))
            let clipped = label.count > budget ? String(label.prefix(budget - 1)) + "…" : label
            Text(clipped)
                .font(.system(size: 10.5, design: .monospaced))
                .tracking(1.2)
                .foregroundColor(palette.textTertiary)
                .fixedSize()
                .frame(width: geo.size.height, height: geo.size.width)
                .rotationEffect(.degrees(-90))
                .position(
                    x: geo.size.width / 2,
                    y: geo.size.height - min(maxLength, geo.size.height) / 2
                )
        }
        .help(spineLabel)
    }
}

private struct RowFramesKey: PreferenceKey {
    typealias Value = [Int: CGFloat]

    static var defaultValue: [Int: CGFloat] = [:]

    static func reduce(value: inout [Int: CGFloat], nextValue: () -> [Int: CGFloat]) {
        value.merge(nextValue()) { _, new in new }
    }
}

private struct ReaderScroll: View {
    let article: Article
    @ObservedObject var vm: ReaderViewModel
    @Binding var editingIdx: Int?
    @Binding var editDraft: String
    @Environment(\.readerPalette) private var palette
    @State private var containerHeight: CGFloat = 600

    private var settings: ReaderSettings { vm.effectiveSettings }

    /// 生效版式：仅中文时明确回落对照行（prose 英文流被隐藏后只剩折叠卡，
    /// 不可读）；其余按 spreadLayout（缺省 prose）。
    private var layout: SpreadLayout {
        settings.contrastMode == .zh ? .parallel : settings.effectiveSpreadLayout
    }

    /// 滚到哪读到哪：视口上三分之一高度处的那一句为「当前句」。
    private func adoptViewportFrames(_ frames: [Int: CGFloat]) {
        let line = containerHeight / 3
        let above = frames.filter { $0.value <= line }
        let candidate = above.keys.max() ?? frames.keys.min()
        guard let idx = candidate else { return }
        DispatchQueue.main.async {
            vm.viewportMoved(to: idx)
        }
    }

    /// 正文末「读完本篇/本章」按钮（纯手动阅读路径）：与自然播完走同一落点。
    private var finishActionRow: some View {
        HStack(spacing: 10) {
            Button(vm.finishActionLabel) {
                vm.confirmFinishRead()
            }
            .buttonStyle(.borderedProminent)
            Text("已到文章末尾：确认读完，整理本篇收获或稍后复习。")
                .font(.system(size: 11.5))
                .foregroundColor(palette.textTertiary)
        }
        .padding(.top, 20)
        .padding(.horizontal, 24)
        .frame(maxWidth: 760, alignment: .leading)
    }

    var body: some View {
        GeometryReader { outer in
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        if settings.maskTranslation {
                            MaskBarView(vm: vm)
                        }
                        ArticleHeader(article: article, vm: vm)
                        if layout == .prose {
                            ProseBodyView(article: article, vm: vm, editingIdx: $editingIdx, editDraft: $editDraft)
                        } else {
                            ArticleRows(
                                article: article,
                                vm: vm,
                                editingIdx: $editingIdx,
                                editDraft: $editDraft
                            )
                        }
                        if vm.showFinishAction {
                            finishActionRow
                        }
                    }
                    .padding(.top, 18)
                    // M-02：底部悬浮走带胶囊（bottom 18 + 胶囊高约 50）→ 正文
                    // 安全留白 84（原型 .spatial-stage padding-bottom: 84）。
                    .padding(.bottom, settings.zenMode ? 60 : 84)
                }
                .coordinateSpace(name: "readerScroll")
                .onPreferenceChange(RowFramesKey.self) { frames in
                    adoptViewportFrames(frames)
                }
                .onChange(of: vm.activeSentenceIdx) { idx in
                    proxy.scrollTo(scrollAnchor(for: idx), anchor: .center)
                }
                .onChange(of: vm.searchMatchIdx) { idx in
                    guard let idx else { return }
                    proxy.scrollTo(scrollAnchor(for: idx), anchor: .center)
                }
            }
            .onAppear { containerHeight = outer.size.height }
            .onChange(of: outer.size.height) { containerHeight = $0 }
        }
    }

    /// 滚动锚点：对照行 = 句行 id；prose = 折叠卡（跟着当前句走，
    /// 居中的同时把译文卡一并带进视口）。
    private func scrollAnchor(for idx: Int) -> AnyHashable {
        layout == .prose ? AnyHashable("prose-fold") : AnyHashable(idx)
    }
}

/// 句对行列表（独立结构体，减轻主 body 的类型推断负担）。
private struct ArticleRows: View {
    let article: Article
    @ObservedObject var vm: ReaderViewModel
    @Binding var editingIdx: Int?
    @Binding var editDraft: String

    var body: some View {
        ForEach(article.sentences, id: \.idx) { pair in
            row(for: pair)
        }
    }

    private func row(for pair: SentencePair) -> some View {
        let isParaStart = pair.idx == 0
            || article.sentences[pair.idx - 1].paragraphIdx != pair.paragraphIdx
        return SentenceRowView(
            vm: vm,
            pair: pair,
            isParaStart: isParaStart,
            isActive: pair.idx == vm.activeSentenceIdx,
            isSearchMatch: pair.idx == vm.searchMatchIdx,
            editing: editingIdx == pair.idx,
            editDraft: $editDraft,
            onStartEdit: {
                editDraft = pair.zh ?? ""
                editingIdx = pair.idx
            },
            onCancelEdit: { editingIdx = nil },
            onCommitEdit: {
                let text = editDraft.trimmingCharacters(in: .whitespacesAndNewlines)
                editingIdx = nil
                if !text.isEmpty { vm.editTranslation(idx: pair.idx, zh: text) }
            }
        )
        .id(pair.idx)
        .background(
            GeometryReader { geo in
                Color.clear.preference(
                    key: RowFramesKey.self,
                    value: [pair.idx: geo.frame(in: .named("readerScroll")).minY]
                )
            }
        )
        .padding(.horizontal, 24)
        .padding(.bottom, paragraphGap(after: pair) ? 18 : 6)
    }

    private func paragraphGap(after pair: SentencePair) -> Bool {
        guard pair.idx + 1 < article.sentences.count else { return true }
        return article.sentences[pair.idx + 1].paragraphIdx != pair.paragraphIdx
    }
}

// MARK: - 遮罩条

struct MaskBarView: View {
    @ObservedObject var vm: ReaderViewModel
    @Environment(\.readerPalette) private var palette

    var body: some View {
        let sentences = vm.article?.sentences ?? []
        let peek = vm.peekAll
        let maskable = sentences.filter { $0.zh != nil }.count
        let revealed = sentences.filter { $0.zh != nil && ($0.revealed == true || peek) }.count
        HStack(spacing: 10) {
            Image(systemName: ReaderIcons.eyeOff)
                .font(.system(size: 11))
                .foregroundColor(palette.accent)
            Text("译文遮罩")
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(palette.text)
            Text("\(revealed) / \(maskable) 已揭开")
                .font(.system(size: 12))
                .foregroundColor(palette.textSecondary)
            Text("点单句揭开 / 再点遮住 · 按住 H 临时显示全部")
                .font(.system(size: 11))
                .foregroundColor(palette.textTertiary)
            Spacer()
            if revealed < maskable {
                Button("全部揭开") { vm.revealAll() }
                    .controlSize(.small)
            }
            if revealed > 0 {
                Button("全部遮住") { vm.maskAll() }
                    .controlSize(.small)
            }
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 8)
        .background(palette.accent.opacity(0.07))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .padding(.horizontal, 24)
        .padding(.bottom, 8)
        .frame(maxWidth: 760)
    }
}

// MARK: - 刊头（v0.8 画报版式：元信息行 + 行内三开关 + display 标题 + 中文副题）

struct ArticleHeader: View {
    let article: Article
    @ObservedObject var vm: ReaderViewModel
    @Environment(\.readerPalette) private var palette

    /// 约 N 分钟读完：wordCount/200 四舍五入、至少 1（ReadingView.tsx:249）。
    private var readMinutes: Int {
        max(1, Int((Double(article.wordCount) / 200).rounded()))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            mastheadMeta
            Text(article.title)
                .font(readerDisplayFont(54))
                .tracking(-1.3)
                .lineSpacing(2)
                .minimumScaleFactor(0.55)
                .lineLimit(4)
                .foregroundColor(palette.text)
                .padding(.bottom, 10)
            mastheadCnSub
        }
        .padding(.horizontal, 24)
        .frame(maxWidth: 760, alignment: .leading)
    }

    // MARK: 元信息行 + 三开关

    private var mastheadMeta: some View {
        VStack(alignment: .leading, spacing: 8) {
            metaLine
            mastheadSwitches
        }
        .padding(.bottom, 12)
        .overlay(alignment: .bottom) {
            Rectangle().fill(palette.glassBorderStrong).frame(height: 1)
        }
        .padding(.bottom, 22)
    }

    private var metaLine: some View {
        HStack(spacing: 10) {
            if let bookId = article.bookId, let book = vm.bookList.first(where: { $0.id == bookId }) {
                Text("CHAPTER \(bookChapterIndexOf(book: book, chapterId: article.id) + 1)")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(palette.textTertiary)
            }
            Text("\(article.wordCount) 词 · 约 \(readMinutes) 分钟读完")
                .font(.system(size: 11, design: .monospaced))
                .foregroundColor(palette.textTertiary)
            if let level = article.level, !level.isEmpty {
                Text(level)
                    .font(.system(size: 10.5, weight: .semibold))
                    .foregroundColor(Color(nsColor: .systemBlue))
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(Color(nsColor: .systemBlue).opacity(0.12))
                    .clipShape(Capsule())
                    .help("分级阅读级别")
            }
            if let translating = vm.translating {
                progressChip("翻译中 \(translating.done)/\(translating.total) 段")
            }
            if vm.translating == nil, let chunking = vm.chunking {
                progressChip("词块标注中 \(chunking.done)/\(chunking.total) 批")
            }
            let resumeIdx = article.progress.sentenceIdx
            if resumeIdx > 0, resumeIdx < article.sentences.count, vm.translating == nil {
                Button("上次读到第 \(resumeIdx + 1) 句 · 点击继续") {
                    vm.jumpTo(idx: resumeIdx)
                }
                .buttonStyle(.link)
                .font(.system(size: 11))
            }
            if vm.currentBook != nil {
                Button {
                    vm.bookTocShown = true
                } label: {
                    Label("目录", systemImage: "list.bullet")
                        .font(.system(size: 10.5, weight: .medium))
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .help("本书目录：各章词数与已收藏生词数，点章即跳")
            }
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    /// 刊头行内三开关：专注模式 / 排版 / 译文显隐（ReadingView.tsx:572-594）。
    private var mastheadSwitches: some View {
        let settings = vm.effectiveSettings
        let spotlight = settings.spotlightEnabled
        let spread = settings.effectiveSpreadLayout
        return HStack(spacing: 14) {
            TextActionButton(text: "专注模式：\(spotlight ? "开" : "关")", palette: palette, help: "开启后非当前句变淡，注意力聚焦当前句") {
                vm.patchSettings { $0.spotlightMode = !($0.spotlightMode ?? false) }
            }
            TextActionButton(text: "排版：\(spread.label)", palette: palette, help: "段落 = 行内英文流 + 当前句行间译文；双语对照 = 逐句双栏") {
                vm.patchSettings { $0.spreadLayout = ($0.spreadLayout ?? .prose).next }
            }
            TextActionButton(text: "译文：\(settings.maskTranslation ? "隐藏" : "显示")", palette: palette, help: "遮住译文先读原文，需要时再点开") {
                vm.patchSettings { $0.maskTranslation = !$0.maskTranslation }
            }
        }
    }

    // MARK: 中文副题

    @ViewBuilder
    private var mastheadCnSub: some View {
        HStack(alignment: .firstTextBaseline) {
            if let titleCn = article.titleCn {
                Text(titleCn)
                    .font(readerFont(16, .regular, pair: vm.effectiveSettings.fontPair))
                    .foregroundColor(palette.textSecondary)
            } else if article.titleCnState == .failed {
                HStack(spacing: 8) {
                    Text("标题翻译失败")
                        .font(.system(size: 13))
                        .foregroundColor(palette.err)
                    Button("重试") { vm.retryTitle() }
                        .buttonStyle(.link)
                        .font(.system(size: 13))
                }
            } else if vm.translating != nil {
                SkeletonLine(width: 220)
                    .padding(.vertical, 4)
            }
            Spacer(minLength: 12)
            if vm.currentBook != nil {
                TextActionButton(text: "围绕本章练口语 →", palette: palette, help: "带着本章内容去口语陪练") {
                    vm.practiceSentence(idx: vm.activeSentenceIdx)
                }
            }
        }
        .padding(.bottom, 28)
    }

    private func progressChip(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 11, weight: .medium))
            .foregroundColor(palette.warn)
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background(palette.warn.opacity(0.12))
            .clipShape(Capsule())
    }
}

/// 刊头/折叠卡文字动作按钮（.text-action-btn）：无底无框，悬停转主色。
private struct TextActionButton: View {
    let text: String
    var icon: String? = nil
    let palette: ReaderPalette
    let help: String
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                if let icon {
                    Image(systemName: icon)
                        .font(.system(size: 12, weight: .medium))
                }
                Text(text)
                    .font(.system(size: 12, weight: .medium))
            }
            .foregroundColor(hover ? palette.accent : palette.textSecondary)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { h in
            withAnimation(ReaderMotion.hover) { hover = h }
        }
        .help(help)
    }
}

struct SkeletonLine: View {
    let width: CGFloat
    @Environment(\.readerPalette) private var palette

    var body: some View {
        RoundedRectangle(cornerRadius: 4)
            .fill(palette.border.opacity(0.4))
            .frame(width: width, height: 10)
            .opacity(0.7)
    }
}

// MARK: - 句对行

struct SentenceRowView: View {
    @ObservedObject var vm: ReaderViewModel
    let pair: SentencePair
    let isParaStart: Bool
    let isActive: Bool
    let isSearchMatch: Bool
    let editing: Bool
    @Binding var editDraft: String
    let onStartEdit: () -> Void
    let onCancelEdit: () -> Void
    let onCommitEdit: () -> Void

    @Environment(\.readerPalette) private var palette
    @State private var hoverCN = false

    var body: some View {
        let settings = vm.effectiveSettings
        let maskOn = settings.maskTranslation
        let peek = vm.peekAll
        let maskSlot = maskOn && pair.zh != nil && pair.zhState != .failed && !editing
        let maskShown = maskSlot && (pair.revealed == true || peek)
        // 对照模式消费（READ-5）：仅英文隐藏译文列、仅中文隐藏英文原文
        //（英文隐藏后点词/划选自然不可触发）；朗读定位不受影响。
        let showEN = settings.contrastMode != .zh
        let showCN = settings.contrastMode != .en

        HStack(alignment: .top, spacing: 10) {
            numberButton
            VStack(alignment: .leading, spacing: 4) {
                if showEN {
                    sentenceEN(settings: settings)
                }
                if showCN {
                    cnArea(settings: settings, maskSlot: maskSlot, maskShown: maskShown)
                }
            }
            rowActions(editing: editing, showEdit: showCN)
        }
        .padding(.top, isParaStart ? 14 : 2)
        .padding(.bottom, 4)
        .padding(.leading, 10)
        .padding(.trailing, 12)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(isActive ? palette.activeRow : (isSearchMatch ? palette.warn.opacity(0.1) : Color.clear))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .strokeBorder(isSearchMatch ? palette.warn.opacity(0.5) : Color.clear, lineWidth: 1.5)
        )
    }

    private func rowActions(editing: Bool, showEdit: Bool) -> some View {
        VStack(spacing: 6) {
            Button {
                vm.speakSentence(pair.idx)
            } label: {
                Image(systemName: ReaderIcons.speaker)
                    .font(.system(size: 11))
                    .foregroundColor(isActive ? palette.accent : palette.textTertiary)
                    .frame(width: 20, height: 20)
            }
            .buttonStyle(.plain)
            .help(isActive ? "朗读当前句" : "朗读这一句")
            if showEdit, pair.zh != nil, pair.zhState != .pending, !editing {
                Button {
                    onStartEdit()
                } label: {
                    Image(systemName: ReaderIcons.edit)
                        .font(.system(size: 10))
                        .foregroundColor(palette.textTertiary)
                        .frame(width: 20, height: 20)
                }
                .buttonStyle(.plain)
                .help("手改译文")
            }
        }
    }

    private var numberButton: some View {
        Button {
            vm.jumpTo(idx: pair.idx)
        } label: {
            Text("\(pair.idx + 1)")
                .font(.system(size: 10.5, weight: .medium).monospacedDigit())
                .foregroundColor(isActive ? palette.accent : palette.textTertiary)
                .frame(minWidth: 22, minHeight: 18)
                .background(isActive ? palette.accent.opacity(0.12) : Color.clear)
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
        .help("第 \(pair.idx + 1) 句 · 点击定位")
    }

    /// 词块/生词再现跨度（开关只影响参与合并的候选）。
    private var spanMarks: [ReaderSentenceText.SpanMark] {
        let settings = vm.effectiveSettings
        let spans = buildSentenceSpans(
            pair.en,
            settings.chunkHighlight ? pair.chunks : nil,
            knownIds: settings.showVocabMarks ? vm.knownIds : []
        )
        return spans.compactMap { span in
            ReaderSentenceText.SpanMark(
                start: span.start,
                end: span.end,
                kind: span.kind,
                chunk: span.chunk
            )
        }
    }

    private func sentenceEN(settings: ReaderSettings) -> some View {
        let nsFont = readerNSFont(CGFloat(settings.fontSize), pair: settings.fontPair)
        let lineTarget = (CGFloat(settings.fontSize) / 19.0) * 29 * CGFloat(settings.lineHeight)
        let lineSpacing = max(0, lineTarget - nsFont.pointSize * 1.25)
        return ReaderSentenceText(
            text: pair.en,
            font: nsFont,
            textColor: NSColor(palette.text),
            lineSpacing: lineSpacing,
            chunkUnderlineColor: NSColor(palette.accent),
            knownUnderlineColor: NSColor(palette.knownColor),
            marks: spanMarks,
            onSelection: { text in vm.lookup(query: text, sentenceIdx: pair.idx) },
            onWordClick: { word in vm.lookup(query: word, sentenceIdx: pair.idx) },
            onChunkClick: { chunk in vm.openChunkCard(chunk: chunk, sentenceIdx: pair.idx) },
            assessMarks: pair.idx == vm.activeSentenceIdx ? vm.assess.state.marks : nil,
            // 透镜卡意群悬停回标（对照行通道；命中本句时整句只渲染这一个标记）。
            hoveredClause: vm.hoveredClause,
            clauseIndigoColor: NSColor(palette.clauseIndigo),
            clauseIndigoSoftColor: NSColor(palette.clauseIndigoSoft)
        )
        .frame(maxWidth: 680, alignment: .leading)
        .help("单击查词，划选查短语；蓝色虚线为词块，点按看释义")
    }

    @ViewBuilder
    private func cnArea(settings: ReaderSettings, maskSlot: Bool, maskShown: Bool) -> some View {
        let cnFont = readerFont((CGFloat(settings.fontSize) / 19.0) * 15, pair: settings.fontPair)
        let lineSpacing = (CGFloat(settings.fontSize) / 19.0) * 24 * CGFloat(settings.lineHeight) - 19
        Group {
            if maskSlot {
                maskBody(settings: settings, maskShown: maskShown, cnFont: cnFont, lineSpacing: lineSpacing)
            } else if pair.zhState == .pending {
                pendingBody(cnFont: cnFont, lineSpacing: lineSpacing)
            } else if pair.zhState == .failed {
                failedBody()
            } else if editing {
                editorBody(cnFont: cnFont)
            } else if let zh = pair.zh {
                Text(zh)
                    .font(cnFont)
                    .foregroundColor(palette.textSecondary)
                    .lineSpacing(max(2, lineSpacing))
                    .contentShape(Rectangle())
                    .onTapGesture { vm.jumpTo(idx: pair.idx) }
                    .help("点中文定位到对应英文句")
            } else {
                EmptyView()
            }
        }
        .frame(maxWidth: 680, alignment: .leading)
    }

    @ViewBuilder
    private func maskBody(settings: ReaderSettings, maskShown: Bool, cnFont: Font, lineSpacing: CGFloat) -> some View {
        if settings.maskStyle == .frost {
            Text(pair.zh ?? "")
                .font(cnFont)
                .foregroundColor(palette.textSecondary)
                .lineSpacing(max(2, lineSpacing))
                .blur(radius: maskShown ? 0 : 7)
                .opacity(maskShown ? 1 : 0.55)
                .contentShape(Rectangle())
                .onTapGesture {
                    if maskShown { vm.mask(pair.idx) } else { vm.reveal(pair.idx) }
                }
                .help(maskShown ? "点按重新遮住" : "点按显示译文")
        } else {
            ZStack(alignment: .leading) {
                if maskShown {
                    Text(pair.zh ?? "")
                        .font(cnFont)
                        .foregroundColor(palette.textSecondary)
                        .lineSpacing(max(2, lineSpacing))
                        .contentShape(Rectangle())
                        .onTapGesture { vm.mask(pair.idx) }
                        .help("点按重新遮住")
                } else {
                    HStack(spacing: 5) {
                        Image(systemName: ReaderIcons.eyeOff).font(.system(size: 10))
                        Text("显示译文").font(.system(size: 11))
                    }
                    .foregroundColor(palette.textTertiary)
                    .padding(.vertical, 3)
                    .padding(.horizontal, 6)
                    .background(hoverCN ? palette.border.opacity(0.3) : Color.clear)
                    .clipShape(RoundedRectangle(cornerRadius: 5))
                    .contentShape(Rectangle())
                    .onHover { hoverCN = $0 }
                    .onTapGesture { vm.reveal(pair.idx) }
                }
            }
            .frame(minHeight: 20)
        }
    }

    @ViewBuilder
    private func pendingBody(cnFont: Font, lineSpacing: CGFloat) -> some View {
        if let zh = pair.zh {
            Text(zh)
                .font(cnFont)
                .foregroundColor(palette.textSecondary.opacity(0.75))
                .lineSpacing(max(2, lineSpacing))
        } else if vm.translating != nil {
            SkeletonLine(width: 140)
        } else {
            Text("译文待生成")
                .font(.system(size: 12))
                .foregroundColor(palette.textTertiary)
        }
    }

    private func failedBody() -> some View {
        HStack(spacing: 10) {
            Text("本段翻译失败")
                .font(.system(size: 12))
                .foregroundColor(palette.err)
            Button("重试本段") { vm.retryParagraph(pair.paragraphIdx) }
                .buttonStyle(.link)
                .font(.system(size: 12))
        }
    }

    private func editorBody(cnFont: Font) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            TextEditor(text: $editDraft)
                .font(cnFont)
                .frame(minHeight: 48)
                .scrollContentBackground(.hidden)
                .padding(4)
                .background(palette.surfaceAlt)
                .cornerRadius(6)
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(palette.accent.opacity(0.5)))
            HStack {
                Text("⌘↩ 保存 · Esc 取消")
                    .font(.system(size: 11))
                    .foregroundColor(palette.textTertiary)
                Spacer()
                Button("取消") { onCancelEdit() }.controlSize(.small)
                Button("保存") { onCommitEdit() }
                    .controlSize(.small)
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(editDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
    }
}

// MARK: - 画报正文（v0.8 prose 模式：段落英文流 + 当前句行间折叠卡）

/// 段落英文流：按 paragraphIdx 分段，段内句子在同一个文本块里连续排版；
/// 当前句所在段落被折叠卡从流中剖开（block 级卡 ≈ Windows display:block
/// 的 interlinear-fold），切句后折叠卡跟随移动。段间以细行距分组。
private struct ProseBodyView: View {
    let article: Article
    @ObservedObject var vm: ReaderViewModel
    @Binding var editingIdx: Int?
    @Binding var editDraft: String
    @Environment(\.readerPalette) private var palette

    private var paragraphs: [[SentencePair]] {
        var groups: [[SentencePair]] = []
        for sentence in article.sentences {
            if let last = groups.last, last.last?.paragraphIdx == sentence.paragraphIdx {
                groups[groups.count - 1].append(sentence)
            } else {
                groups.append([sentence])
            }
        }
        return groups
    }

    var body: some View {
        let spotlight = vm.effectiveSettings.spotlightEnabled
        VStack(alignment: .leading, spacing: 9) {
            ForEach(paragraphs, id: \.first?.idx) { para in
                paragraphBlocks(para, spotlight: spotlight)
            }
        }
        .padding(.horizontal, 24)
        .frame(maxWidth: 760, alignment: .leading)
    }

    @ViewBuilder
    private func paragraphBlocks(_ para: [SentencePair], spotlight: Bool) -> some View {
        let split = para.firstIndex { $0.idx == vm.activeSentenceIdx }
        let head = split.map { Array(para[...$0]) } ?? para
        ProseBlockView(
            pieces: makePieces(head),
            article: article,
            vm: vm,
            spotlight: spotlight,
            isFirstBlock: head.first?.idx == article.sentences.first?.idx
        )
        if let split {
            let current = para[split]
            InterlinearFoldCard(
                vm: vm,
                pair: current,
                editing: editingIdx == current.idx,
                editDraft: $editDraft,
                onStartEdit: {
                    editDraft = current.zh ?? ""
                    editingIdx = current.idx
                },
                onCancelEdit: { editingIdx = nil },
                onCommitEdit: {
                    let text = editDraft.trimmingCharacters(in: .whitespacesAndNewlines)
                    editingIdx = nil
                    if !text.isEmpty { vm.editTranslation(idx: current.idx, zh: text) }
                }
            )
            .id("prose-fold")
            if split + 1 < para.count {
                ProseBlockView(
                    pieces: makePieces(Array(para[(split + 1)...])),
                    article: article,
                    vm: vm,
                    spotlight: spotlight,
                    isFirstBlock: false
                )
            }
        }
    }

    /// 句 → 拼接坐标：句间以一个空格相连（行内流）。
    private func makePieces(_ sentences: [SentencePair]) -> [ProsePiece] {
        var cursor = 0
        return sentences.map { s in
            let piece = ProsePiece(
                idx: s.idx,
                en: s.en,
                start: cursor,
                isCurrent: s.idx == vm.activeSentenceIdx,
                failed: s.zhState == .failed
            )
            cursor += (s.en as NSString).length + 1
            return piece
        }
    }
}

/// 段落流的一块（ReaderProseText 的 SwiftUI 包装）：
/// 词块/生词跨度、跟读着色折算到拼接坐标；句子 minY 回报给滚动跟随。
private struct ProseBlockView: View {
    let pieces: [ProsePiece]
    let article: Article
    @ObservedObject var vm: ReaderViewModel
    let spotlight: Bool
    let isFirstBlock: Bool
    @Environment(\.readerPalette) private var palette
    @State private var localFrames: [Int: CGFloat] = [:]

    /// 首字下沉的 64px 衬线展示字（.drop-cap italic）。
    private static let dropCapFont: NSFont = {
        let base = NSFont.systemFont(ofSize: 64, weight: .regular)
        let descriptor = base.fontDescriptor
            .withDesign(.serif)?
            .withSymbolicTraits(.italic)
        return descriptor.flatMap { NSFont(descriptor: $0, size: 64) } ?? base
    }()

    var body: some View {
        let settings = vm.effectiveSettings
        let nsFont = readerNSFont(CGFloat(settings.fontSize), pair: settings.fontPair)
        // 画报行高 ≈ 常规行高 × 1.2（reader.css prose-sentence line-height 注释）。
        let lineTarget = (CGFloat(settings.fontSize) / 19.0) * 34 * CGFloat(settings.lineHeight)
        let lineSpacing = max(0, lineTarget - nsFont.pointSize * 1.2)
        ReaderProseText(
            pieces: pieces,
            style: ReaderProseText.Style(
                font: nsFont,
                lineSpacing: lineSpacing,
                textColor: NSColor(palette.text),
                accent: NSColor(palette.accent),
                accentSoft: NSColor(palette.accentSoft),
                err: NSColor(palette.err),
                chunkUnderline: NSColor(palette.accent),
                knownUnderline: NSColor(palette.knownColor),
                clauseIndigo: NSColor(palette.clauseIndigo),
                clauseIndigoSoft: NSColor(palette.clauseIndigoSoft),
                dropCapFont: Self.dropCapFont
            ),
            marks: absoluteMarks,
            assessMarks: absoluteAssessMarks,
            spotlight: spotlight,
            hoveredClause: vm.hoveredClause,
            dropCap: isFirstBlock,
            onSelection: { idx, text in vm.lookup(query: text, sentenceIdx: idx) },
            onWordClick: { idx, word in vm.lookup(query: word, sentenceIdx: idx) },
            onChunkClick: { idx, chunk in vm.openChunkCard(chunk: chunk, sentenceIdx: idx) },
            onClickSentence: { idx in vm.jumpTo(idx: idx) },
            onSentenceFrames: { frames in localFrames = frames }
        )
        .background(
            GeometryReader { geo in
                Color.clear.preference(
                    key: RowFramesKey.self,
                    value: localFrames.mapValues { $0 + geo.frame(in: .named("readerScroll")).minY }
                )
            }
        )
    }

    /// 词块/生词再现跨度（拼接坐标）。
    private var absoluteMarks: [ReaderSentenceText.SpanMark] {
        let settings = vm.effectiveSettings
        let knownIds = settings.showVocabMarks ? vm.knownIds : []
        var result: [ReaderSentenceText.SpanMark] = []
        for piece in pieces {
            guard let s = article.sentences[safe: piece.idx] else { continue }
            let spans = buildSentenceSpans(
                s.en,
                settings.chunkHighlight ? s.chunks : nil,
                knownIds: knownIds
            )
            result.append(contentsOf: spans.map { span in
                ReaderSentenceText.SpanMark(
                    start: span.start + piece.start,
                    end: span.end + piece.start,
                    kind: span.kind,
                    chunk: span.chunk
                )
            })
        }
        return result
    }

    /// 跟读评测词着色：只对当前句生效，偏移折算到拼接坐标。
    private var absoluteAssessMarks: [WordMark]? {
        guard let piece = pieces.first(where: { $0.idx == vm.activeSentenceIdx }) else { return nil }
        let marks = vm.assess.state.marks
        guard !marks.isEmpty else { return nil }
        return marks.map { mark in
            WordMark(start: mark.start + piece.start, end: mark.end + piece.start, quality: mark.quality, score: mark.score)
        }
    }
}

/// 行间折叠卡（.interlinear-fold）：当前句的译文 + 四动作操作条。
private struct InterlinearFoldCard: View {
    @ObservedObject var vm: ReaderViewModel
    let pair: SentencePair
    let editing: Bool
    @Binding var editDraft: String
    let onStartEdit: () -> Void
    let onCancelEdit: () -> Void
    let onCommitEdit: () -> Void
    @Environment(\.readerPalette) private var palette

    var body: some View {
        let settings = vm.effectiveSettings
        let maskOn = settings.maskTranslation
        // 仅英文：折叠卡的译文展示隐藏（状态行与操作条保留）。
        let hideZh = settings.contrastMode == .en
        let foldMasked = maskOn && pair.zh != nil && pair.zhState != .failed && !editing
            && !(pair.revealed == true || vm.peekAll)
        VStack(alignment: .leading, spacing: 8) {
            if editing {
                TranslationEditorView(
                    editDraft: $editDraft,
                    fontPair: settings.fontPair,
                    onCancel: onCancelEdit,
                    onCommit: onCommitEdit
                )
            } else if pair.zhState == .failed {
                HStack(spacing: 10) {
                    Text("本段翻译失败")
                        .font(.system(size: 12))
                        .foregroundColor(palette.err)
                    Button("重试本段") { vm.retryParagraph(pair.paragraphIdx) }
                        .buttonStyle(.link)
                        .font(.system(size: 12))
                }
            } else if !hideZh {
                zhBody(maskOn: maskOn, foldMasked: foldMasked)
            }
            Rectangle().fill(palette.glassBorder).frame(height: 1)
            actionsRow
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 12)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(palette.glassSurface)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(palette.glassBorderStrong, lineWidth: 1)
        )
        .shadow(color: palette.shadowPill, radius: 10, y: 4)
        .padding(.top, 12)
        .padding(.bottom, 22)
        .transition(.opacity.combined(with: .move(edge: .top)))
    }

    @ViewBuilder
    private func zhBody(maskOn: Bool, foldMasked: Bool) -> some View {
        let cnFont = readerFont(14, pair: vm.effectiveSettings.fontPair)
        if let zh = pair.zh, pair.zhState != .pending {
            Text(zh)
                .font(cnFont)
                .foregroundColor(palette.textSecondary)
                .lineSpacing(5)
                .blur(radius: foldMasked ? 5 : 0)
                .opacity(foldMasked ? 0.8 : 1)
                .contentShape(Rectangle())
                .onTapGesture {
                    guard maskOn else { return }
                    if foldMasked { vm.reveal(pair.idx) } else { vm.mask(pair.idx) }
                }
                .help(maskOn ? (foldMasked ? "点按显示译文" : "点按重新遮住") : "")
        } else if pair.zhState == .pending {
            if let zh = pair.zh {
                Text(zh)
                    .font(cnFont)
                    .foregroundColor(palette.textSecondary.opacity(0.75))
                    .lineSpacing(5)
            } else if vm.translating != nil {
                SkeletonLine(width: 160)
            } else {
                Text("译文待生成")
                    .font(.system(size: 12))
                    .foregroundColor(palette.textTertiary)
            }
        }
    }

    /// 操作条四动作：朗读本句（读完自动停）/ 句子解析 / 用这句练口语 → / 编辑译文。
    private var actionsRow: some View {
        HStack(spacing: 16) {
            TextActionButton(text: "朗读本句", icon: ReaderIcons.speaker, palette: palette, help: speakHelp) {
                vm.speakSentenceOnce(pair.idx)
            }
            TextActionButton(text: "句子解析", palette: palette, help: "在右侧解析这句的主干与结构") {
                vm.openXray(idx: pair.idx)
            }
            TextActionButton(text: "用这句练口语 →", icon: "mic", palette: palette, help: "带着这句去口语陪练") {
                vm.practiceSentence(idx: pair.idx)
            }
            if pair.zh != nil, pair.zhState != .pending, !editing {
                TextActionButton(text: "编辑译文", icon: ReaderIcons.edit, palette: palette, help: "手改译文") {
                    onStartEdit()
                }
            }
            Spacer(minLength: 0)
        }
        .font(.system(size: 12))
    }

    private var speakHelp: String {
        vm.playbackPlaying && pair.idx == vm.activeSentenceIdx
            ? "停止朗读（Space / 播放条的 ⏸ 也可以）"
            : "朗读这一句（读完自动停，不会连读下去）"
    }
}

/// 手改译文编辑器（折叠卡与对照行共用：⌘↩ 保存 · Esc 取消）。
struct TranslationEditorView: View {
    @Binding var editDraft: String
    let fontPair: ReaderFontPair
    let onCancel: () -> Void
    let onCommit: () -> Void
    @Environment(\.readerPalette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            TextEditor(text: $editDraft)
                .font(readerFont(14, pair: fontPair))
                .frame(minHeight: 48)
                .scrollContentBackground(.hidden)
                .padding(4)
                .background(palette.surfaceAlt)
                .cornerRadius(6)
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(palette.accent.opacity(0.5)))
            HStack {
                Text("⌘↩ 保存 · Esc 取消")
                    .font(.system(size: 11))
                    .foregroundColor(palette.textTertiary)
                Spacer()
                Button("取消") { onCancel() }.controlSize(.small)
                Button("保存") { onCommit() }
                    .controlSize(.small)
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(editDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
    }
}

// MARK: - 空态

struct EmptyStateView: View {
    let onImport: () -> Void
    @Environment(\.readerPalette) private var palette

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: ReaderIcons.book)
                .font(.system(size: 26))
                .foregroundColor(palette.accent)
            Text("把文章搬进阅读室")
                .font(.system(size: 15, weight: .semibold))
                .foregroundColor(palette.text)
            Text("在任意应用选中文字 → 浮窗弹出 → 点「发送到阅读室」；或直接粘贴导入。")
                .font(.system(size: 12.5))
                .foregroundColor(palette.textSecondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 380)
            Button("粘贴导入文章", action: onImport)
                .controlSize(.regular)
                .padding(.top, 6)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - 右栏透镜卡（v0.8：句子解析 / 查词 双 Tab，常驻）

/// spatial-lens-card 的 Mac 对应物：常驻右栏，22 圆角玻璃卡；「句子解析 /
/// 查词」双 Tab——解析请求切 xray、查词动作切 lex、关闭查词结果回落 xray
///（DictColumn.tsx lensMode 规则）。数据只对得上它所属的那一句：光标移走
/// 就回到「解析这一句」入口。
struct DictColumnView: View {
    @ObservedObject var vm: ReaderViewModel
    @Environment(\.readerPalette) private var palette

    private var activeIdx: Int { vm.activeSentenceIdx }

    /// 光标已移走（或未解析）→ nil → 入口态。
    private var xrayData: SentenceXray? {
        guard let state = vm.xray, state.sentenceIdx == activeIdx, state.status == .ready else { return nil }
        return state.data
    }

    private var xrayFailed: Bool {
        vm.xray?.sentenceIdx == activeIdx && vm.xray?.status == .error
    }

    /// 解析进行中（请求属于哪句就报哪句，Windows xrayBusy 同口径）。
    private var xrayBusy: Bool { vm.xray?.status == .loading }

    private var busyIdx: Int { vm.xray?.sentenceIdx ?? activeIdx }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            lensHeader
            Rectangle().fill(palette.glassBorder).frame(height: 1)
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if vm.lensTab == .xray {
                        xrayBody
                    } else {
                        lexBody
                    }
                }
                .padding(.horizontal, 18)
                .padding(.vertical, 16)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(maxHeight: .infinity, alignment: .top)
        .background(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .fill(palette.glassSurface)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .strokeBorder(palette.glassBorderStrong, lineWidth: 1)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .strokeBorder(
                    LinearGradient(colors: [palette.glassHighlight, .clear], startPoint: .top, endPoint: .center),
                    lineWidth: 1
                )
                .padding(1)
        )
        .shadow(color: palette.shadowSpatial, radius: 20, y: 10)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("句子解析与查词")
    }

    // MARK: 卡头（双 Tab + 句码 + 关闭）

    private var lensHeader: some View {
        HStack(spacing: 8) {
            HStack(spacing: 2) {
                lensTabButton("句子解析", tab: .xray)
                lensTabButton("查词", tab: .lex)
            }
            .padding(3)
            .background(Capsule().fill(palette.background))
            .overlay(Capsule().strokeBorder(palette.glassBorder, lineWidth: 1))
            Spacer(minLength: 0)
            Text("第 \(activeIdx + 1) 句")
                .font(.system(size: 11, design: .monospaced))
                .monospacedDigit()
                .foregroundColor(palette.textTertiary)
            if vm.lensTab == .lex, vm.dict.isOpen {
                Button {
                    vm.closeDictLens()
                } label: {
                    Image(systemName: ReaderIcons.close)
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(palette.textSecondary)
                        .frame(width: 20, height: 20)
                }
                .buttonStyle(.plain)
                .help("关闭查词结果")
                .accessibilityLabel("关闭查词结果")
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    private func lensTabButton(_ title: String, tab: ReaderViewModel.LensTab) -> some View {
        let active = vm.lensTab == tab
        return Button {
            vm.lensTab = tab
        } label: {
            Text(title)
                .font(.system(size: 11.5, weight: active ? .semibold : .medium))
                .foregroundColor(active ? palette.text : palette.textTertiary)
                .padding(.horizontal, 12)
                .frame(height: 24)
                .background(
                    Capsule().fill(active ? palette.glassElevated : Color.clear)
                )
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(active ? [.isSelected] : [])
    }

    // MARK: 句子解析 Tab

    @ViewBuilder
    private var xrayBody: some View {
        if xrayBusy {
            VStack(alignment: .leading, spacing: 8) {
                SkeletonLine(width: 120)
                SkeletonLine(width: 300)
                SkeletonLine(width: 240)
                Text("正在解析第 \(busyIdx + 1) 句…")
                    .font(.system(size: 12.5))
                    .foregroundColor(palette.textTertiary)
                    .padding(.top, 2)
            }
        } else if xrayFailed {
            VStack(alignment: .leading, spacing: 6) {
                Text("句子解析失败，稍后再试。")
                    .font(.system(size: 12.5))
                    .foregroundColor(palette.textSecondary)
                Button("重试") { vm.openXray(idx: activeIdx) }
                    .controlSize(.small)
            }
        } else if let data = xrayData {
            VStack(alignment: .leading, spacing: 6) {
                lensKicker("句子主干", trailing: "第 \(activeIdx + 1) 句")
                Text("“\(data.spine)”")
                    .font(.system(size: 17, weight: .semibold, design: .serif))
                    .lineSpacing(4)
                    .foregroundColor(palette.text)
            }
            .padding(.bottom, 14)
            VStack(alignment: .leading, spacing: 6) {
                lensKicker("结构拆解（悬停可高亮左侧原文）", trailing: nil)
                if data.clauses.isEmpty {
                    Text("这句没有拆出更多结构。")
                        .font(.system(size: 12.5))
                        .foregroundColor(palette.textTertiary)
                } else {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(Array(data.clauses.enumerated()), id: \.offset) { i, clause in
                            XrayClauseRow(
                                clause: clause,
                                indent: CGFloat(i) * 8,
                                palette: palette
                            ) { hovering in
                                if hovering {
                                    vm.hoveredClause = clause.snippet
                                } else if vm.hoveredClause == clause.snippet {
                                    vm.hoveredClause = nil
                                }
                            }
                        }
                    }
                }
            }
            .padding(.bottom, 14)
            VStack(alignment: .leading, spacing: 6) {
                lensKicker("常用句型", trailing: nil)
                if data.pattern.isEmpty {
                    Text("这句没有值得单独提取的句型。")
                        .font(.system(size: 12.5))
                        .foregroundColor(palette.textTertiary)
                } else {
                    Text(data.pattern)
                        .font(.system(size: 11.5, design: .monospaced))
                        .lineSpacing(4)
                        .foregroundColor(palette.text)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(
                            RoundedRectangle(cornerRadius: 10, style: .continuous)
                                .fill(palette.background)
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: 10, style: .continuous)
                                .strokeBorder(palette.glassBorder, lineWidth: 1)
                        )
                }
                TextActionButton(
                    text: "用这个句型练口语 →",
                    palette: palette,
                    help: "带着这句去口语陪练"
                ) {
                    vm.practiceSentence(idx: activeIdx)
                }
                .frame(maxWidth: .infinity)
                .padding(.top, 6)
            }
        } else {
            VStack(alignment: .leading, spacing: 12) {
                Text("第 \(activeIdx + 1) 句还没解析。")
                    .font(.system(size: 12.5))
                    .foregroundColor(palette.textSecondary)
                Button {
                    vm.openXray(idx: activeIdx)
                } label: {
                    Text("解析这一句 →")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(palette.accent)
                        .frame(maxWidth: .infinity)
                        .frame(height: 30)
                        .background(
                            Capsule().fill(palette.accentSoft)
                        )
                }
                .buttonStyle(.plain)
                Text("解析这句的主干、结构拆解与常用句型，拆解悬停可高亮左侧原文。")
                    .font(.system(size: 11.5))
                    .foregroundColor(palette.textTertiary)
                    .lineSpacing(4)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func lensKicker(_ title: String, trailing: String?) -> some View {
        HStack {
            Text(title)
                .font(.system(size: 11.5, weight: .semibold))
                .foregroundColor(palette.textTertiary)
            Spacer(minLength: 0)
            if let trailing {
                Text(trailing)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(palette.textTertiary)
            }
        }
    }

    // MARK: 查词 Tab（沿用原词典栏内容）

    @ViewBuilder
    private var lexBody: some View {
        switch vm.dict {
        case .closed:
            Text("单击正文里的单词、划选短语，或点词块下划线，这里出词条。")
                .font(.system(size: 12.5))
                .foregroundColor(palette.textTertiary)
                .lineSpacing(5)
                .fixedSize(horizontal: false, vertical: true)
        case .loading(let query, _):
            Text(query)
                .font(readerFont(20, .semibold, pair: vm.effectiveSettings.fontPair))
                .foregroundColor(palette.text)
            SkeletonLine(width: 120)
            SkeletonLine(width: 260)
            SkeletonLine(width: 220)
        case .notAWord(let query, _):
            Text("「\(query)」不像一个词条——试试划选更短的词组，或单击单个单词。")
                .font(.system(size: 12.5))
                .foregroundColor(palette.textSecondary)
                .lineSpacing(5)
        case .error(_, _, let message):
            VStack(alignment: .leading, spacing: 6) {
                Text("查询失败：\(message)")
                    .font(.system(size: 12.5))
                    .foregroundColor(palette.err)
                Button("关闭") { vm.closeDictLens() }
                    .controlSize(.small)
            }
        case .ready(_, let entry, let sentenceIdx):
            entryBody(entry: entry, sentenceIdx: sentenceIdx)
        case .chunkCard(let chunk, let sentenceIdx):
            chunkBody(chunk: chunk, sentenceIdx: sentenceIdx)
        }
    }

    private var lexHead: some View {
        HStack(alignment: .top, spacing: 8) {
            VStack(alignment: .leading, spacing: 4) {
                Text(headWord)
                    .font(readerFont(21, .semibold, pair: vm.effectiveSettings.fontPair))
                    .foregroundColor(palette.text)
                if case let .ready(_, entry, _) = vm.dict, let phonetic = entry.phonetic {
                    Text("/\(phonetic.trimmingCharacters(in: CharacterSet(charactersIn: "/")))/")
                        .font(.system(size: 12))
                        .foregroundColor(palette.textTertiary)
                }
                if case let .chunkCard(chunk, _) = vm.dict {
                    Text(chunk.chunkType.label)
                        .font(.system(size: 10, weight: .bold))
                        .foregroundColor(palette.knownColor)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(palette.knownColor.opacity(0.12))
                        .clipShape(Capsule())
                }
            }
            Spacer()
            Button {
                vm.speakWord(headWord)
            } label: {
                Image(systemName: ReaderIcons.speaker).font(.system(size: 11))
            }
            .buttonStyle(.plain)
            .foregroundColor(palette.textSecondary)
            .help("发音")
        }
    }

    private var headWord: String {
        switch vm.dict {
        case .closed: return ""
        case .loading(let q, _), .notAWord(let q, _), .error(let q, _, _): return q
        case .ready(let q, _, _): return q
        case .chunkCard(let chunk, _): return chunk.text
        }
    }

    @ViewBuilder
    private func chunkBody(chunk: SentenceChunk, sentenceIdx: Int) -> some View {
        lexHead
        sectionTitle("释义")
        Text(chunk.gloss)
            .font(.system(size: 13))
            .foregroundColor(palette.text)
        if let pattern = chunk.pattern {
            sectionTitle("记法")
            Text(pattern)
                .font(.system(size: 13, design: .serif))
                .foregroundColor(palette.textSecondary)
        }
        if let trap = chunk.trap {
            sectionTitle("直译陷阱")
            Text(trap)
                .font(.system(size: 12.5))
                .foregroundColor(palette.err)
        }
        sectionTitle("原句")
        sourceCard(sentenceIdx: sentenceIdx)
        HStack(spacing: 8) {
            Button {
                vm.addCurrentDictVocab()
            } label: {
                Label(vm.isInVocab ? "已在生词本" : "收藏词块", systemImage: ReaderIcons.starFill)
                    .font(.system(size: 12))
            }
            .controlSize(.small)
            .buttonStyle(.borderedProminent)
            .disabled(vm.isInVocab)
            Button {
                vm.lookup(query: chunk.text, sentenceIdx: sentenceIdx)
            } label: {
                Text("详查词典").font(.system(size: 12))
            }
            .controlSize(.small)
            .help("查完整词条（音标、多义项、搭配）")
        }
    }

    @ViewBuilder
    private func entryBody(entry: ReaderDictEntry, sentenceIdx: Int) -> some View {
        lexHead
        sectionTitle("释义")
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(entry.senses.enumerated()), id: \.offset) { _, sense in
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    if !sense.pos.isEmpty {
                        Text(sense.pos)
                            .font(.system(size: 11, weight: .medium))
                            .foregroundColor(palette.accent)
                    }
                    Text(sense.cn)
                        .font(.system(size: 13))
                        .foregroundColor(palette.text)
                }
            }
        }

        sourceCard(sentenceIdx: sentenceIdx)

        if let collocations = entry.collocations, !collocations.isEmpty {
            sectionTitle("常用搭配")
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(collocations.enumerated()), id: \.offset) { _, coll in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(coll.en)
                            .font(.system(size: 12.5, weight: .medium))
                            .foregroundColor(palette.text)
                        Text(coll.cn)
                            .font(.system(size: 11.5))
                            .foregroundColor(palette.textTertiary)
                        Spacer()
                        let saved = vm.knownIds.contains(normalizeWordKey(coll.en))
                        Button {
                            vm.addCollocationVocab(coll, sentenceIdx: sentenceIdx)
                        } label: {
                            Image(systemName: saved ? ReaderIcons.starFill : ReaderIcons.star)
                                .font(.system(size: 11))
                        }
                        .buttonStyle(.plain)
                        .disabled(saved)
                        .foregroundColor(saved ? palette.warn : palette.textTertiary)
                        .help(saved ? "已在生词本" : "收藏为词块")
                    }
                }
            }
        }

        if let forms = entry.forms, !forms.isEmpty {
            sectionTitle("词形变化")
            Text(forms.joined(separator: " · "))
                .font(.system(size: 12))
                .foregroundColor(palette.textSecondary)
        }

        HStack(spacing: 8) {
            Button {
                vm.addCurrentDictVocab()
            } label: {
                Label(vm.isInVocab ? "已在生词本" : "加入生词本", systemImage: ReaderIcons.starFill)
                    .font(.system(size: 12))
            }
            .controlSize(.small)
            .buttonStyle(.borderedProminent)
            .disabled(vm.isInVocab)
            Button {
                vm.copyDictEntry()
            } label: {
                Label("复制", systemImage: ReaderIcons.copy)
                    .font(.system(size: 12))
            }
            .controlSize(.small)
        }
    }

    private func sourceCard(sentenceIdx: Int) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            sectionTitle("原句")
            Button {
                vm.jumpTo(idx: sentenceIdx)
            } label: {
                VStack(alignment: .leading, spacing: 4) {
                    Text(vm.article?.sentences[safe: sentenceIdx]?.en ?? "")
                        .font(.system(size: 12))
                        .foregroundColor(palette.textSecondary)
                        .multilineTextAlignment(.leading)
                    Label("第 \(sentenceIdx + 1) 句 · 点击定位", systemImage: ReaderIcons.locate)
                        .font(.system(size: 10.5))
                        .foregroundColor(palette.accent)
                }
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(palette.surfaceAlt)
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }

    private func sectionTitle(_ title: String) -> some View {
        Text(title)
            .font(.system(size: 11, weight: .semibold))
            .foregroundColor(palette.textTertiary)
    }
}

/// 结构拆解条目（.clause-step-item）：tag 主色 / snippet 衬线 / desc 弱墨；
/// 悬停浮起并右移 2px，回标左侧原文片段。
private struct XrayClauseRow: View {
    let clause: XrayClause
    let indent: CGFloat
    let palette: ReaderPalette
    let onHover: (Bool) -> Void
    @State private var hover = false

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(clause.tag)
                .font(.system(size: 11, weight: .semibold))
                .foregroundColor(palette.accent)
            Text(clause.snippet)
                .font(.system(size: 14.5, weight: .semibold, design: .serif))
                .foregroundColor(palette.text)
                .fixedSize(horizontal: false, vertical: true)
            Text(clause.desc)
                .font(.system(size: 12))
                .foregroundColor(palette.textTertiary)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(hover ? palette.glassElevated : Color.clear)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(hover ? palette.glassBorderStrong : Color.clear, lineWidth: 1)
        )
        .padding(.leading, indent)
        .offset(x: hover ? 2 : 0)
        .contentShape(Rectangle())
        .onHover { h in
            withAnimation(ReaderMotion.hover) { hover = h }
            onHover(h)
        }
        .help("悬停高亮左侧原文中的「\(clause.snippet)」")
    }
}


// MARK: - 设置抽屉

struct ReaderSettingsDrawer: View {
    @ObservedObject var vm: ReaderViewModel
    @Environment(\.readerPalette) private var palette
    /// 系统输入设备列表（onAppear 时枚举一次，对齐 Windows 挂载时 listMicDevices）。
    @State private var micDevices: [(uid: String, name: String)] = []

    var body: some View {
        let settings = vm.effectiveSettings
        ZStack(alignment: .trailing) {
            Color.black.opacity(0.32)
                .contentShape(Rectangle())
                .onTapGesture { vm.settingsDrawerShown = false }
            HStack {
                Spacer(minLength: 0)
                VStack(alignment: .leading, spacing: 0) {
                    HStack {
                        Text("阅读设置").font(.system(size: 14, weight: .semibold))
                        Spacer()
                        Button {
                            vm.settingsDrawerShown = false
                        } label: {
                            Image(systemName: ReaderIcons.close).font(.system(size: 11, weight: .semibold))
                        }
                        .buttonStyle(.plain)
                    }
                    .padding(14)
                    Divider().opacity(0.5)
                    ScrollView {
                        VStack(alignment: .leading, spacing: 14) {
                            groupTitle("版式")
                            segmentedRow("对照模式", contrastOptions, selection: settings.contrastMode) { value in
                                vm.patchSettings { $0.contrastMode = value }
                            }
                            segmentedRow("遮罩样式", maskStyleOptions, selection: settings.maskStyle, disabled: !settings.maskTranslation) { value in
                                vm.patchSettings { $0.maskStyle = value }
                            }
                            stepperRow("正文字号", value: settings.fontSize, range: readerFontSizeMin...readerFontSizeMax) { value in
                                vm.patchSettings { $0.fontSize = value }
                            }
                            sliderRow("行距", value: settings.lineHeight, range: 1...2.4, step: 0.05, format: String(format: "%.2f×", settings.lineHeight)) { value in
                                vm.patchSettings { $0.lineHeight = value }
                            }
                            pickerRow("正文字体", fontOptions, selection: settings.fontPair) { value in
                                vm.patchSettings { $0.fontPair = value }
                            }

                            groupTitle("词块")
                            HStack {
                                rowLabel("自动标注词组")
                                Toggle("", isOn: Binding(
                                    get: { settings.chunkHighlight },
                                    set: { value in vm.patchSettings { $0.chunkHighlight = value } }
                                ))
                                .toggleStyle(.switch)
                                .labelsHidden()
                            }
                            .help("新文章翻译完成后自动标注值得学的词组（会额外消耗接口 token），正文里以蓝色虚线下划线显示，点击看释义并可收藏")
                            HStack {
                                rowLabel("生词再现标记")
                                Toggle("", isOn: Binding(
                                    get: { settings.showVocabMarks },
                                    set: { value in vm.patchSettings { $0.showVocabMarks = value } }
                                ))
                                .toggleStyle(.switch)
                                .labelsHidden()
                            }
                            .help("已收藏的词/词块在正文再次出现时用绿色点线标记，点击可查看")
                            if vm.article?.chunkState != nil {
                                HStack {
                                    rowLabel("重新标注本篇")
                                    Button("重新标注") { vm.reannotateChunks() }
                                        .controlSize(.small)
                                }
                                .help("清空本篇已有标注，重新跑一遍词组标注")
                            }

                            groupTitle("朗读")
                            HStack {
                                rowLabel("引擎")
                                Picker("引擎", selection: Binding(
                                    get: { settings.ttsProvider },
                                    set: { value in vm.patchSettings { $0.ttsProvider = value } }
                                )) {
                                    ForEach(TtsProvider.allCases, id: \.self) { provider in
                                        Text(provider.label).tag(provider)
                                    }
                                }
                                .labelsHidden()
                                .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .help("Edge 在线 = 微软神经音色（免费、无需凭据，默认）；讯飞在线 = 云音色需凭据；本地 = 系统语音（离线可用）")
                            if settings.ttsProvider == .xfyun {
                                VStack(alignment: .leading, spacing: 6) {
                                    if !XfyunCredentialsStore.shared.isComplete(.tts) {
                                        HStack(spacing: 5) {
                                            Image(systemName: "exclamationmark.triangle.fill")
                                                .font(.system(size: 10))
                                                .foregroundColor(palette.warn)
                                            Text("讯飞合成凭据未配置，朗读将回落系统语音")
                                                .font(.system(size: 10.5))
                                                .foregroundColor(palette.warn)
                                        }
                                    }
                                    cloudVoiceField(label: "中文音色", text: settings.cloudVoice, placeholder: "xiaoyan") { value in
                                        vm.patchSettings { $0.cloudVoice = value }
                                    }
                                    cloudVoiceField(label: "英文音色", text: settings.cloudVoiceEn, placeholder: "catherine") { value in
                                        vm.patchSettings { $0.cloudVoiceEn = value }
                                    }
                                }
                            } else if settings.ttsProvider == .edge {
                                VStack(alignment: .leading, spacing: 6) {
                                    edgeVoiceField(label: "中文音色", text: settings.edgeVoiceZh, placeholder: EdgeTts.defaultVoice) { value in
                                        vm.patchSettings { $0.edgeVoiceZh = value }
                                    }
                                    edgeVoiceField(label: "英文音色", text: settings.edgeVoiceEn, placeholder: EdgeTts.defaultVoiceEn) { value in
                                        vm.patchSettings { $0.edgeVoiceEn = value }
                                    }
                                    HStack {
                                        rowLabel("服务说明")
                                        Text("免费 · 无需凭据 · 需联网")
                                            .font(.system(size: 11.5))
                                            .foregroundColor(palette.textSecondary)
                                            .frame(maxWidth: .infinity, alignment: .leading)
                                    }
                                    .help("Edge 在线合成为微软「大声朗读」同源服务，免费且无需账号；属非官方接口，偶发不可用时朗读自动回落系统语音，也可切回讯飞或本地")
                                }
                            } else {
                                voiceRow(selection: settings.voice)
                            }
                            sliderRow("语速", value: settings.rate, range: readerRateMin...readerRateMax, step: 0.05, format: String(format: "%.2f×", settings.rate)) { value in
                                vm.patchSettings { $0.rate = value }
                            }
                            sliderRow("每句停顿", value: settings.sentencePauseMs, range: 0...2000, step: 100, format: String(format: "%.1fs", settings.sentencePauseMs / 1000)) { value in
                                vm.patchSettings { $0.sentencePauseMs = value }
                            }
                            HStack {
                                rowLabel("跟读模式")
                                Toggle("", isOn: Binding(
                                    get: { settings.shadowingMode },
                                    set: { value in vm.patchSettings { $0.shadowingMode = value } }
                                ))
                                .toggleStyle(.switch)
                                .labelsHidden()
                            }
                            if settings.shadowingMode {
                                VStack(alignment: .leading, spacing: 6) {
                                    HStack {
                                        rowLabel("跟读评测")
                                        Toggle("", isOn: Binding(
                                            get: { settings.shadowingAssess },
                                            set: { value in vm.patchSettings { $0.shadowingAssess = value } }
                                        ))
                                        .toggleStyle(.switch)
                                        .labelsHidden()
                                    }
                                    .help("跟读句送讯飞语音评测，达到阈值才放行（凭据在设置 → 语音）")
                                    if settings.shadowingAssess {
                                        sliderRow("过关阈值", value: settings.shadowingPassScore, range: readerAssessPassMin...readerAssessPassMax, step: 0.1, format: String(format: "%.1f 分", settings.shadowingPassScore)) { value in
                                            vm.patchSettings { $0.shadowingPassScore = value }
                                        }
                                        sliderRow("静音断句", value: settings.shadowingSilenceMs, range: readerAssessSilenceMin...readerAssessSilenceMax, step: 100, format: String(format: "%.1fs", settings.shadowingSilenceMs / 1000)) { value in
                                            vm.patchSettings { $0.shadowingSilenceMs = value }
                                        }
                                        HStack {
                                            rowLabel("读完自动开麦")
                                            Toggle("", isOn: Binding(
                                                get: { settings.shadowingAutoMic },
                                                set: { value in vm.patchSettings { $0.shadowingAutoMic = value } }
                                            ))
                                            .toggleStyle(.switch)
                                            .labelsHidden()
                                        }
                                    }
                                }
                            }

                            // 麦克风选择：无条件显示（不嵌进跟读开关块，Windows 该行也在条件块外）。
                            // 跟读评测 / 口语陪练 / 影子跟读生效；录音直译恒用默认。
                            HStack {
                                rowLabel("麦克风")
                                Picker("麦克风", selection: Binding(
                                    get: { MicDevicePreference.savedUID },
                                    set: { MicDevicePreference.save($0) }
                                )) {
                                    Text("系统默认").tag("")
                                    ForEach(micDevices, id: \.uid) { device in
                                        Text(device.name).tag(device.uid)
                                    }
                                }
                                .labelsHidden()
                                .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .help("跟读录音用的麦克风；录不出声音时优先换一个（默认可能选到虚拟声卡）")

                            groupTitle("提醒")
                            ReminderSectionView()

                            groupTitle("主题")
                            HStack(spacing: 8) {
                                ForEach(ReaderTheme.allCases, id: \.self) { theme in
                                    themeButton(theme: theme, selected: settings.theme == theme)
                                }
                            }
                        }
                        .padding(14)
                    }
                    Divider().opacity(0.5)
                    HStack {
                        Button("恢复默认") { vm.resetSettings() }
                            .controlSize(.small)
                        Spacer()
                        Button("完成") { vm.settingsDrawerShown = false }
                            .controlSize(.small)
                            .buttonStyle(.borderedProminent)
                            .keyboardShortcut(.defaultAction)
                    }
                    .padding(14)
                }
                .frame(width: 340)
                .background(palette.surface)
            }
        }
        .onAppear {
            // 挂载时枚举一次系统输入设备（仅 CoreAudio 枚举，不触发麦克风权限弹窗）。
            micDevices = MicRecorder.availableMicDevices().map { (uid: $0.uid, name: $0.name) }
        }
    }

    private var contrastOptions: [(ContrastMode, String)] {
        ContrastMode.allCases.map { ($0, $0.label) }
    }
    private var maskStyleOptions: [(MaskStyle, String)] {
        MaskStyle.allCases.map { ($0, $0.label) }
    }
    private var fontOptions: [(ReaderFontPair, String)] {
        ReaderFontPair.allCases.map { ($0, $0.label) }
    }

    private func themeButton(theme: ReaderTheme, selected: Bool) -> some View {
        let p = ReaderPalette.palette(for: theme)
        return Button {
            vm.patchSettings { $0.theme = theme }
        } label: {
            VStack(spacing: 4) {
                RoundedRectangle(cornerRadius: 5)
                    .fill(p.background)
                    .overlay(
                        Text("Aa")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundColor(p.text)
                    )
                    .frame(height: 34)
                    .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(palette.border))
                Text(theme.label).font(.system(size: 11))
            }
            .padding(6)
            .frame(maxWidth: .infinity)
            .background(selected ? palette.accent.opacity(0.15) : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
    }

    @State private var voiceCatalog: [ReaderVoiceInfo] = []


    private func cloudVoiceField(label: String, text: String, placeholder: String, onCommit: @escaping (String) -> Void) -> some View {
        HStack {
            rowLabel(label)
            TextField(placeholder, text: Binding(
                get: { text },
                set: { value in onCommit(value) }
            ))
            .textFieldStyle(.roundedBorder)
            .font(.system(size: 11.5))
            .frame(maxWidth: .infinity)
        }
        .help("讯飞发音人 vcn；建议：catherine（英）、xiaoyan（中）、x4_xiaoyan、aisjiuxu（男）、aisbabyxu（童）")
    }

    /// Edge 音色输入框 + 建议菜单（Menu 弹层替代 Windows 的 input datalist）。
    private func edgeVoiceField(label: String, text: String, placeholder: String, onCommit: @escaping (String) -> Void) -> some View {
        HStack {
            rowLabel(label)
            TextField(placeholder, text: Binding(
                get: { text },
                set: { value in onCommit(value) }
            ))
            .textFieldStyle(.roundedBorder)
            .font(.system(size: 11.5))
            .frame(maxWidth: .infinity)
            Menu {
                ForEach(EdgeTts.voiceSuggestions, id: \.voice) { suggestion in
                    Button(suggestion.label) { onCommit(suggestion.voice) }
                }
            } label: {
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundColor(palette.textSecondary)
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
        }
        .help("Edge 音色 ShortName（微软神经音色）；留空 = 默认音色（中文晓晓 / 英文 Ava），男声推荐 AndrewNeural。已播句子进缓存（内存+磁盘），重听不再请求网络")
    }

    private func voiceRow(selection: String) -> some View {
        HStack {
            rowLabel("音色")
            Picker("音色", selection: Binding(
                get: { selection },
                set: { value in vm.patchSettings { $0.voice = value } }
            )) {
                Text("系统默认").tag("")
                ForEach(voiceCatalog, id: \.name) { voice in
                    Text(voice.chinese ? "\(voice.name)（中文）" : voice.name).tag(voice.name)
                }
            }
            .labelsHidden()
            .frame(maxWidth: .infinity, alignment: .leading)
            .onAppear { voiceCatalog = ReaderVoiceCatalog.voices() }
        }
    }

    private func groupTitle(_ title: String) -> some View {
        Text(title)
            .font(.system(size: 11, weight: .bold))
            .foregroundColor(palette.textTertiary)
            .padding(.top, 4)
    }

    private func rowLabel(_ label: String) -> some View {
        Text(label)
            .font(.system(size: 12.5))
            .foregroundColor(palette.text)
            .frame(width: 90, alignment: .leading)
    }

    private func segmentedRow<T: Hashable>(
        _ label: String,
        _ options: [(T, String)],
        selection: T,
        disabled: Bool = false,
        onChange: @escaping (T) -> Void
    ) -> some View {
        HStack {
            rowLabel(label)
            Picker(label, selection: Binding(get: { selection }, set: { onChange($0) })) {
                ForEach(options, id: \.0) { option in
                    Text(option.1).tag(option.0)
                }
            }
            .pickerStyle(.segmented)
            .disabled(disabled)
            .labelsHidden()
        }
    }

    private func pickerRow<T: Hashable>(
        _ label: String,
        _ options: [(T, String)],
        selection: T,
        onChange: @escaping (T) -> Void
    ) -> some View {
        HStack {
            rowLabel(label)
            Picker(label, selection: Binding(get: { selection }, set: { onChange($0) })) {
                ForEach(options, id: \.0) { option in
                    Text(option.1).tag(option.0)
                }
            }
            .labelsHidden()
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func stepperRow(
        _ label: String,
        value: Int,
        range: ClosedRange<Int>,
        onChange: @escaping (Int) -> Void
    ) -> some View {
        HStack {
            rowLabel(label)
            Stepper("\(value)", value: Binding(get: { value }, set: { onChange($0) }), in: range)
                .font(.system(size: 12.5))
        }
    }

    private func sliderRow(
        _ label: String,
        value: Double,
        range: ClosedRange<Double>,
        step: Double,
        format: String,
        onChange: @escaping (Double) -> Void
    ) -> some View {
        HStack {
            rowLabel(label)
            Slider(value: Binding(get: { value }, set: { onChange($0) }), in: range, step: step)
            Text(format)
                .font(.system(size: 11))
                .foregroundColor(palette.textTertiary)
                .frame(width: 44, alignment: .trailing)
        }
    }
}

// MARK: - Toast / 复习占位

struct ReaderToast: View {
    let text: String
    var action: ToastAction?

    var body: some View {
        HStack(spacing: 10) {
            Text(text)
                .font(.system(size: 12.5))
                .foregroundColor(.white)
                .multilineTextAlignment(.leading)
            if let action {
                Button {
                    action.handler()
                } label: {
                    Text(action.title)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(.black)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 3)
                        .background(Color.white.opacity(0.92), in: Capsule())
                }
                .buttonStyle(.plain)
                .help(action.title)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(Color.black.opacity(0.78))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .padding(.bottom, 56)
        .transition(.opacity)
        .animation(.easeInOut(duration: 0.18), value: text)
    }
}

// MARK: - 工具

extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}

// MARK: - 播放条（屏 A 底部）

let readerRatePresets: [Double] = [0.75, 1, 1.25, 1.5]

struct PlayBarView: View {
    @ObservedObject var vm: ReaderViewModel
    @Environment(\.readerPalette) private var palette
    @State private var hoverIdx: Int?
    /// 拖拽中的目标句（只移动光标/计数，不触发合成；nil = 未在拖拽）。
    @State private var dragIdx: Int?
    /// 播放键 hover（scale 1.05）。
    @State private var orbHover = false
    /// READ-6 键盘滑杆：进度条的键盘焦点（Tab 可达）；同步到 vm.playScrubberFocused，
    /// 聚焦期间 ←/→ ±1、↑/↓ 同义、PageUp/PageDown ±10、Home/End 首尾由
    /// vm.handleKeyDown 接管（PlayBar.tsx:223-257 role=slider 的键盘语义）。
    @FocusState private var scrubberFocused: Bool

    private var total: Int { vm.article?.sentences.count ?? 0 }
    /// 拖拽时进度条/计数跟随手指，不跟 activeSentenceIdx（拖动不打断当前朗读）。
    private var idx: Int { dragIdx ?? vm.activeSentenceIdx }
    private var percent: Double {
        total > 1 ? Double(idx) / Double(total - 1) : 0
    }

    var body: some View {
        // M-02：.floating-sonic-dock——底部居中悬浮胶囊（容器由 ReaderRootView 的
        // overlay 定位 bottom 18），glass-elevated + blur(24) + shadow-spatial +
        // 顶内高光（原型 html:666-682）；播放键 .sonic-play-orb 36pt ink-1 深底。
        HStack(spacing: 14) {
            transport
            progressTrack
                .frame(width: 160)
            countLabel
            HStack(spacing: 8) {
                if vm.shadowingWait, vm.assessActive {
                    AssessStripView(vm: vm, assess: vm.assess)
                } else if vm.shadowingWait {
                    HStack(spacing: 6) {
                        Text("请跟读当前句").font(.system(size: 11.5)).foregroundColor(palette.warn)
                        Button("继续") { vm.continueAfterShadowing() }
                            .controlSize(.small)
                            .buttonStyle(.borderedProminent)
                    }
                } else {
                    rateButton
                }
                viewMenu
                Button {
                    vm.settingsDrawerShown = true
                } label: {
                    Image(systemName: ReaderIcons.gear).font(.system(size: 12))
                }
                .buttonStyle(.plain)
                .foregroundColor(palette.textSecondary)
                .help("阅读设置")
            }
        }
        .padding(.vertical, 7)
        .padding(.leading, 10)
        .padding(.trailing, 14)
        .background(
            Capsule()
                .fill(palette.glassElevated)
                .background(.regularMaterial, in: Capsule())
        )
        .overlay(Capsule().strokeBorder(palette.glassBorderStrong, lineWidth: 1))
        .overlay(
            // inset 0 1px 0 glass-highlight：顶部一道受光高光
            Capsule()
                .strokeBorder(
                    LinearGradient(
                        colors: [palette.glassHighlight, .clear],
                        startPoint: .top, endPoint: .center
                    ),
                    lineWidth: 1
                )
                .padding(1)
        )
        .shadow(color: palette.shadowSpatial, radius: 20, y: 10)
        .shadow(color: palette.shadowSpatial.opacity(0.4), radius: 4, y: 2)
        // 拖拽被打断（应用失活 / 窗口失焦等 pointercancel 等价物）：
        // 只还原光标，不跳转不合成（PlayBar.tsx handlePointerCancel）。
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.willResignActiveNotification)) { _ in
            dragIdx = nil
        }
    }

    private var transport: some View {
        HStack(spacing: 10) {
            Button {
                vm.jumpTo(idx: idx - 1)
            } label: {
                Image(systemName: ReaderIcons.prev).font(.system(size: 13))
            }
            .buttonStyle(.plain)
            .disabled(total == 0 || idx <= 0)
            .foregroundColor(palette.text)
            .help("上一句 (L)")

            playOrb

            Button {
                vm.jumpTo(idx: idx + 1)
            } label: {
                Image(systemName: ReaderIcons.next).font(.system(size: 13))
            }
            .buttonStyle(.plain)
            .disabled(total == 0 || idx >= total - 1)
            .foregroundColor(palette.text)
            .help("下一句 (J)")
        }
    }

    /// .sonic-play-orb：36pt ink-1 深底 + 画布色图标，hover 1.05 升起（150ms）。
    private var playOrb: some View {
        Button {
            vm.togglePlayback()
        } label: {
            Image(systemName: vm.playbackPlaying ? ReaderIcons.pause : ReaderIcons.play)
                .font(.system(size: 14, weight: .semibold))
                .foregroundColor(palette.onInk)
                .frame(width: 36, height: 36)
                .background(Circle().fill(palette.text))
                .clipShape(Circle())
                .scaleEffect(orbHover ? 1.05 : 1)
        }
        .buttonStyle(.plain)
        .disabled(total == 0)
        .onHover { h in
            withAnimation(ReaderMotion.hover) { orbHover = h }
        }
        .help(vm.playbackPlaying ? "暂停 (Space)" : "播放 (Space)")
    }

    /// .dock-scrubber：160pt 宽 4pt 高的极简进度条（保留 mac 已有的句刻度、
    /// 拖拽与悬停预览）；fill 200ms 弹性（--ease-spring），拖拽中即时跟手不弹。
    private var progressTrack: some View {
        GeometryReader { geo in
            let width = geo.size.width
            ZStack(alignment: .leading) {
                Capsule().fill(palette.glassBorderStrong)
                Capsule()
                    .fill(palette.accent)
                    .frame(width: max(0, width * percent))
                    .animation(
                        dragIdx == nil
                            ? .timingCurve(0.16, 1, 0.3, 1, duration: 0.2)
                            : nil,
                        value: percent
                    )
                if total > 1, total <= 40 {
                    ForEach(1..<total, id: \.self) { i in
                        Rectangle()
                            .fill(palette.glassElevated)
                            .frame(width: 1, height: 4)
                            .offset(x: width * CGFloat(i) / CGFloat(total - 1) - 0.5)
                    }
                }
            }
            .frame(height: 4, alignment: .center)
            .contentShape(Rectangle().inset(by: -10))
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        // 拖拽中只更新视觉光标：不打断当前朗读、不发起合成——
                        // 逐句 jumpTo 会把讯飞/Edge 的合成请求烧在拖拽路上
                        //（PlayBar.tsx:126-174 dragIdx 语义，配额保护）。
                        dragIdx = idxFor(x: value.location.x, width: width)
                    }
                    .onEnded { value in
                        let target = idxFor(x: value.location.x, width: width)
                        dragIdx = nil
                        // 松手才真正跳转：拖过一长串句子只触发最后这一句的
                        // 一次跳读（播放中）或一次光标移动（未播放）。
                        if total > 0 {
                            vm.jumpTo(idx: target)
                        }
                    }
            )
            .onContinuousHover { phase in
                switch phase {
                case .active(let location):
                    hoverIdx = idxFor(x: location.x, width: width)
                case .ended:
                    hoverIdx = nil
                @unknown default:
                    break
                }
            }
            .overlay(alignment: .top) {
                if let hoverIdx, dragIdx == nil, total > 0,
                   let preview = vm.article?.sentences[safe: hoverIdx]?.en {
                    Text("第 \(hoverIdx + 1) 句 · \(preview)")
                        .font(.system(size: 10.5))
                        .foregroundColor(palette.text)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(palette.surface)
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                        .shadow(color: .black.opacity(0.18), radius: 4, y: 1)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: 320, alignment: .leading)
                        .offset(x: hoverOffset(x: width * CGFloat(hoverIdx) / CGFloat(max(1, total - 1)), width: width))
                        .offset(y: -30)
                        .allowsHitTesting(false)
                }
            }
        }
        .frame(height: 22)
        .frame(maxWidth: .infinity)
        // READ-6 键盘滑杆：Tab 可聚焦 + 系统焦点环（.focusEffect 的 Capsule 形状
        // 贴合 4pt 轨道；视觉零变更——焦点环是系统材质，不动 M-02 令牌）。
        // 无句子时不可聚焦（对齐 Windows total===0 时 tabIndex=-1）。
        .focusable(total > 0)
        .focused($scrubberFocused)
        .contentShape(.focusEffect, Capsule())
        .onChange(of: scrubberFocused) { focused in
            vm.playScrubberFocused = focused
        }
        // 胶囊离场（切路由/禅模式）不会发 onChange(false)：在 onDisappear 兜底复位，
        // 避免滑杆已消失而方向键仍被劫持为翻句。
        .onDisappear {
            if vm.playScrubberFocused { vm.playScrubberFocused = false }
        }
        // role="slider" 的可读对应物：label/值文本对齐 Windows aria 三件套，
        // VoiceOver 的增减动作映射到 ±1 句（与键盘 ←/→ 同语义）。
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("朗读进度（左右方向键逐句切换）")
        .accessibilityValue(total > 0 ? "第 \(idx + 1) 句，共 \(total) 句" : "暂无句子")
        .accessibilityAdjustableAction { direction in
            switch direction {
            case .increment: vm.jumpTo(idx: idx + 1)
            case .decrement: vm.jumpTo(idx: idx - 1)
            @unknown default: break
            }
        }
    }

    private func idxFor(x: CGFloat, width: CGFloat) -> Int {
        guard total > 0, width > 0 else { return 0 }
        let ratio = min(1, max(0, x / width))
        return min(total - 1, Int((ratio * CGFloat(total - 1)).rounded()))
    }

    private func hoverOffset(x: CGFloat, width: CGFloat) -> CGFloat {
        min(0, max(-(x - 140), -width + 150))
    }

    private var countLabel: some View {
        Group {
            if total > 0 {
                Text("\(idx + 1)")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(palette.accent)
                + Text(" ∕ \(total) 句")
                    .font(.system(size: 12))
                    .foregroundColor(palette.textTertiary)
            } else {
                Text("暂无句子")
                    .font(.system(size: 12))
                    .foregroundColor(palette.textTertiary)
            }
        }
    }

    private var rateButton: some View {
        Button {
            let current = readerRatePresets.firstIndex(of: vm.effectiveSettings.rate) ?? 1
            let next = readerRatePresets[(current + 1) % readerRatePresets.count]
            vm.patchSettings { $0.rate = next }
        } label: {
            Text(rateLabel)
        }
        .buttonStyle(.plain)
        .font(.system(size: 12, weight: .medium).monospacedDigit())
        .foregroundColor(palette.text)
        .help("播放语速（更多档位在阅读设置）")
    }

    private var rateLabel: String {
        var text = String(format: "%.2f", vm.effectiveSettings.rate)
        if text.hasSuffix("0") { text.removeLast() }
        return "\(text)×"
    }

    private var viewMenu: some View {
        let settings = vm.effectiveSettings
        // 对照模式循环（SHELL-8 修复）：旧写法 `firstIndex(of:) ?? 0 + 1` 因 + 的优先级
        // 高于 ?? 恒取当前档自身，点「对照模式」等于没点；改走 ReaderCore 的 (i+1)%n 循环，
        // 菜单项文案显示即将切到的下一档名。
        let nextContrast = settings.contrastMode.next
        return Menu {
            Button("对照模式：\(nextContrast.label)") {
                vm.patchSettings { $0.contrastMode = nextContrast }
            }
            Button("\(settings.maskTranslation ? "✓" : "") 译文遮罩 · 自测") {
                vm.patchSettings { $0.maskTranslation = !$0.maskTranslation }
            }
            Button("\(settings.showProgress ? "✓" : "") 显示阅读进度") {
                vm.patchSettings { $0.showProgress = !$0.showProgress }
            }
            Divider()
            Button("\(settings.zenMode ? "✓" : "") 禅模式 · 隐藏侧栏与播放条") {
                vm.patchSettings { $0.zenMode = !$0.zenMode }
            }
        } label: {
            Text("视图")
                .font(.system(size: 12))
                .foregroundColor(palette.textSecondary)
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
    }
}

// MARK: - 禅模式浮动控制

struct ZenControlsView: View {
    @ObservedObject var vm: ReaderViewModel
    @Environment(\.readerPalette) private var palette

    var body: some View {
        HStack(spacing: 14) {
            Button {
                vm.jumpTo(idx: vm.activeSentenceIdx - 1)
            } label: {
                Image(systemName: ReaderIcons.prev).font(.system(size: 12))
            }
            Button {
                vm.togglePlayback()
            } label: {
                Image(systemName: vm.playbackPlaying ? ReaderIcons.pause : ReaderIcons.play)
                    .font(.system(size: 13))
                    .foregroundColor(.white)
                    .frame(width: 34, height: 34)
                    .background(palette.accent)
                    .clipShape(Circle())
            }
            Button {
                vm.jumpTo(idx: vm.activeSentenceIdx + 1)
            } label: {
                Image(systemName: ReaderIcons.next).font(.system(size: 12))
            }
        }
        .buttonStyle(.plain)
        .foregroundColor(palette.text)
        .padding(.horizontal, 18)
        .padding(.vertical, 10)
        .background(palette.surface.opacity(0.92))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .shadow(color: .black.opacity(0.18), radius: 8, y: 2)
    }
}

// MARK: - 书内目录弹层

/// 书目录弹层（BookTocModal.tsx 的 Mac 对应物）：这本书有哪些章、每章多少词
/// 多少生词，标注当前章，点章即跳。从文章头章节栏「目录」按钮打开。
struct BookTocView: View {
    @ObservedObject var vm: ReaderViewModel
    let book: BookMeta
    @Environment(\.readerPalette) private var palette

    private var currentChapterId: String? { vm.article?.id }

    private var overallPercent: Int {
        Int(bookOverallPercent(book: book).rounded())
    }

    /// 每章已收藏生词数（VocabWord.source.articleId → BookChapterMeta.id 归堆）。
    private var vocabCountByChapter: [String: Int] {
        var counts: [String: Int] = [:]
        for word in vm.vocabWords {
            counts[word.source.articleId, default: 0] += 1
        }
        return counts
    }

    var body: some View {
        ZStack {
            Color.black.opacity(0.32)
                .contentShape(Rectangle())
                .onTapGesture { vm.bookTocShown = false }
            VStack(alignment: .leading, spacing: 0) {
                header
                Divider().opacity(0.5)
                ScrollView {
                    VStack(spacing: 2) {
                        ForEach(Array(book.chapters.enumerated()), id: \.element.id) { idx, chapter in
                            BookTocRow(
                                index: idx + 1,
                                chapter: chapter,
                                vocabCount: vocabCountByChapter[chapter.id] ?? 0,
                                current: chapter.id == currentChapterId,
                                onSelect: { vm.openArticle(id: chapter.id) }
                            )
                        }
                    }
                    .padding(10)
                }
            }
            .frame(width: 480, height: 540)
            .background(palette.surface)
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .shadow(color: .black.opacity(0.22), radius: 18, y: 6)
            .onExitCommand { vm.bookTocShown = false }
        }
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 12) {
            Group {
                if let cover = BookCoverImage.image(fromDataURL: book.cover) {
                    Image(nsImage: cover)
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                } else {
                    Text(String(book.title.prefix(1)).uppercased())
                        .font(.system(size: 20, weight: .bold, design: .serif))
                        .foregroundColor(.white)
                }
            }
            .frame(width: 52, height: 74)
            .background(
                LinearGradient(
                    colors: [Color(hue: 0.08, saturation: 0.55, brightness: 0.82), Color(hue: 0.02, saturation: 0.5, brightness: 0.68)],
                    startPoint: .topLeading, endPoint: .bottomTrailing
                )
            )
            .clipShape(RoundedRectangle(cornerRadius: 6))

            VStack(alignment: .leading, spacing: 5) {
                Text("《\(book.title)》")
                    .font(.system(size: 16, weight: .semibold, design: .serif))
                    .foregroundColor(palette.text)
                    .lineLimit(2)
                Text("\(book.author.map { "\($0) · " } ?? "")\(book.chapters.count) 章 · 总进度 \(overallPercent)%")
                    .font(.system(size: 11.5))
                    .foregroundColor(palette.textSecondary)
                Text("考研词 \(book.radar.kaoyan) · 四级词 \(book.radar.cet4) · 六级词 \(book.radar.cet6)")
                    .font(.system(size: 10.5))
                    .foregroundColor(palette.textTertiary)
            }
            Spacer(minLength: 8)
            Button {
                vm.bookTocShown = false
            } label: {
                Image(systemName: ReaderIcons.close)
                    .font(.system(size: 11, weight: .semibold))
            }
            .buttonStyle(.plain)
            .foregroundColor(palette.textSecondary)
            .help("关闭目录 (Esc)")
        }
        .padding(16)
    }
}

/// 目录里的单章行：序号 + 章名 + 词数/句数/生词数/当前章。
private struct BookTocRow: View {
    let index: Int
    let chapter: BookChapterMeta
    let vocabCount: Int
    let current: Bool
    let onSelect: () -> Void
    @Environment(\.readerPalette) private var palette
    @State private var hover = false

    private var metaText: String {
        var parts = ["\(chapter.wordCount) 词", "\(chapter.sentenceCount) 句"]
        if vocabCount > 0 { parts.append("\(vocabCount) 生词") }
        if current { parts.append("当前章") }
        return parts.joined(separator: " · ")
    }

    var body: some View {
        HStack(spacing: 10) {
            Text("\(index)")
                .font(.system(size: 10.5, weight: .semibold).monospacedDigit())
                .foregroundColor(current ? .white : palette.textTertiary)
                .frame(width: 20, height: 20)
                .background(current ? palette.accent : Color.clear)
                .clipShape(Circle())
            Text(chapter.title)
                .font(.system(size: 12.5, design: .serif))
                .foregroundColor(current ? palette.accent : palette.text)
                .lineLimit(1)
                .truncationMode(.tail)
                .help(chapter.title)
            Spacer(minLength: 8)
            Text(metaText)
                .font(.system(size: 10.5))
                .foregroundColor(palette.textTertiary)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(
            current ? palette.accent.opacity(0.1)
                : (hover ? palette.border.opacity(0.25) : Color.clear)
        )
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .contentShape(Rectangle())
        .onHover { hover = $0 }
        .onTapGesture(perform: onSelect)
    }
}

// MARK: - 章末小结卡

/// 书章读完的小结卡（自然播完末句 / 手动「读完本章」触发）：
/// 本章查词、收录生词、到期词、用时，以及下一章 / 复习本章 / 整理笔记入口。
struct ChapterEndCardView: View {
    @ObservedObject var vm: ReaderViewModel
    let summary: ReaderViewModel.ChapterEndSummary
    @Environment(\.readerPalette) private var palette

    var body: some View {
        ZStack {
            Color.black.opacity(0.4)
                .contentShape(Rectangle())
                .onTapGesture { vm.dismissChapterEnd() }
            VStack(spacing: 14) {
                Text("🎉")
                    .font(.system(size: 30))
                Text("第 \(summary.chapterIdx + 1) 章读完")
                    .font(.system(size: 17, weight: .semibold, design: .serif))
                    .foregroundColor(palette.text)
                Text("《\(summary.bookTitle)》 · \(summary.chapterIdx + 1)/\(summary.chapterCount) 章")
                    .font(.system(size: 12))
                    .foregroundColor(palette.textSecondary)
                HStack(spacing: 16) {
                    stat("查词", "\(summary.lookups) 次")
                    stat("本章收录", "\(summary.collected) 词")
                    stat("本章用时", "\(summary.minutes) 分钟")
                }
                if summary.lastChapter {
                    Text("全书读完，恭喜！这些生词都已在复习闭环里了。")
                        .font(.system(size: 11.5))
                        .foregroundColor(palette.ok)
                        .multilineTextAlignment(.center)
                } else if let nextTitle = summary.nextChapterTitle {
                    Text("下一章：\(nextTitle)")
                        .font(.system(size: 11.5))
                        .foregroundColor(palette.textTertiary)
                        .lineLimit(1)
                }
                if summary.collected > 0 || !summary.dueIds.isEmpty {
                    HStack(spacing: 8) {
                        if summary.collected > 0 {
                            Button {
                                vm.noteChapterWords()
                            } label: {
                                Text("整理本章笔记").font(.system(size: 12))
                            }
                            .controlSize(.small)
                            .help("把本章这批词预选进复习笔记生成弹窗")
                        }
                        if !summary.dueIds.isEmpty {
                            Button {
                                vm.reviewChapterWords()
                            } label: {
                                Text("复习本章 \(summary.dueIds.count) 词").font(.system(size: 12))
                            }
                            .controlSize(.small)
                            .buttonStyle(.borderedProminent)
                            .help("只复习本章已到期的词，不打乱其他词的复习计划")
                        }
                    }
                }
                Divider().opacity(0.5)
                HStack(spacing: 8) {
                    Button("留在本章") {
                        vm.dismissChapterEnd()
                    }
                    .controlSize(.small)
                    if summary.nextChapterId != nil {
                        Button("开始下一章") {
                            vm.openNextChapter()
                        }
                        .controlSize(.small)
                        .buttonStyle(.borderedProminent)
                    }
                }
            }
            .padding(22)
            .frame(width: 360)
            .background(palette.surface)
            .clipShape(RoundedRectangle(cornerRadius: 14))
            .shadow(color: .black.opacity(0.24), radius: 20, y: 8)
        }
    }

    private func stat(_ label: String, _ value: String) -> some View {
        HStack(spacing: 4) {
            Text(label)
                .font(.system(size: 11.5))
                .foregroundColor(palette.textTertiary)
            Text(value)
                .font(.system(size: 12.5, weight: .semibold))
                .foregroundColor(palette.text)
        }
    }
}

// MARK: - 短文结课条

/// 短文读完的常驻结课条（替代一闪而过的 toast）：本篇收获快照 +
/// 笔记/复习入口，「继续阅读」关闭。只对短文（无 bookId）显示。
struct ReaderFinishBarView: View {
    @ObservedObject var vm: ReaderViewModel
    let summary: ReaderViewModel.ArticleFinishSummary
    @Environment(\.readerPalette) private var palette

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: ReaderIcons.book)
                .font(.system(size: 12))
                .foregroundColor(palette.accent)
            Text(finishText)
                .font(.system(size: 12))
                .foregroundColor(palette.text)
                .lineLimit(1)
            Spacer(minLength: 12)
            if summary.collected > 0 {
                Button {
                    vm.noteFinishCardWords()
                } label: {
                    Text("整理本篇复习笔记").font(.system(size: 12))
                }
                .controlSize(.small)
                .help("把这批词预选进复习笔记生成弹窗")
            }
            if summary.dueCount > 0 {
                Button {
                    vm.reviewFinishCardWords()
                } label: {
                    Text("复习本篇 \(summary.dueCount) 词").font(.system(size: 12))
                }
                .controlSize(.small)
                .buttonStyle(.borderedProminent)
                .help("只复习本篇已到期的词，不打乱其他词的复习计划")
            }
            Button("继续阅读") {
                vm.dismissFinishCard()
            }
            .controlSize(.small)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(palette.accent.opacity(0.08))
    }

    private var finishText: String {
        var text = "本篇读完 🎉 共查词 \(summary.lookups) 次 · 收录 \(summary.collected) 个词块和生词"
        if summary.dueCount > 0 {
            text += "，其中 \(summary.dueCount) 个待复习"
        }
        return text
    }
}

/// 提醒设置组（触点管理器的 config，存 review_reminder.json）。
struct ReminderSectionView: View {
    @ObservedObject private var manager = ReviewTouchpointManager.shared
    @Environment(\.readerPalette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                rowLabelView("每日提醒")
                Toggle("", isOn: Binding(
                    get: { manager.config.enabled },
                    set: { value in manager.config.enabled = value }
                ))
                .toggleStyle(.switch)
                .labelsHidden()
            }
            if manager.config.enabled {
                HStack {
                    rowLabelView("提醒时间")
                    Picker("", selection: Binding(
                        get: { manager.config.minuteOfDay },
                        set: { value in manager.config.minuteOfDay = value }
                    )) {
                        ForEach(stride(from: reminderMinuteOfDayMin, through: reminderMinuteOfDayMax, by: 30).map { $0 }, id: \.self) { minute in
                            Text(reminderMinuteLabel(minute)).tag(minute)
                        }
                    }
                    .labelsHidden()
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                HStack {
                    rowLabelView("夜间免打扰")
                    Toggle("", isOn: Binding(
                        get: { manager.config.dndEnabled },
                        set: { value in manager.config.dndEnabled = value }
                    ))
                    .toggleStyle(.switch)
                    .labelsHidden()
                    if manager.config.dndEnabled {
                        Text("\(reminderMinuteLabel(manager.config.dndStartMin)) – \(reminderMinuteLabel(manager.config.dndEndMin))")
                            .font(.system(size: 10.5))
                            .foregroundColor(palette.textTertiary)
                    }
                }
            }
            HStack {
                rowLabelView("阅读目标")
                Picker("", selection: Binding(
                    get: { manager.config.readGoalMin },
                    set: { value in manager.config.readGoalMin = value }
                )) {
                    ForEach([5, 10, 15, 20, 30, 45, 60], id: \.self) { minutes in
                        Text("\(minutes) 分钟/天").tag(minutes)
                    }
                }
                .labelsHidden()
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private func rowLabelView(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 11.5))
            .foregroundColor(palette.textSecondary)
            .frame(width: 76, alignment: .leading)
    }
}
