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

/// 阅读室根（ReaderApp.tsx 的 .reader-root）：双光晕画布 + 顶部三段外壳 +
/// 路由主体（书架首页 / 阅读 / 口语 / 笔记与复习四态）+ 播放条；书架浮层挂在根顶层。
struct ReaderRootView: View {
    @ObservedObject var vm: ReaderViewModel

    /// 右栏透镜卡占位宽（Windows `--reading-side-w`：folio 皮肤默认 388px；Mac 透镜卡 340pt）。
    static let readingSideWidth: CGFloat = 340

    var body: some View {
        let settings = vm.effectiveSettings
        // 色板带根皮肤维度：folio（shelf/reading）+ light 走品牌绿颜色矩阵（reader.css:9262-9276）。
        let palette = ReaderPalette.palette(for: settings.theme, skin: ReaderSkin(folding: vm.route.kind))
        // M-02：播放条不再占 VStack 通栏——改为底部悬浮胶囊（overlay），
        // 正文从胶囊两侧滚过（ReaderScroll 底部 84pt 安全留白）。
        let dockVisible = vm.route == .reading && !settings.zenMode
        // 短文结课条在场（与 ReadingStageView 的显示条件同源）时胶囊抬高避让。
        let finishBarVisible = vm.article != nil && vm.finishCard?.articleId == vm.article?.id
        // dock 居中几何契约（reader.css:7155-7180 + 9249-9254）：胶囊精确居中于正文列
        // 中轴 = (100% − 右栏占位)/2；专注模式 / 禅模式 / 无文章时右栏占位置 0。
        let sideWidth = ReaderBodyView.sideColumnVisible(vm: vm) ? Self.readingSideWidth : 0
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
        .overlay {
            // 底部悬浮走带胶囊（.floating-sonic-dock：bottom 16 / 999 圆角玻璃 + blur +
            // shadow-spatial）；left = (100% − side)/2 再 translateX(-50%) → 以 GeometryReader
            // 算出中轴 x 后 position 居中；正文收尾条在场时抬高避让。
            if dockVisible {
                GeometryReader { geo in
                    PlayBarView(vm: vm)
                        .position(
                            x: (geo.size.width - sideWidth) / 2,
                            y: geo.size.height - (finishBarVisible ? 68 : 16) - 25
                        )
                }
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
            // 每次重开都以 vm.importInitialTab 作初值（Windows ImportDialog 条件挂载 +
            // useState(initialTab) 契约；书架发现三列 / 空卡的直达 tab 由此生效）。
            ReaderImportSheet(vm: vm, initialTab: ReaderImportSheet.IntakeTab(importTab: vm.importInitialTab))
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

// MARK: - 顶部三段外壳（2026-10-26 外壳重构，对齐 ReaderTopBar.tsx / reader.css:9221-9410）

/// 外壳胶囊皮肤（reader.css:9290-9302 全局毛玻璃 vs :9344-9352 folio 平面白）：
/// 书架 / 阅读两视图挂 folio 皮肤——三段改为 `var(--surface)` 平面白胶囊（去 blur、
/// 去边框、去投影）；口语 / 笔记与复习视图保留毛玻璃三段语义。单测对账用。
enum ShellPillSkin: Equatable {
    case flat
    case glass

    /// 根 div `data-skin="folio"` 仅 shelf/reading 两视图挂（ReaderApp.tsx:2330-2335）。
    static func forRoute(_ route: ReaderViewModel.Route) -> ShellPillSkin {
        switch route {
        case .shelf, .reading: return .flat
        case .speak, .vault: return .glass
        }
    }
}

/// 三段外壳：`<header class="floating-top-stage">` 内 grid `1fr auto 1fr`——
/// 左 .shell-brand（monogram「I」回书架 + 书卷胶囊「书架 · 当前面名」浮层触发器）·
/// 中 .shell-tabs（阅读 / 口语 / 笔记与复习，vault 档角标 = 到期 + 未整理，>0 才渲染）·
/// 右 .shell-tools（全文检索 / 主题循环 / 阅读设置抽屉）。
/// 专注复习态（vault + focus）隐藏中心导航岛（ReaderTopBar.tsx:45-47 focusMode）。
struct ReaderTopStageView: View {
    @ObservedObject var vm: ReaderViewModel
    /// 舞台固定高度：上 14 + 胶囊 40 + 下 10（书架浮层 top:66 以此对位）。
    static let height: CGFloat = 64

    @State private var searchActive = false
    @State private var searchText = ""
    @FocusState private var searchFocused: Bool
    @Namespace private var islandNamespace

    var body: some View {
        let palette = ReaderPalette.palette(for: vm.effectiveSettings.theme, skin: ReaderSkin(folding: vm.route.kind))
        let skin = ShellPillSkin.forRoute(vm.route)
        // grid 1fr auto 1fr：左右两段各占一份弹性宽（左段 max-width 380，reader.css:9307），
        // 中段按内容宽居中；focus 态中段整段不渲染。
        HStack(spacing: 16) {
            brandSegment(palette, skin: skin)
                .frame(maxWidth: 380, alignment: .leading)
            Spacer(minLength: 8)
            if !vm.vaultFocusMode {
                tabsSegment(palette, skin: skin)
            }
            Spacer(minLength: 8)
            toolsSegment(palette, skin: skin)
                .frame(maxWidth: 380, alignment: .trailing)
        }
        // M-01：fullSizeContentView 后交通灯叠在画布左上（约占 x 0…70），
        // 左段 leading 留出 ~78pt 让位，三段与交通灯同处一条顶带。
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
        .animation(ReaderMotion.islandTab, value: vm.vaultFocusMode)
        .zIndex(30)
    }

    // MARK: 左：.shell-brand（monogram 印章 + 书卷胶囊）

    private func brandSegment(_ palette: ReaderPalette, skin: ShellPillSkin) -> some View {
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
        .modifier(ShellPillStyle(palette: palette, skin: skin))
    }

    // MARK: 中：.shell-tabs（aria-label「主导航」）

    private func tabsSegment(_ palette: ReaderPalette, skin: ShellPillSkin) -> some View {
        HStack(spacing: 4) {
            IslandTabButton(
                surface: .reading, icon: ReaderIcons.navReading, badge: 0,
                active: vm.islandSurface == .reading, palette: palette, namespace: islandNamespace,
                help: nil
            ) { vm.navigate(to: .reading) }
            IslandTabButton(
                surface: .speak, icon: ReaderIcons.navSpeak, badge: 0,
                active: vm.islandSurface == .speak, palette: palette, namespace: islandNamespace,
                help: nil
            ) { vm.navigate(to: .speak) }
            IslandTabButton(
                surface: .vault, icon: ReaderIcons.navVault, badge: vm.vaultBadge,
                active: vm.islandSurface == .vault, palette: palette, namespace: islandNamespace,
                help: "生词复习与笔记都在这一档"
            ) { vm.navigate(to: .vault) }
        }
        .padding(4)
        .modifier(ShellPillStyle(palette: palette, skin: skin))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("主导航")
        .transition(.opacity.combined(with: .scale(scale: 0.96)))
    }

    // MARK: 右：.shell-tools（检索 / 主题 / 设置）

    private func toolsSegment(_ palette: ReaderPalette, skin: ShellPillSkin) -> some View {
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
                    .accessibilityLabel("在本文中检索")
                    .onSubmit {
                        // Enter → onSearch(q.trim())：跳首个命中句 + toast（vm.searchInArticle）。
                        let q = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
                        if !q.isEmpty { vm.searchInArticle(q) }
                    }
                    .onExitCommand {
                        // Esc 关闭并清空（ReaderTopBar.tsx:163-166）。
                        searchActive = false
                        searchText = ""
                    }
                    .onChange(of: searchFocused) { focused in
                        // 空输入 blur 即收起（ReaderTopBar.tsx:168-170）。
                        if !focused, searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            searchActive = false
                        }
                    }
                    .transition(.opacity.combined(with: .move(edge: .trailing)))
            }
            GhostPillButton(icon: ReaderIcons.search, active: searchActive, palette: palette, help: "全文检索（Enter 跳转，Esc 关闭）") {
                vm.closeFolio()
                withAnimation(ReaderMotion.hover) { searchActive.toggle() }
                if searchActive { searchFocused = true } else { searchText = "" }
            }
            .accessibilityLabel("全文检索")
            GhostPillButton(
                text: "主题：\(vm.effectiveSettings.theme.label)",
                palette: palette,
                help: "主题：\(vm.effectiveSettings.theme.label)（点击切换）"
            ) {
                vm.closeFolio()
                // THEME_CYCLE light → dark → sepia → oled 循环；350ms 弹性换肤整棵视图树
                // 颜色一起渐变（原型 --ease-spring），四主题切换不闪白。
                withAnimation(ReaderMotion.skin) {
                    vm.patchSettings { $0.theme = $0.theme.next }
                }
            }
            .accessibilityLabel("切换主题，当前\(vm.effectiveSettings.theme.label)（点击切换）")
            GhostPillButton(icon: ReaderIcons.gear, active: vm.settingsDrawerShown, palette: palette, help: "阅读设置") {
                vm.closeFolio()
                vm.settingsDrawerShown = true
            }
            .accessibilityLabel("阅读设置")
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 4)
        .modifier(ShellPillStyle(palette: palette, skin: skin))
    }
}

/// 外壳三段容器（.shell-brand / .shell-tabs / .shell-tools 共用）：
/// - glass：999px 圆角 `--glass-pill` 底 + 系统材质（≈ backdrop-filter: blur(20px)）+
///   `--glass-border` 发丝边 + 顶部内高光 + 双层投影（reader.css:9290-9302）；
/// - flat：folio 皮肤改平面白胶囊——`var(--surface)` 实底、去 blur、去投影、去边框
///  （reader.css:9344-9352）。
struct ShellPillStyle: ViewModifier {
    let palette: ReaderPalette
    let skin: ShellPillSkin

    func body(content: Content) -> some View {
        switch skin {
        case .flat:
            content
                .background(Capsule().fill(palette.surface))
        case .glass:
            content.modifier(GlassPillStyle(palette: palette))
        }
    }
}

/// 毛玻璃胶囊（非 folio 视图的外壳三段 + 书架页分段 seg 共用）：
/// 玻璃底色 + 系统材质 + 发丝边 + 顶部内高光 + 双层投影（--shadow-pill）。
struct GlassPillStyle: ViewModifier {
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
/// help 对齐 Windows title：只有 vault 档有（「生词复习与笔记都在这一档」），其余 nil。
private struct IslandTabButton: View {
    let surface: IslandSurface
    let icon: String
    let badge: Int
    let active: Bool
    let palette: ReaderPalette
    let namespace: Namespace.ID
    let help: String?
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
        .help(help ?? "")
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

    /// 右栏透镜卡是否占位（dock 居中契约共用）：阅读档有文章、非禅模式、非专注模式
    ///（Windows 专注模式经 `.reader-root[data-side-hidden]` 把 `--reading-side-w` 置 0，
    /// 收起右侧解析面板；ReadingView.tsx:359-375）。
    @MainActor
    static func sideColumnVisible(vm: ReaderViewModel) -> Bool {
        let settings = vm.effectiveSettings
        return vm.route == .reading && vm.article != nil && !settings.zenMode && !settings.spotlightEnabled
    }

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
                        ReadingStageView(vm: vm)
                        // v0.8 透镜卡常驻右栏（句子解析 / 查词双 Tab，DictColumn.tsx
                        // spatial-lens-card）；无文章 / 禅模式 / 专注模式不占位。
                        if Self.sideColumnVisible(vm: vm) {
                            DictColumnView(vm: vm)
                                .frame(width: ReaderRootView.readingSideWidth)
                        }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    .transition(.opacity)
                case .vault:
                    // 「笔记与复习」四态容器（2026-10-26 改版 VaultPage）：
                    // home / notes / focus / export 由 vm.vaultPlayMode 分派。
                    ReaderVaultView(vm: vm)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                        .transition(.opacity)
                case .speak:
                    SpeakView(vm: vm, controller: vm.speak, catalog: ScenarioCatalogService.shared)
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

// MARK: - 整页书架（首页；2026-10-26 书架页重构，对齐 Windows ShelfPage.tsx）

/// 书架首页：页头（书架 + 「书 · N / 短文 · M」分段 + 导入）· 书 tab（最近读的书
/// 主卡 + 其余书紧凑行 + 统计卡 + 发现三列直达导入）· 短文 tab（搜索 / 筛选 /
/// 「排序：最近阅读」+ 继续阅读/已读完分组 + 同 sourceUrl 合并撤销）。
/// 口语陪练 / 笔记与复习入口在顶部外壳三段，不在书架重复留按钮。
struct ShelfHomeView: View {
    @ObservedObject var vm: ReaderViewModel
    /// 阅读目标配置（ReviewTouchpointManager.config.readGoalMin；提醒设置组同源）。
    @ObservedObject private var touchpoint = ReviewTouchpointManager.shared
    @Environment(\.readerPalette) private var palette

    private enum Tab: Equatable {
        case books, articles
    }

    @State private var tab: Tab = .books
    // ---- 短文 tab 本地工具态（纯 UI，不落盘；ShelfPage.tsx:196-221 同款）----
    @State private var query = ""
    @State private var filter: ShelfArticleFilter = .all
    /// 已撤销合并的 sourceUrl（撤销后该 URL 的重复条目全部展开）。
    @State private var unmergedUrls: Set<String> = []
    /// more 菜单打开的行 id（同时至多一个）。
    @State private var moreMenuId: String?
    /// 短文覆盖（进 shelf 视图才拉全文懒算，id → 覆盖统计；Windows articleCoverage）。
    @State private var coverage: [String: CoverageStats] = [:]

    /// 考试目标（localStorage intake-exam-goal 同源；IntakeService 单一真源）。
    private var examGoal: ExamGoal { IntakeService.shared.examGoal }
    private var goalLabel: String { examGoal.label }

    /// 短文管线：搜索 → 筛选 → 排序 → sourceUrl 合并 → 状态分组。
    private var shorts: ShelfShorts {
        buildShelfShorts(articles: vm.articleList, query: query, filter: filter, unmergedUrls: unmergedUrls)
    }

    /// 书 tab 排序：最近阅读的书为主卡，其余紧凑行（ShelfPage.tsx:224-229）。
    private var sortedBooks: [BookMeta] { shelfSortedBooks(vm.bookList) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                pageHead
                if tab == .books { booksSection } else { articlesSection }
            }
            .padding(.horizontal, 40)
            .padding(.top, 20)
            .padding(.bottom, 48)
            .frame(maxWidth: 1080)
            .frame(maxWidth: .infinity)
            .animation(ReaderMotion.islandTab, value: tab)
        }
        .onAppear { lazyComputeCoverage() }
        .onChange(of: vm.articleList) { _ in lazyComputeCoverage() }
    }

    /// 覆盖懒算：只有进书架页才拉全文 sourceCache 跑 coverageForText
    ///（对齐 ReaderApp.tsx:2216-2219 shelf 进入时算 + articleList 变化重算）。
    private func lazyComputeCoverage() {
        let goal = examGoal
        let wordlists = IntakeService.shared.wordlists
        for summary in vm.articleList where coverage[summary.id] == nil {
            let article = vm.sourceCache[summary.id]
                ?? ((try? vm.store.getArticle(id: summary.id)) ?? nil)
            guard let article else { continue }
            let text = article.sentences.map(\.en).joined(separator: " ")
            coverage[summary.id] = coverageForText(
                text,
                goal: goal,
                vocab: vm.vocabWords,
                wordlists: wordlists
            )
        }
    }

    // MARK: 页头（ShelfPage.tsx:387-415：标题 + 带数量分段 + 导入主按钮）

    private var pageHead: some View {
        HStack(alignment: .firstTextBaseline, spacing: 16) {
            Text("书架")
                .font(readerDisplayFont(30))
                .foregroundColor(palette.text)
            HStack(spacing: 3) {
                ShelfSegTab(label: "书 · \(vm.bookList.count)", active: tab == .books, palette: palette) {
                    tab = .books
                }
                ShelfSegTab(label: "短文 · \(vm.articleList.count)", active: tab == .articles, palette: palette) {
                    tab = .articles
                }
            }
            .padding(3)
            .modifier(GlassPillStyle(palette: palette))
            .accessibilityElement(children: .contain)
            .accessibilityLabel("书架内容切换")
            Spacer(minLength: 12)
            Button {
                // 缺省调 openImport() = 文库 tab（ShelfPage.tsx:409）。
                vm.openImport()
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
            .help("导入阅读内容（内置文库 / 文件 / 链接 / 粘贴）")
        }
    }

    // MARK: 书 tab（主卡 + 紧凑行 + 统计卡 + 发现三列）

    @ViewBuilder
    private var booksSection: some View {
        HStack(alignment: .top, spacing: 20) {
            VStack(alignment: .leading, spacing: 14) {
                if let featured = sortedBooks.first {
                    ShelfBookCard(
                        book: featured,
                        goalLabel: goalLabel,
                        radarCount: radarCount(of: featured),
                        palette: palette,
                        onContinue: { vm.openBookAt(bookId: featured.id) },
                        onOpenToc: { vm.openBookToc(bookId: featured.id) },
                        onDelete: { vm.deleteBook(bookId: featured.id) }
                    )
                } else {
                    ShelfEmptyCard(
                        icon: ReaderIcons.book,
                        title: "还没有书",
                        subtitle: "导入整本 EPUB：自动分章 · 断点续读 · 生词进复习闭环；也可以先读内置文库的短篇",
                        palette: palette
                    ) {
                        // 无书空卡直达 epub tab（ShelfPage.tsx:500）。
                        vm.openImport(tab: ReaderImportTab.epub.rawValue)
                    }
                }
                ForEach(sortedBooks.dropFirst()) { book in
                    ShelfMiniBookRow(
                        book: book,
                        palette: palette,
                        onContinue: { vm.openBookAt(bookId: book.id) },
                        onOpenToc: { vm.openBookToc(bookId: book.id) },
                        onDelete: { vm.deleteBook(bookId: book.id) }
                    )
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            ShelfStatCard(
                readMinutesToday: Int((vm.readSecondsToday / 60).rounded()),
                readGoalMin: touchpoint.config.readGoalMin,
                reviewedToday: vm.stats.reviewedToday,
                dueNow: vm.stats.dueNow,
                streak: vm.stats.streak,
                palette: palette,
                onGoReview: { vm.openReview() }
            )
            .frame(width: 300)
        }
        shelfSectionTitle("发现更多可读内容")
        ShelfDiscoverRow(palette: palette) { tab in
            vm.openImport(tab: tab)
        }
    }

    /// 选书雷达该考试目标的覆盖数。
    private func radarCount(of book: BookMeta) -> Int {
        switch examGoal {
        case .kaoyan: return book.radar.kaoyan
        case .cet4: return book.radar.cet4
        case .cet6: return book.radar.cet6
        }
    }

    // MARK: 短文 tab

    @ViewBuilder
    private var articlesSection: some View {
        if vm.articleList.isEmpty {
            ShelfEmptyCard(
                icon: ReaderIcons.book,
                title: "添加一篇短文",
                subtitle: "内置文库 · 网页链接 · Word / PDF · 粘贴文本",
                palette: palette
            ) {
                vm.openImport()  // 短文空卡缺省文库 tab（ShelfPage.tsx:669）
            }
        } else {
            VStack(alignment: .leading, spacing: 12) {
                toolsRow
                let s = shorts
                if s.reading.isEmpty && s.done.isEmpty {
                    // 无结果：搜索中给 query，否则给筛选（ShelfPage.tsx:722-725）。
                    Text(s.searching ? "没有匹配「\(query.trimmingCharacters(in: .whitespacesAndNewlines))」的短文" : "这个筛选下暂无短文")
                        .font(.system(size: 12.5))
                        .foregroundColor(palette.textTertiary)
                        .padding(.vertical, 28)
                        .frame(maxWidth: .infinity)
                } else {
                    if !s.reading.isEmpty {
                        sectionGroupTitle("继续阅读 · \(s.reading.count)")
                        shelfList(s.reading)
                        mergedHint(count: s.mergedReadingCount, urls: s.mergedReadingUrls)
                    }
                    if !s.done.isEmpty {
                        sectionGroupTitle("已读完 · \(s.done.count)")
                        shelfList(s.done)
                        mergedHint(count: s.mergedDoneCount, urls: s.mergedDoneUrls)
                    }
                }
            }
        }
    }

    /// 工具行：搜索（标题，含译名）/ 状态筛选 chips / 排序标签。
    private var toolsRow: some View {
        HStack(spacing: 12) {
            HStack(spacing: 6) {
                Image(systemName: ReaderIcons.search)
                    .font(.system(size: 11))
                    .foregroundColor(palette.textTertiary)
                TextField("搜索标题", text: $query)
                    .textFieldStyle(.plain)
                    .font(.system(size: 12))
                    .foregroundColor(palette.text)
                    .frame(width: 180)
                    .accessibilityLabel("搜索短文标题")
                if !query.isEmpty {
                    Button {
                        query = ""
                    } label: {
                        Image(systemName: ReaderIcons.close)
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundColor(palette.textTertiary)
                            .frame(width: 16, height: 16)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("清空搜索")
                }
            }
            .padding(.horizontal, 10)
            .frame(height: 28)
            .background(Capsule().fill(palette.glassSurface.opacity(0.7)))
            .overlay(Capsule().strokeBorder(palette.glassBorder, lineWidth: 1))

            HStack(spacing: 6) {
                ForEach(ShelfArticleFilter.allCases, id: \.self) { f in
                    Button {
                        filter = f
                    } label: {
                        Text(f.label)
                            .font(.system(size: 11.5, weight: filter == f ? .semibold : .medium))
                            .foregroundColor(filter == f ? palette.onInk : palette.textSecondary)
                            .padding(.horizontal, 10)
                            .frame(height: 24)
                            .background(Capsule().fill(filter == f ? palette.text : palette.glassSurface.opacity(0.7)))
                            .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(f.label)
                    .accessibilityAddTraits(filter == f ? [.isSelected] : [])
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("按状态筛选")

            Spacer(minLength: 8)
            HStack(spacing: 3) {
                Text("排序：最近阅读")
                    .font(.system(size: 11.5))
                    .foregroundColor(palette.textTertiary)
                Image(systemName: "chevron.down")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundColor(palette.textTertiary)
            }
            .help("当前排序：最近阅读")
        }
    }

    /// 组尾「已合并 N 条重复内容 + 撤销」（ShelfPage.tsx:734-751）。
    @ViewBuilder
    private func mergedHint(count: Int, urls: [String]) -> some View {
        if count > 0 {
            HStack(spacing: 8) {
                Text("已合并 \(count) 条重复内容")
                    .font(.system(size: 11.5))
                    .foregroundColor(palette.textTertiary)
                Button("撤销") {
                    unmerge(urls)
                }
                .font(.system(size: 11.5, weight: .semibold))
                .buttonStyle(.link)
            }
            .padding(.vertical, 4)
        }
    }

    private func unmerge(_ urls: [String]) {
        unmergedUrls.formUnion(urls)
    }

    private func sectionGroupTitle(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 12, weight: .semibold))
            .foregroundColor(palette.textSecondary)
    }

    private func shelfSectionTitle(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 12, weight: .semibold))
            .foregroundColor(palette.textSecondary)
            .padding(.top, 6)
    }

    private func shelfList(_ items: [ArticleSummary]) -> some View {
        VStack(spacing: 0) {
            ForEach(items) { summary in
                ShelfShortRow(
                    summary: summary,
                    books: vm.bookList,
                    goalLabel: goalLabel,
                    coverage: coverage[summary.id],
                    palette: palette,
                    menuOpen: moreMenuId == summary.id,
                    onSelect: { vm.openArticle(id: summary.id) },
                    onToggleMenu: {
                        moreMenuId = moreMenuId == summary.id ? nil : summary.id
                    },
                    onCloseMenu: { moreMenuId = nil },
                    onDelete: { vm.deleteArticle(id: summary.id) }
                )
                Rectangle()
                    .fill(palette.glassBorder)
                    .frame(height: 1)
                    .padding(.leading, 14)
            }
        }
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(palette.glassSurface.opacity(0.5)))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(palette.glassBorder, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

/// 头部分段小 tab（书 · N / 短文 · M）。
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

/// 书架空态卡（.shelf-emptycard）：虚线框邀请导入。
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

/// 书架主卡（.shelf-bookcard，最近阅读的书）：封面 / EPUB 占位 + 标题作者 +
/// 元信息（N 章 · 词数 · 时长）+ 选书雷达 tag + 进度条 + 断点直达 / 目录 / 删除。
private struct ShelfBookCard: View {
    let book: BookMeta
    let goalLabel: String
    let radarCount: Int
    let palette: ReaderPalette
    let onContinue: () -> Void
    let onOpenToc: () -> Void
    let onDelete: () -> Void
    @State private var hover = false

    var body: some View {
        let facts = shelfBookFacts(book)
        let sentence = book.progress.sentenceIdx
        HStack(alignment: .top, spacing: 16) {
            ZStack(alignment: .bottom) {
                Group {
                    if let cover = BookCoverImage.image(fromDataURL: book.cover) {
                        Image(nsImage: cover)
                            .resizable()
                            .aspectRatio(contentMode: .fill)
                    } else {
                        VStack(spacing: 4) {
                            Text("EPUB")
                                .font(.system(size: 8.5, weight: .semibold))
                                .foregroundColor(.white.opacity(0.7))
                            Spacer()
                            Text(book.title)
                                .font(readerDisplayFont(13))
                                .foregroundColor(.white.opacity(0.92))
                                .lineLimit(3)
                                .multilineTextAlignment(.center)
                            Text(book.author ?? "")
                                .font(.system(size: 7.5))
                                .foregroundColor(.white.opacity(0.6))
                                .lineLimit(1)
                        }
                        .padding(8)
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
                if facts.percent >= 100 {
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
                Text(book.author ?? "未知作者")
                    .font(.system(size: 12))
                    .foregroundColor(palette.textTertiary)
                // 元信息一行化（ShelfPage.tsx:448-449）：N 章 · 词数 · 约 X 小时/分钟。
                HStack(spacing: 6) {
                    Text("\(book.chapters.count) 章 · \(facts.words.formatted()) 词 · 约 \(shelfFormatDuration(minutes: facts.minutes))")
                        .font(.system(size: 11))
                        .foregroundColor(palette.textTertiary)
                    if radarCount > 0 {
                        Text("\(goalLabel) · 大纲词 \(radarCount.formatted())")
                            .font(.system(size: 10.5, weight: .semibold))
                            .foregroundColor(palette.tapeInk)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 2.5)
                            .background(RoundedRectangle(cornerRadius: 5, style: .continuous).fill(palette.tapeBg))
                            .overlay(RoundedRectangle(cornerRadius: 5, style: .continuous).strokeBorder(palette.tapeBorder, lineWidth: 1))
                            .help("选书雷达：该考试目标的大纲词覆盖数")
                    }
                }
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 8) {
                        Text("\(facts.percent)%")
                            .font(.system(size: 12.5, weight: .bold))
                            .monospacedDigit()
                            .foregroundColor(palette.text)
                        Text(facts.percent >= 100 ? "已读完" : (facts.started ? "第 \(facts.chapterIdx + 1) / \(book.chapters.count) 章" : "尚未开始"))
                            .font(.system(size: 11))
                            .foregroundColor(palette.textTertiary)
                    }
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            Capsule().fill(palette.glassBorderStrong)
                            Capsule()
                                .fill(palette.accent)
                                .frame(width: max(0, geo.size.width * CGFloat(facts.percent) / 100))
                                .animation(.easeOut(duration: 0.4), value: facts.percent)
                        }
                    }
                    .frame(height: 3)
                }
                .padding(.top, 2)
                HStack(spacing: 8) {
                    Button(action: onContinue) {
                        HStack(spacing: 5) {
                            Image(systemName: ReaderIcons.play).font(.system(size: 9, weight: .bold))
                            Text(facts.started ? "继续读 · 第 \(facts.chapterIdx + 1) 章第 \(sentence + 1) 句" : "开始阅读")
                                .font(.system(size: 11.5, weight: .semibold))
                        }
                        .foregroundColor(.white)
                        .padding(.horizontal, 11)
                        .frame(height: 26)
                        .background(Capsule().fill(palette.accent))
                    }
                    .buttonStyle(.plain)
                    .help(facts.started ? "回到第 \(facts.chapterIdx + 1) 章第 \(sentence + 1) 句" : "从第 1 章开始读这本书")
                    Button {
                        onOpenToc()
                    } label: {
                        Text("目录")
                            .font(.system(size: 11.5, weight: .medium))
                            .foregroundColor(palette.text)
                            .padding(.horizontal, 11)
                            .frame(height: 26)
                            .background(Capsule().strokeBorder(palette.glassBorderStrong, lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                    .help("查看目录")
                    // 删除 icon 常显（ShelfPage.tsx:485-493 `.shelf-book-del` 无条件渲染，
                    // reader.css:10516 margin-left:auto 靠右；色 text-3，悬停 surface-2 底）。
                    Spacer(minLength: 0)
                    ShelfIconButton(systemName: ReaderIcons.trash, palette: palette, destructive: true) {
                        confirmDelete()
                    }
                    .help("移出书架（生词本不受影响）")
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
        .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .onHover { h in
            withAnimation(ReaderMotion.hover) { hover = h }
        }
    }

    private func confirmDelete() {
        // 删除书二次确认（ShelfPage.tsx:169-174 文案逐字；NSAlert 异步等价）。
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

/// 其余书紧凑行（.shelf-minirow）：缩略封面 / 书名首字母占位 + 书名 +
/// 「N 章 · pct%[ · 第 x 章 | · 已读完]」+ 继续读 / 目录 / 删除三 icon；整行点击开目录。
private struct ShelfMiniBookRow: View {
    let book: BookMeta
    let palette: ReaderPalette
    let onContinue: () -> Void
    let onOpenToc: () -> Void
    let onDelete: () -> Void
    @State private var hover = false

    var body: some View {
        let facts = shelfBookFacts(book)
        HStack(spacing: 10) {
            ZStack {
                if let cover = BookCoverImage.image(fromDataURL: book.cover) {
                    Image(nsImage: cover)
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                } else {
                    Text(String(book.title.prefix(1)).uppercased())
                        .font(.system(size: 11, weight: .bold, design: .serif))
                        .foregroundColor(.white.opacity(0.9))
                }
            }
            .frame(width: 28, height: 38)
            .background(
                LinearGradient(
                    colors: [
                        Color(hue: 0.08, saturation: 0.42, brightness: 0.62),
                        Color(hue: 0.02, saturation: 0.38, brightness: 0.48)
                    ],
                    startPoint: .topLeading, endPoint: .bottomTrailing
                )
            )
            .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))

            Text(book.title)
                .font(.system(size: 12.5, design: .serif))
                .foregroundColor(palette.text)
                .lineLimit(1)
                .truncationMode(.tail)
                .help(book.title)
            Spacer(minLength: 8)
            Text(miniMeta(facts))
                .font(.system(size: 11))
                .monospacedDigit()
                .foregroundColor(palette.textTertiary)
            HStack(spacing: 2) {
                miniIcon(icon: ReaderIcons.play, help: facts.started ? "继续读 · 第 \(facts.chapterIdx + 1) 章第 \(book.progress.sentenceIdx + 1) 句" : "开始阅读") {
                    onContinue()
                }
                miniIcon(icon: ReaderIcons.toc, help: "查看目录") {
                    onOpenToc()
                }
                miniIcon(icon: ReaderIcons.trash, help: "移出书架（生词本不受影响）", tint: hover ? palette.err : palette.ink4) {
                    confirmDelete()
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(hover ? palette.glassSurface.opacity(0.6) : Color.clear)
        )
        .contentShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .onTapGesture(perform: onOpenToc)
        .onHover { h in
            withAnimation(ReaderMotion.hover) { hover = h }
        }
        .help("查看目录")
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
    }

    /// `{N} 章 · {pct}%` + 进行中「 · 第 x 章」/ 读完「 · 已读完」（ShelfPage.tsx:536-539）。
    private func miniMeta(_ facts: ShelfBookFacts) -> String {
        var text = "\(book.chapters.count) 章 · \(facts.percent)%"
        if facts.percent > 0 && facts.percent < 100 { text += " · 第 \(facts.chapterIdx + 1) 章" }
        if facts.percent >= 100 { text += " · 已读完" }
        return text
    }

    private func miniIcon(icon: String, help: String, tint: Color? = nil, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 10.5, weight: .medium))
                .foregroundColor(tint ?? palette.textTertiary)
                .frame(width: 22, height: 22)
                .background(Circle().fill(hover ? palette.glassBorder : Color.clear))
        }
        .buttonStyle(.plain)
        .help(help)
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

/// 书架圆形 icon 钮（reader.css:10494-10515 `.shelf-iconbtn`）：28pt 圆、透明底、text-3 色；
/// 悬停 surface-2 底 + text-1（`.del` 悬停 err-soft 底 + err）。常显，不依赖卡片悬停。
private struct ShelfIconButton: View {
    let systemName: String
    let palette: ReaderPalette
    var destructive = false
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 11, weight: .medium))
                .foregroundColor(hover ? (destructive ? palette.err : palette.text) : palette.textTertiary)
                .frame(width: 28, height: 28)
                .background(
                    Circle().fill(hover ? (destructive ? palette.errSoft : palette.surface2) : Color.clear)
                )
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .onHover { h in
            withAnimation(ReaderMotion.hover) { hover = h }
        }
    }
}

/// 统计卡（.shelf-statcard）：今日阅读环 / 今日复习（到期数 + 开始复习）/ 连续天数。
private struct ShelfStatCard: View {
    let readMinutesToday: Int
    let readGoalMin: Int
    let reviewedToday: Int
    let dueNow: Int
    let streak: Int
    let palette: ReaderPalette
    let onGoReview: () -> Void

    private var goalOn: Bool { readGoalMin > 0 }
    private var readMin: Int { max(0, readMinutesToday) }
    private var ringRatio: Double { goalOn ? min(1, Double(readMin) / Double(readGoalMin)) : 0 }
    private var todayTotal: Int { reviewedToday + dueNow }
    private var reviewPct: Int {
        todayTotal > 0 ? Int((Double(reviewedToday) / Double(max(1, todayTotal)) * 100).rounded()) : 0
    }
    /// streak 为 0 时的鼓励语门槛：目标开启用目标值，否则 10 分钟（ShelfPage.tsx:237）。
    private var streakGoalMin: Int { goalOn ? readGoalMin : 10 }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            // 今日阅读（ShelfPage.tsx:581-604）
            VStack(alignment: .leading, spacing: 8) {
                Text("今日阅读")
                    .font(.system(size: 11.5, weight: .semibold))
                    .foregroundColor(palette.textTertiary)
                HStack(spacing: 10) {
                    ZStack {
                        Circle().stroke(palette.glassBorderStrong, lineWidth: 4)
                        Circle()
                            .trim(from: 0, to: ringRatio)
                            .stroke(goalOn && readMin >= readGoalMin ? palette.sonicTeal : palette.accent, style: StrokeStyle(lineWidth: 4, lineCap: .round))
                            .rotationEffect(.degrees(-90))
                            .animation(ReaderMotion.islandTab, value: ringRatio)
                        Text(goalOn ? "\(readMin)/\(readGoalMin)" : "\(readMin)′")
                            .font(.system(size: 10.5, weight: .bold, design: .monospaced))
                            .monospacedDigit()
                            .foregroundColor(palette.text)
                    }
                    .frame(width: 52, height: 52)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(readHeadline)
                            .font(.system(size: 12.5, weight: .semibold))
                            .foregroundColor(palette.text)
                        Text(readSubline)
                            .font(.system(size: 11))
                            .foregroundColor(palette.textTertiary)
                    }
                }
            }
            .accessibilityElement(children: .combine)

            // 今日复习（ShelfPage.tsx:605-628）
            VStack(alignment: .leading, spacing: 6) {
                Text("今日复习")
                    .font(.system(size: 11.5, weight: .semibold))
                    .foregroundColor(palette.textTertiary)
                Text(dueNow > 0 ? "\(dueNow) 张到期" : (todayTotal > 0 ? "今日到期已清空" : "今天没有到期生词"))
                    .font(.system(size: 12.5, weight: .semibold))
                    .foregroundColor(palette.text)
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Capsule().fill(palette.glassBorderStrong)
                        Capsule()
                            .fill(palette.accent)
                            .frame(width: max(0, geo.size.width * CGFloat(reviewPct) / 100))
                            .animation(ReaderMotion.islandTab, value: reviewPct)
                    }
                }
                .frame(height: 4)
                // 无到期词时点了只会进空队列，像「点了没反应」——禁用并把原因写进
                // title，让用户知道该等明天或先去加生词（ShelfPage.tsx:615-624）。
                Button {
                    onGoReview()
                } label: {
                    Text("开始复习")
                        .font(.system(size: 11.5, weight: .semibold))
                        .foregroundColor(.white)
                        .padding(.horizontal, 12)
                        .frame(height: 26)
                        .frame(maxWidth: .infinity)
                        .background(Capsule().fill(dueNow > 0 ? palette.accent : palette.ink4))
                }
                .buttonStyle(.plain)
                .disabled(dueNow == 0)
                .help(dueNow > 0
                    ? "去复习 \(dueNow) 个到期生词"
                    : (todayTotal > 0
                        ? "今天的到期已清空，明天再来"
                        : "暂无到期生词。先在阅读里查词收藏，明天会出现在这里"))
                .padding(.top, 4)
            }
            .accessibilityElement(children: .combine)

            // 连续天数（ShelfPage.tsx:629-638）：streak>0 火焰 + 天数；0 给鼓励语。
            if streak > 0 {
                HStack(spacing: 4) {
                    Image(systemName: ReaderIcons.flame).font(.system(size: 11))
                    Text("连续阅读 \(streak) 天").monospacedDigit()
                }
                .font(.system(size: 11.5, weight: .semibold))
                .foregroundColor(palette.warn)
            } else {
                Text("读满 \(streakGoalMin) 分钟，开启你的连续阅读")
                    .font(.system(size: 11))
                    .foregroundColor(palette.textTertiary)
            }
        }
        .padding(16)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(palette.glassSurface.opacity(0.55)))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(palette.glassBorder, lineWidth: 1))
    }

    private var readHeadline: String {
        if goalOn {
            return readMin >= readGoalMin ? "目标已达成" : "还差 \(readGoalMin - readMin) 分钟"
        }
        return "已读 \(readMin) 分钟"
    }

    private var readSubline: String {
        if goalOn {
            return readMin >= readGoalMin ? "明天继续保持" : "达成今日目标"
        }
        return "可在阅读设置里定每日阅读目标"
    }
}

/// 发现三列（.shelf-disc，ShelfPage.tsx:642-666）：三个导入直达入口。
/// discover（发现书库）/ feed（资讯订阅）tab 内容依赖资讯订阅领域——Mac 未落地前
/// 该两列点击进缺省文库 tab 且不报错（规格 §4 范围依赖）。
private struct ShelfDiscoverRow: View {
    let palette: ReaderPalette
    let onOpen: (String) -> Void
    @State private var hoverTab: String?

    private struct DiscCard {
        let icon: String
        let title: String
        let subtitle: String
        let tab: String
    }

    private let cards: [DiscCard] = [
        DiscCard(icon: ReaderIcons.navReading, title: "精选经典", subtitle: "按难度和考纲词表挑选公版名著与短篇", tab: ReaderImportTab.discover.rawValue),
        DiscCard(icon: ReaderIcons.rss, title: "英文资讯订阅", subtitle: "订阅常用新闻源，每天自动收到可读短文", tab: ReaderImportTab.feed.rawValue),
        DiscCard(icon: ReaderIcons.plus, title: "导入自己的内容", subtitle: "网址、文件或粘贴文本，自动拆句并翻译", tab: ReaderImportTab.lib.rawValue),
    ]

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            ForEach(cards, id: \.tab) { card in
                Button {
                    onOpen(card.tab)
                } label: {
                    VStack(alignment: .leading, spacing: 6) {
                        Image(systemName: card.icon)
                            .font(.system(size: 14, weight: .medium))
                            .foregroundColor(palette.accent)
                            .frame(width: 30, height: 30)
                            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(palette.accentSoft))
                        Text(card.title)
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundColor(palette.text)
                        Text(card.subtitle)
                            .font(.system(size: 11.5))
                            .foregroundColor(palette.textTertiary)
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .fill(hoverTab == card.tab ? palette.glassSurface : palette.glassSurface.opacity(0.5))
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .strokeBorder(hoverTab == card.tab ? palette.glassBorderStrong : palette.glassBorder, lineWidth: 1)
                    )
                    .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
                .buttonStyle(.plain)
                .onHover { h in
                    withAnimation(ReaderMotion.hover) { hoverTab = h ? card.tab : nil }
                }
            }
        }
    }
}

/// 短文统一行（.shelf-item，ShelfPage.tsx:314-381）：进度环（✓）+ 标题 +
/// 「译名 · 来源」合并行 + 一行元信息 + more 菜单（唯一项「删除这篇短文」）。
private struct ShelfShortRow: View {
    let summary: ArticleSummary
    let books: [BookMeta]
    let goalLabel: String
    let coverage: CoverageStats?
    let palette: ReaderPalette
    let menuOpen: Bool
    let onSelect: () -> Void
    let onToggleMenu: () -> Void
    let onCloseMenu: () -> Void
    let onDelete: () -> Void
    @State private var hover = false

    var body: some View {
        let article = summary.article
        let done = article.progress.percent >= 100
        let minutes = shelfEstimateMinutes(wordCount: article.wordCount)
        HStack(spacing: 12) {
            progressRing(percent: article.progress.percent, done: done)
            VStack(alignment: .leading, spacing: 2) {
                Text(article.title)
                    .font(.system(size: 13.5, design: .serif))
                    .foregroundColor(palette.text)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .help(article.title)
                // 原型「译名 · 来源」合并（L438）：有译名也不丢来源落款。
                Text(article.titleCn.map { "\($0) · \(source)" } ?? source)
                    .font(.system(size: 11))
                    .foregroundColor(palette.textTertiary)
                    .lineLimit(1)
            }
            Spacer(minLength: 12)
            HStack(spacing: 8) {
                if let level = article.level, !level.isEmpty {
                    Text(level)
                        .font(.system(size: 10.5, weight: .semibold))
                        .foregroundColor(palette.tapeInk)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(RoundedRectangle(cornerRadius: 4, style: .continuous).fill(palette.tapeBg))
                }
                Text("约 \(shelfFormatDuration(minutes: minutes))")
                    .font(.system(size: 11))
                    .foregroundColor(palette.textTertiary)
                if let cov = coverage {
                    Text("\(goalLabel)词 \(cov.total.formatted())")
                        .font(.system(size: 11))
                        .monospacedDigit()
                        .foregroundColor(palette.textTertiary)
                        .help("\(goalLabel)大纲词命中 \(cov.total) 个")
                }
            }
            moreMenu
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(hover || menuOpen ? palette.glassBorder.opacity(0.35) : Color.clear)
        .contentShape(Rectangle())
        .onTapGesture(perform: onSelect)
        .onHover { h in
            withAnimation(ReaderMotion.hover) { hover = h }
        }
        .help("打开这篇短文")
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
    }

    private var source: String {
        shelfSourceLabel(article: summary.article, books: books)
    }

    /// conic 进度环的等价物：Circle().trim；读完加 ✓（ShelfPage.tsx:331-333）。
    private func progressRing(percent: Double, done: Bool) -> some View {
        let ratio = min(1, max(0, percent / 100))
        return ZStack {
            Circle().stroke(palette.glassBorderStrong, lineWidth: 2.5)
            Circle()
                .trim(from: 0, to: ratio)
                .stroke(done ? palette.sonicTeal : palette.accent, style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
                .rotationEffect(.degrees(-90))
            if done {
                Image(systemName: "checkmark")
                    .font(.system(size: 8, weight: .bold))
                    .foregroundColor(palette.sonicTeal)
            }
        }
        .frame(width: 26, height: 26)
        .accessibilityHidden(true)
    }

    /// more 菜单（竖三点，role=menu，唯一项「删除这篇短文」带 confirm）。
    private var moreMenu: some View {
        Menu {
            Button {
                onCloseMenu()
                confirmDelete()
            } label: {
                Label("删除这篇短文", systemImage: ReaderIcons.trash)
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(palette.textTertiary)
                .frame(width: 22, height: 22)
                .background(Circle().fill(menuOpen || hover ? palette.glassBorder : Color.clear))
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("更多操作")
        .accessibilityLabel("更多操作")
    }

    private func confirmDelete() {
        // 删除短文确认（ShelfPage.tsx:369 文案逐字；NSAlert 等价 window.confirm）。
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

// MARK: - 阅读舞台（2026-10-26 阅读页白卡重构，对齐 ReadingView.tsx）

/// 白卡主栏：`.reading-toolbar` 控件收口（meta / 遮罩开关+计数 / 目录 chip /
/// 阅读设置 chip + 设置浮层）+ `.reading-scrollpane`（左缘进度轨 + 居中 640pt 正文列：
/// 续读胶囊、刊头、prose 英文流 / parallel 双栏）+ 译文浮层（锚定当前句末行下方）。
/// 短文结课条常驻底部直到关闭。
struct ReadingStageView: View {
    @ObservedObject var vm: ReaderViewModel
    @State private var editingIdx: Int?
    @State private var editDraft = ""
    /// 段落排版下的本地句卡开关（原型「句卡」，无持久字段）。
    @State private var sentCards = false
    /// 续读胶囊隐藏（换文复位）。
    @State private var resumeHidden = false
    /// 当前句末行 rect（正文内容坐标系；译文浮层锚定）。
    @State private var popAnchors: [Int: PopAnchor] = [:]

    private var settings: ReaderSettings { vm.effectiveSettings }
    /// 阅读设置浮层开关（ReadingView.tsx settingsOpen）：挂在 vm 上以接入统一 Esc 链。
    private var settingsOpen: Bool { vm.readingSettingsPopShown }

    var body: some View {
        if let article = vm.article {
            VStack(spacing: 0) {
                ReadingToolbarView(
                    vm: vm,
                    settingsOpen: $vm.readingSettingsPopShown,
                    sentCards: $sentCards
                )
                readingPane(article: article)
                if let finish = vm.finishCard, article.id == finish.articleId {
                    Divider().opacity(0.5)
                    ReaderFinishBarView(vm: vm, summary: finish)
                }
            }
            .animation(ReaderMotion.hover, value: settingsOpen)
            .overlay {
                // 阅读设置浮层：点浮层外关闭（浮层内与触发 chip 的点击不吃，
                // ReadingView.tsx:406-415 pointerdown 外点关闭的等价物）。
                if settingsOpen {
                    ZStack(alignment: .topTrailing) {
                        Color.black.opacity(0.001)
                            .contentShape(Rectangle())
                            .onTapGesture { vm.readingSettingsPopShown = false }
                        ReadingSettingsPopover(vm: vm, sentCards: $sentCards)
                        .padding(.top, 6)
                        .padding(.trailing, 40)
                    }
                    .transition(.opacity.combined(with: .scale(scale: 0.97, anchor: .topTrailing)))
                }
            }
            .overlay(alignment: .bottomLeading) {
                // 随读抽查胶带小条层（.cloze-toast-layer：left 64 / bottom 20，aria-live=polite）。
                ClozeToastLayer(toasts: vm.clozeToasts)
                    .padding(.leading, 64)
                    .padding(.bottom, 20)
                    .allowsHitTesting(false)
            }
            .onChange(of: article.id) { _ in
                // 换文复位（ReadingView.tsx:168）：续读胶囊回到该篇自己的断点。
                resumeHidden = false
                editingIdx = nil
                popAnchors = [:]
            }
        } else {
            EmptyStateView {
                vm.openImport()
            }
        }
    }

    // MARK: 正文滚动区（左缘进度轨 + 居中 640pt 列 + 译文浮层）

    private func readingPane(article: Article) -> some View {
        GeometryReader { outer in
            ScrollViewReader { proxy in
                ScrollView {
                    ZStack(alignment: .topLeading) {
                        // 左缘进度轨（aria-hidden；rail-pct / rail-track / rail-label）。
                        ReadingRailView(article: article, vm: vm)
                            .frame(width: 64, alignment: .top)
                            .frame(maxHeight: .infinity, alignment: .top)
                            .padding(.top, 12)
                        // 居中 640pt 正文列。
                        readingCol(article: article)
                            .frame(maxWidth: .infinity)
                    }
                    .coordinateSpace(name: "readingContent")
                }
                .coordinateSpace(name: "readerScroll")
                .onPreferenceChange(RowFramesKey.self) { frames in
                    adoptViewportFrames(frames, containerHeight: outer.size.height)
                }
                .onPreferenceChange(PopAnchorKey.self) { anchors in
                    // 浮层锚点随排版（末行 rect）更新；取当前句即可。
                    popAnchors = anchors
                }
                .onChange(of: vm.activeSentenceIdx) { idx in
                    proxy.scrollTo(scrollAnchor(for: idx, article: article), anchor: .center)
                }
                .onChange(of: vm.searchMatchIdx) { idx in
                    guard let idx else { return }
                    proxy.scrollTo(scrollAnchor(for: idx, article: article), anchor: .center)
                }
            }
        }
    }

    @ViewBuilder
    private func readingCol(article: Article) -> some View {
        let total = article.sentences.count
        let resumeIdx = article.progress.sentenceIdx
        let showResume = resumeIdx > 0 && resumeIdx < total && vm.translating == nil && !resumeHidden
        VStack(alignment: .leading, spacing: 0) {
            if showResume {
                ResumeCapsuleView(
                    resumeIdx: resumeIdx,
                    palette: palette,
                    onGo: {
                        resumeHidden = true
                        vm.jumpTo(idx: resumeIdx)
                    },
                    onClose: { resumeHidden = true }
                )
                .padding(.bottom, 14)
            }
            ReadingHeadView(article: article, vm: vm)
            if layout == .prose {
                ProseBodyView(article: article, vm: vm, sentCards: sentCards)
                    .id("prose-body")
            } else {
                ArticleRows(article: article, vm: vm, editingIdx: $editingIdx, editDraft: $editDraft)
            }
            if vm.showFinishAction {
                finishActionRow
            }
        }
        .padding(.horizontal, 24)
        .padding(.top, 10)
        // M-02：底部悬浮走带胶囊（bottom 16 + 胶囊高约 50）→ 正文安全留白 84。
        .padding(.bottom, settings.zenMode ? 60 : 84)
        .frame(width: readingColWidth)
        .frame(maxWidth: .infinity)
        .background(
            // 译文浮层：脱离文档流锚在当前句末行下方（同 Windows .translation-pop
            // 绝对定位语义——放在列内容上，随内容滚动）。
            Color.clear.overlay(alignment: .topLeading) {
                if layout == .prose, let anchor = popAnchors[vm.activeSentenceIdx],
                   let sentence = article.sentences[safe: vm.activeSentenceIdx] {
                    TranslationPopView(
                        vm: vm,
                        pair: sentence,
                        editing: editingIdx == sentence.idx,
                        editDraft: $editDraft,
                        arrowX: anchor.arrowX(colWidth: readingColWidth),
                        onStartEdit: {
                            editDraft = sentence.zh ?? ""
                            editingIdx = sentence.idx
                        },
                        onCancelEdit: { editingIdx = nil },
                        onCommitEdit: {
                            let text = editDraft.trimmingCharacters(in: .whitespacesAndNewlines)
                            editingIdx = nil
                            if !text.isEmpty { vm.editTranslation(idx: sentence.idx, zh: text) }
                        }
                    )
                    .offset(x: 24, y: anchor.maxY + 10)
                    .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
        )
        .animation(ReaderMotion.hover, value: popAnchors[vm.activeSentenceIdx])
    }

    @Environment(\.readerPalette) private var palette

    /// 生效版式：仅中文时明确回落对照行（prose 英文流被隐藏后不可读）；
    /// 其余按 spreadLayout（缺省 prose）。
    private var layout: SpreadLayout {
        settings.contrastMode == .zh ? .parallel : settings.effectiveSpreadLayout
    }

    /// 正文列宽：640pt（Windows .reading-col），窄窗回落可用宽 − 进度轨。
    private var readingColWidth: CGFloat { 640 }

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
    }

    /// 滚到哪读到哪：视口上三分之一高度处的那一句为「当前句」。
    private func adoptViewportFrames(_ frames: [Int: CGFloat], containerHeight: CGFloat) {
        let line = containerHeight / 3
        let above = frames.filter { $0.value <= line }
        let candidate = above.keys.max() ?? frames.keys.min()
        guard let idx = candidate else { return }
        DispatchQueue.main.async {
            vm.viewportMoved(to: idx)
        }
    }

    /// 滚动锚点：对照行 = 句行 id；prose = 所在段块（句卡模式 = 该句卡）。
    private func scrollAnchor(for idx: Int, article: Article) -> AnyHashable {
        if layout == .parallel { return AnyHashable(idx) }
        if sentCards { return AnyHashable("prose-sent-\(idx)") }
        return AnyHashable("prose-para-\(article.sentences[safe: idx]?.paragraphIdx ?? 0)")
    }
}

/// 译文浮层的锚点（正文内容坐标系）：末行底 + 末行句尾右缘（列内）。
struct PopAnchor: Equatable {
    let minY: CGFloat
    let maxY: CGFloat
    /// 末行句尾在列内的 x（含列 24pt 内边距折算）。
    let rightInCol: CGFloat

    /// 箭头 x：末行右缘 − 24(col padding) − 20(箭头半宽)，clamp 到
    /// [16, col宽 − 48 − 44] 不溢出（ReadingView.tsx:310-312 同式）。
    func arrowX(colWidth: CGFloat) -> CGFloat {
        let ax = rightInCol - 24 - 20
        return min(max(ax, 16), max(16, colWidth - 48 - 44))
    }
}

/// 滚动跟随的句 minY 回报键（滚动面板坐标系）。
private struct RowFramesKey: PreferenceKey {
    typealias Value = [Int: CGFloat]

    static var defaultValue: [Int: CGFloat] = [:]

    static func reduce(value: inout [Int: CGFloat], nextValue: () -> [Int: CGFloat]) {
        value.merge(nextValue()) { _, new in new }
    }
}

/// 译文浮层锚点回报键（正文内容坐标系：句末行 rect）。
struct PopAnchorKey: PreferenceKey {
    static var defaultValue: [Int: PopAnchor] = [:]

    static func reduce(value: inout [Int: PopAnchor], nextValue: () -> [Int: PopAnchor]) {
        value.merge(nextValue()) { _, new in new }
    }
}

/// 句对行列表（独立结构体，减轻主 body 的类型推断负担）。对照排版（.parallel-spread-row）：
/// 段首行 paragraph-start、当前句 is-current、失败 failed；行点击定位。
struct ArticleRows: View {
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

/// 工具栏收口（.reading-toolbar，ReadingView.tsx:836-899）：左 meta（书·章·词数·
/// 分钟·level·翻译/词块标注 chip）+ 遮罩开关组 + 目录 chip + 阅读设置 chip。
struct ReadingToolbarView: View {
    @ObservedObject var vm: ReaderViewModel
    @Binding var settingsOpen: Bool
    @Binding var sentCards: Bool
    @Environment(\.readerPalette) private var palette

    var body: some View {
        let article = vm.article
        let sentences = article?.sentences ?? []
        let maskOn = vm.effectiveSettings.maskTranslation
        let peek = vm.peekAll
        let maskable = maskOn ? sentences.filter { $0.zh != nil }.count : 0
        let revealed = maskOn ? sentences.filter { $0.zh != nil && ($0.revealed == true || peek) }.count : 0
        let readMinutes = article.map { max(1, Int((Double($0.wordCount) / 200).rounded())) } ?? 1
        return HStack(spacing: 12) {
            // 左 meta（书章 / 短文共用一行；ReadingView.tsx:837-840）：
            // `{book.title} · 第 {x}/{N} 章 · {words} 词 · 约 {m} 分钟`（短文无书前缀）。
            if let article {
                let bookPrefix: String = {
                    guard let bookId = article.bookId,
                          let book = vm.bookList.first(where: { $0.id == bookId }) else { return "" }
                    return "\(book.title) · 第 \(bookChapterIndexOf(book: book, chapterId: article.id) + 1)/\(book.chapters.count) 章 · "
                }()
                Text("\(bookPrefix)\(article.wordCount.formatted()) 词 · 约 \(readMinutes) 分钟")
                    .font(.system(size: 11, design: .monospaced))
                    .monospacedDigit()
                    .foregroundColor(palette.textTertiary)
                    .lineLimit(1)
            }
            if let level = article?.level, !level.isEmpty {
                Text(level)
                    .font(.system(size: 10.5, weight: .semibold))
                    .foregroundColor(palette.textTertiary)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(RoundedRectangle(cornerRadius: 4, style: .continuous).fill(palette.tapeBg))
            }
            if let translating = vm.translating {
                statusChip("翻译中 \(translating.done)/\(translating.total) 段")
            }
            if vm.translating == nil, let chunking = vm.chunking {
                statusChip("词块标注中 \(chunking.done)/\(chunking.total) 批")
            }
            Spacer(minLength: 8)
            // 遮罩控件组（ReadingView.tsx:853-876）
            HStack(spacing: 8) {
                Toggle("", isOn: Binding(
                    get: { vm.effectiveSettings.maskTranslation },
                    set: { value in vm.patchSettings { $0.maskTranslation = value } }
                ))
                .toggleStyle(.switch)
                .controlSize(.mini)
                .labelsHidden()
                .accessibilityLabel("译文遮罩")
                Text("译文遮罩")
                    .font(.system(size: 11.5, weight: .semibold))
                    .foregroundColor(palette.text)
                Text(maskOn ? "已揭开 \(revealed) / \(maskable) 句" : "译文常显")
                    .font(.system(size: 11))
                    .monospacedDigit()
                    .foregroundColor(palette.textTertiary)
                if maskOn, revealed < maskable {
                    Button("全部揭开") { vm.revealAll() }
                        .controlSize(.small)
                }
                if maskOn, revealed > 0 {
                    Button("全部遮住") { vm.maskAll() }
                        .controlSize(.small)
                }
            }
            .help("遮住译文先读原文，需要时再点开；按住 H 临时全显")
            // 随读抽查战绩（ReadingView.tsx:877-881，quizOn 且有槽位时）：
            // `抽查 {hit} 命中 · {close} 接近 · {trap} 陷阱 · 剩 {todo}`。
            if vm.clozeQuizOn, !vm.clozeSlots.isEmpty {
                Text(clozeMeterText(vm.clozeTallyNow))
                    .font(.system(size: 11, design: .monospaced))
                    .monospacedDigit()
                    .foregroundColor(palette.textTertiary)
                    .lineLimit(1)
                    .fixedSize()
                    .help("随读抽查战绩：命中 · 接近 · 陷阱 · 待答")
                    .accessibilityLabel("随读抽查战绩")
            }
            // 目录 chip（书章才有；ReadingView.tsx:882-887）
            if vm.currentBook != nil {
                Button {
                    vm.bookTocShown = true
                } label: {
                    Label("目录", systemImage: ReaderIcons.toc)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(palette.textSecondary)
                        .padding(.horizontal, 10)
                        .frame(height: 24)
                        .background(Capsule().strokeBorder(palette.glassBorderStrong, lineWidth: 1))
                }
                .buttonStyle(.plain)
                .help("章节目录")
            }
            // 阅读设置 chip（ReadingView.tsx:888-898）
            Button {
                settingsOpen.toggle()
            } label: {
                Label("阅读设置", systemImage: ReaderIcons.gear)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(settingsOpen ? palette.accent : palette.textSecondary)
                    .padding(.horizontal, 10)
                    .frame(height: 24)
                    .background(
                        Capsule().fill(settingsOpen ? palette.accentSoft : Color.clear)
                    )
                    .overlay(Capsule().strokeBorder(palette.glassBorderStrong, lineWidth: 1))
            }
            .buttonStyle(.plain)
            .help("排版 / 字号 / 专注 / 短语虚线 / 随读抽查都收在这里")
            .accessibilityLabel("阅读设置")
            .accessibilityAddTraits(settingsOpen ? [.isSelected] : [])
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 8)
        .overlay(alignment: .bottom) {
            Rectangle().fill(palette.glassBorder.opacity(0.5)).frame(height: 1)
        }
    }

    private func statusChip(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 11, weight: .medium))
            .foregroundColor(palette.warn)
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background(palette.warn.opacity(0.12))
            .clipShape(Capsule())
    }
}

/// 阅读设置浮层（.reading-settings-pop，ReadingView.tsx:902-1004）：排版 seg /
/// 句卡 / 字号步进 / 短语虚线 / 专注模式 / 随读抽查 / 主题只读，七项逐字。
/// Windows 浮层只有 `role="dialog" aria-label="阅读设置"`，无可见标题行与关闭钮——
/// 关闭靠点浮层外（ReadingStageView 的遮罩层）、再点触发 chip 或 Esc。
struct ReadingSettingsPopover: View {
    @ObservedObject var vm: ReaderViewModel
    @Binding var sentCards: Bool
    @Environment(\.readerPalette) private var palette

    private var settings: ReaderSettings { vm.effectiveSettings }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // 排版（段落 / 对照）
            optionRow(label: "排版") {
                HStack(spacing: 2) {
                    segButton("段落", active: settings.effectiveSpreadLayout == .prose,
                              help: "段落 = 行内英文流 + 当前句译文浮层") {
                        vm.patchSettings { $0.spreadLayout = .prose }
                    }
                    segButton("对照", active: settings.effectiveSpreadLayout == .parallel,
                              help: "双语对照 = 逐句双栏") {
                        vm.patchSettings { $0.spreadLayout = .parallel }
                    }
                }
                .padding(2)
                .background(Capsule().fill(palette.background))
                .overlay(Capsule().strokeBorder(palette.glassBorder, lineWidth: 1))
            }
            // 句卡（仅段落排版可用；本地态不落盘）
            optionRow(label: "句卡", help: "段落排版下把每句拆成独立句卡（只影响本窗口，不落盘）") {
                Toggle("", isOn: $sentCards)
                    .toggleStyle(.switch)
                    .controlSize(.mini)
                    .labelsHidden()
                    .disabled(settings.effectiveSpreadLayout != .prose)
                    .accessibilityLabel("句卡")
            }
            // 字号 14–24 步进
            optionRow(label: "字号") {
                HStack(spacing: 8) {
                    Button {
                        vm.patchSettings { $0.fontSize = max(readerFontSizeMin, $0.fontSize - 1) }
                    } label: {
                        Text("−").frame(width: 22, height: 22)
                    }
                    .buttonStyle(.plain)
                    .disabled(settings.fontSize <= readerFontSizeMin)
                    .accessibilityLabel("减小字号")
                    Text("\(settings.fontSize)")
                        .font(.system(size: 12, weight: .semibold).monospacedDigit())
                        .foregroundColor(palette.text)
                        .frame(minWidth: 20)
                    Button {
                        vm.patchSettings { $0.fontSize = min(readerFontSizeMax, $0.fontSize + 1) }
                    } label: {
                        Text("+").frame(width: 22, height: 22)
                    }
                    .buttonStyle(.plain)
                    .disabled(settings.fontSize >= readerFontSizeMax)
                    .accessibilityLabel("增大字号")
                }
                .background(Capsule().strokeBorder(palette.glassBorderStrong, lineWidth: 1))
            }
            // 短语虚线
            optionRow(label: "短语虚线", help: "词块/生词在正文里用虚线标记，点击看释义并可收藏") {
                Toggle("", isOn: Binding(
                    get: { settings.chunkHighlight },
                    set: { value in vm.patchSettings { $0.chunkHighlight = value } }
                ))
                .toggleStyle(.switch)
                .controlSize(.mini)
                .labelsHidden()
                .accessibilityLabel("短语虚线")
            }
            // 专注模式
            optionRow(label: "专注模式", help: "非当前句变淡 + 收起右侧解析面板，注意力聚焦当前句") {
                Toggle("", isOn: Binding(
                    get: { settings.spotlightEnabled },
                    set: { value in vm.patchSettings { $0.spotlightMode = value } }
                ))
                .toggleStyle(.switch)
                .controlSize(.mini)
                .labelsHidden()
                .accessibilityLabel("专注模式")
            }
            // 随读抽查
            optionRow(label: "随读抽查", help: "已读句的词块/生词变行内填空：Enter 判分 · ? 首字母提示 · 按住 H 显影。只考读过的句子，本地判分不耗流量") {
                Toggle("", isOn: Binding(
                    get: { settings.spotQuizEnabled },
                    set: { value in vm.patchSettings { $0.spotQuizMode = value } }
                ))
                .toggleStyle(.switch)
                .controlSize(.mini)
                .labelsHidden()
                .accessibilityLabel("随读抽查")
            }
            // 主题只读行
            optionRow(label: "主题") {
                Text(settings.theme.label)
                    .font(.system(size: 12))
                    .foregroundColor(palette.textSecondary)
            }
        }
        .padding(14)
        .frame(width: 300)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(palette.glassElevated)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        )
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(palette.glassBorderStrong, lineWidth: 1))
        .shadow(color: palette.shadowSpatial, radius: 14, y: 6)
        // `role="dialog" aria-label="阅读设置"`：无可见标题，只给辅助功能命名。
        .accessibilityElement(children: .contain)
        .accessibilityLabel("阅读设置")
    }

    @ViewBuilder
    private func optionRow<Content: View>(
        label: String,
        help: String? = nil,
        @ViewBuilder content: () -> Content
    ) -> some View {
        HStack {
            Text(label)
                .font(.system(size: 12))
                .foregroundColor(palette.text)
                .frame(width: 64, alignment: .leading)
            content()
            Spacer(minLength: 0)
        }
        .help(help ?? "")
    }

    private func segButton(_ title: String, active: Bool, help: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 11.5, weight: active ? .semibold : .medium))
                .foregroundColor(active ? palette.text : palette.textTertiary)
                .padding(.horizontal, 12)
                .frame(height: 22)
                .background {
                    if active {
                        Capsule()
                            .fill(palette.glassElevated)
                            .shadow(color: Color.black.opacity(0.08), radius: 3, y: 1)
                    }
                }
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
        .help(help)
    }
}

/// 左缘进度轨（.reading-rail，ReadingView.tsx:1021-1029）：百分比数字 + 竖轨填充 +
/// label（书章 CHAPTER N / 短文文章标题）。口径 = 光标句/总句（与 dock 同源）。
struct ReadingRailView: View {
    let article: Article
    @ObservedObject var vm: ReaderViewModel
    @Environment(\.readerPalette) private var palette

    var body: some View {
        let total = article.sentences.count
        let percent = readingRailPercent(activeIdx: vm.activeSentenceIdx, total: total)
        let chapterIdx: Int? = article.bookId.flatMap { bookId in
            vm.bookList.first(where: { $0.id == bookId }).map {
                bookChapterIndexOf(book: $0, chapterId: article.id)
            }
        }
        VStack(spacing: 8) {
            Text("\(percent)%")
                .font(.system(size: 10.5, weight: .semibold, design: .monospaced))
                .monospacedDigit()
                .foregroundColor(palette.textTertiary)
            GeometryReader { geo in
                ZStack(alignment: .top) {
                    Capsule().fill(palette.glassBorderStrong)
                    Capsule()
                        .fill(palette.accent)
                        .frame(height: max(0, geo.size.height * CGFloat(percent) / 100))
                        .animation(ReaderMotion.islandTab, value: percent)
                }
            }
            .frame(width: 3)
            .frame(maxHeight: .infinity)
            Text(readingRailLabel(chapterIdx: chapterIdx, articleTitle: article.title))
                .font(.system(size: 10, design: .monospaced))
                .tracking(1)
                .foregroundColor(palette.textTertiary)
                .lineLimit(3)
                .multilineTextAlignment(.center)
                .frame(width: 56)
                .help(article.title)
        }
        .accessibilityHidden(true)
    }
}

/// 续读胶囊（.resume-capsule，ReadingView.tsx:1032-1059）：上次读到 第 N 句 +
/// 「回到那里」+ 关闭（只是隐藏提示，断点仍在）；换文复位；翻译中不显示。
struct ResumeCapsuleView: View {
    let resumeIdx: Int
    let palette: ReaderPalette
    let onGo: () -> Void
    let onClose: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "bookmark")
                .font(.system(size: 11))
                .foregroundColor(palette.accent)
            Text("上次读到")
                .font(.system(size: 12))
                .foregroundColor(palette.textSecondary)
            Text("第 \(resumeIdx + 1) 句")
                .font(.system(size: 12, weight: .semibold))
                .monospacedDigit()
                .foregroundColor(palette.text)
            Button("回到那里", action: onGo)
                .font(.system(size: 11.5, weight: .semibold))
                .buttonStyle(.link)
                .help("回到上次读到的句子")
            Button {
                onClose()
            } label: {
                Image(systemName: ReaderIcons.close)
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundColor(palette.textTertiary)
                    .frame(width: 18, height: 18)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("关闭续读提示")
            .help("只是隐藏提示，断点仍在")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(Capsule().fill(palette.glassElevated))
        .overlay(Capsule().strokeBorder(palette.glassBorderStrong, lineWidth: 1))
        .shadow(color: palette.shadowPill, radius: 8, y: 3)
        .accessibilityElement(children: .contain)
    }
}

/// 刊头（.reading-head，ReadingView.tsx:1061-1101）：书章 eyebrow `CHAPTER N ·
/// 书名大写` + 32pt 标题 + 中文副题三态（titleCn / 失败+重试 / 骨架）+
/// 「围绕本章练口语」按钮（仅书章）。
struct ReadingHeadView: View {
    let article: Article
    @ObservedObject var vm: ReaderViewModel
    @Environment(\.readerPalette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let book = currentBook {
                Text("CHAPTER \(bookChapterIndexOf(book: book, chapterId: article.id) + 1) · \(book.title.uppercased())")
                    .font(.system(size: 11, weight: .semibold, design: .monospaced))
                    .tracking(1.5)
                    .foregroundColor(palette.textTertiary)
                    .padding(.bottom, 8)
            }
            Text(article.title)
                .font(readerDisplayFont(32))
                .lineSpacing(2)
                .minimumScaleFactor(0.7)
                .lineLimit(3)
                .foregroundColor(palette.text)
                .padding(.bottom, 6)
            subtitleRow
        }
        .padding(.bottom, 22)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var currentBook: BookMeta? {
        guard let bookId = article.bookId else { return nil }
        return vm.bookList.first(where: { $0.id == bookId })
    }

    private var subtitleRow: some View {
        HStack(alignment: .firstTextBaseline) {
            if let titleCn = article.titleCn {
                Text(titleCn)
                    .font(readerFont(15, .regular, pair: vm.effectiveSettings.fontPair))
                    .foregroundColor(palette.textSecondary)
            } else if article.titleCnState == .failed {
                ReaderTitleFailedRow(vm: vm)
            } else if vm.translating != nil {
                SkeletonLine(width: 220)
                    .padding(.vertical, 4)
            }
            Spacer(minLength: 12)
            if currentBook != nil {
                Button {
                    vm.practiceChapter(idx: vm.activeSentenceIdx)
                } label: {
                    Label("围绕本章练口语", systemImage: "mic")
                        .font(.system(size: 11.5, weight: .semibold))
                        .foregroundColor(palette.text)
                        .padding(.horizontal, 11)
                        .frame(height: 26)
                        .background(Capsule().strokeBorder(palette.glassBorderStrong, lineWidth: 1))
                }
                .buttonStyle(.plain)
                .help("带着本章内容去口语陪练")
            }
        }
        .padding(.top, 4)
    }
}

/// 段落失败行（对照行 failedBody 与行间折叠卡共用）：主文案 + 原因小字 +
/// 重试按钮。对齐 ReadingView.tsx pair-failed-row 两分支逐字相同的实现
///（文案/字号/透明度一致；zhError 缺省时不渲染小字，与旧行为完全一致）。
///（internal：失败行渲染单测直接构造本行断言 zhError 小字。）
struct ReaderFailedRow: View {
    @ObservedObject var vm: ReaderViewModel
    let pair: SentencePair
    @Environment(\.readerPalette) private var palette

    var body: some View {
        HStack(spacing: 10) {
            Text("本段翻译失败")
                .font(.system(size: 12))
                .foregroundColor(palette.err)
            if let zhError = pair.zhError {
                // 失败原因小字（错误色 11pt、0.8 透明度）。
                Text(zhError)
                    .font(.system(size: 11))
                    .foregroundColor(palette.err.opacity(0.8))
            }
            Button("重试本段") { vm.retryParagraph(pair.paragraphIdx) }
                .buttonStyle(.link)
                .font(.system(size: 12))
        }
    }
}

/// 标题失败行（刊头中文副题用）：主文案 + 全角括号原因（瞬态，不落盘）+
/// 重试按钮。对齐 ReadingView.tsx:1071-1081。
///（internal：标题失败行渲染单测直接构造。）
struct ReaderTitleFailedRow: View {
    @ObservedObject var vm: ReaderViewModel
    @Environment(\.readerPalette) private var palette

    var body: some View {
        HStack(spacing: 8) {
            Text("标题翻译失败")
                .font(.system(size: 13))
                .foregroundColor(palette.err)
            if let titleCnError = vm.titleCnError {
                // 失败原因（全角括号包裹、0.85 透明度；重启后只剩主文案）。
                Text("（\(titleCnError)）")
                    .font(.system(size: 13))
                    .foregroundColor(palette.err.opacity(0.85))
            }
            Button("重试") { vm.retryTitle() }
                .buttonStyle(.link)
                .font(.system(size: 13))
        }
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
    /// 随读抽查槽位附件 rect（句行本地坐标；输入框 / 印章覆盖层定位）。
    @State private var clozeRects: [String: CGRect] = [:]

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
        .contentShape(Rectangle())
        .onTapGesture {
            // 整行点击定位（ReadingView.tsx:1140 parallel-spread-row onClick）。
            vm.jumpTo(idx: pair.idx)
        }
        .help("点击定位到这一句")
    }

    private func rowActions(editing: Bool, showEdit: Bool) -> some View {
        VStack(spacing: 6) {
            Button {
                // 播放中点当前句 = 停止；否则只读这一句读完自动停（ReadingView.tsx:717-727）。
                if vm.playbackPlaying && isActive {
                    vm.stopPlayback()
                } else {
                    vm.speakSentenceOnce(pair.idx)
                }
            } label: {
                Image(systemName: ReaderIcons.speaker)
                    .font(.system(size: 11))
                    .foregroundColor(isActive ? palette.accent : palette.textTertiary)
                    .frame(width: 20, height: 20)
            }
            .buttonStyle(.plain)
            .help(vm.playbackPlaying && isActive
                ? "停止朗读（Space / 播放条的 ⏸ 也可以）"
                : "朗读这一句（读完自动停，不会连读下去）")
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
        // 本句挖空槽（对照行通道；句内坐标）。
        let clozeMarks = [vm.clozeRenderMark(sentenceIdx: pair.idx, offset: 0)].compactMap { $0 }
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
            clauseIndigoSoftColor: NSColor(palette.clauseIndigoSoft),
            clozeMarks: clozeMarks,
            clozeStyle: clozeMarks.isEmpty ? nil : clozeCellStyle(font: nsFont, palette: palette),
            onClozeRects: { rects in clozeRects = rects }
        )
        .overlay(alignment: .topLeading) {
            if !clozeMarks.isEmpty {
                ClozeOverlayLayer(
                    vm: vm,
                    marks: clozeMarks,
                    rects: clozeRects,
                    slots: Dictionary(uniqueKeysWithValues: vm.clozeSlots.values.map { ($0.id, $0) }),
                    fontSize: CGFloat(settings.fontSize),
                    palette: palette
                )
            }
        }
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
        ReaderFailedRow(vm: vm, pair: pair)
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

// MARK: - 画报正文（prose：段落英文流 + 当前句译文浮层；2026-10-26 白卡重构）

/// 段落英文流：按 paragraphIdx 分段，段内句子在同一个文本块里连续排版，句间补空格；
/// 当前句的译文由列内浮层（TranslationPopView）承载，不再拆段落。句卡开启时每句
/// 拆成独立句卡（本地态不落盘，Windows sent-cards 同语义）。首段首字母下沉。
private struct ProseBodyView: View {
    let article: Article
    @ObservedObject var vm: ReaderViewModel
    var sentCards: Bool = false
    @Environment(\.readerPalette) private var palette

    /// 正文按 paragraphIdx 分组（ReadingView.tsx:217-225 同口径）。
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
        if sentCards {
            // 句卡：每句一个独立小卡（只影响本窗口，不落盘）。
            LazyVStack(alignment: .leading, spacing: 8) {
                ForEach(article.sentences, id: \.idx) { sentence in
                    sentenceCard(sentence, spotlight: spotlight)
                        .id("prose-sent-\(sentence.idx)")
                }
            }
            .padding(.bottom, 8)
        } else {
            VStack(alignment: .leading, spacing: 9) {
                ForEach(paragraphs, id: \.first?.idx) { para in
                    ProseBlockView(
                        pieces: makePieces(para),
                        article: article,
                        vm: vm,
                        spotlight: spotlight,
                        isFirstBlock: para.first?.idx == article.sentences.first?.idx
                    )
                    .id("prose-para-\(para.first?.paragraphIdx ?? 0)")
                }
            }
        }
    }

    private func sentenceCard(_ sentence: SentencePair, spotlight: Bool) -> some View {
        ProseBlockView(
            pieces: makePieces([sentence]),
            article: article,
            vm: vm,
            spotlight: spotlight,
            isFirstBlock: sentence.idx == article.sentences.first?.idx
        )
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(palette.glassSurface.opacity(0.5))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(
                    sentence.idx == vm.activeSentenceIdx ? palette.accent.opacity(0.4) : palette.glassBorder,
                    lineWidth: 1
                )
        )
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
/// 词块/生词跨度、跟读着色折算到拼接坐标；句子 minY 回报给滚动跟随，
/// 末行 rect 回报给译文浮层锚定。
private struct ProseBlockView: View {
    let pieces: [ProsePiece]
    let article: Article
    @ObservedObject var vm: ReaderViewModel
    let spotlight: Bool
    let isFirstBlock: Bool
    @Environment(\.readerPalette) private var palette
    @State private var localFrames: [Int: CGFloat] = [:]
    @State private var localRects: [Int: ReaderProseText.SentenceRect] = [:]
    /// 随读抽查槽位附件 rect（块本地坐标；输入框 / 印章覆盖层定位）。
    @State private var localClozeRects: [String: CGRect] = [:]

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
        let clozeMarks = clozeMarks
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
            onSentenceFrames: { frames in localFrames = frames },
            onSentenceRects: { rects in localRects = rects },
            clozeMarks: clozeMarks,
            clozeStyle: clozeMarks.isEmpty ? nil : clozeCellStyle(font: nsFont, palette: palette),
            onClozeRects: { rects in localClozeRects = rects }
        )
        .overlay(alignment: .topLeading) {
            // 随读抽查覆盖层：待答槽行内输入 + ? 提示 / 已答槽印章（ReadingView.tsx:520-593）。
            if !clozeMarks.isEmpty {
                ClozeOverlayLayer(
                    vm: vm,
                    marks: clozeMarks,
                    rects: localClozeRects,
                    slots: Dictionary(uniqueKeysWithValues: vm.clozeSlots.values.map { ($0.id, $0) }),
                    fontSize: CGFloat(settings.fontSize),
                    palette: palette
                )
            }
        }
        .background(
            GeometryReader { geo in
                Color.clear
                    .preference(
                        key: RowFramesKey.self,
                        value: localFrames.mapValues { $0 + geo.frame(in: .named("readerScroll")).minY }
                    )
                    .preference(
                        key: PopAnchorKey.self,
                        value: localRects.mapValues { rect in
                            // 折算到「正文内容」坐标系（content 坐标随滚动不动，
                            // 浮层因此贴着内容走）；右缘含列 24pt 内边距。
                            PopAnchor(
                                minY: geo.frame(in: .named("readingContent")).minY + rect.minY,
                                maxY: geo.frame(in: .named("readingContent")).minY + rect.maxY,
                                rightInCol: rect.lastLineRight + 24
                            )
                        }
                    )
            }
        )
    }

    /// 本块各句的挖空槽（拼接坐标；开关关闭 / 未读句无槽 → 空集，正文零残留）。
    private var clozeMarks: [ClozeRenderMark] {
        pieces.compactMap { vm.clozeRenderMark(sentenceIdx: $0.idx, offset: $0.start) }
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

/// 译文浮层（.translation-pop，ReadingView.tsx:746-824）：锚定当前句末行下方、
/// 脱离文档流。编辑中 → 手改译文编辑器；段失败 → 失败行；遮罩中 → veil 按钮；
/// 常规 → 译文（点按回遮）+ 操作行（朗读本句 / 用这句练口语 / 编辑译文 +
/// 遮罩开时「按住 H 看译文」）。句子解析入口唯一化在右侧面板，浮层不重复。
struct TranslationPopView: View {
    @ObservedObject var vm: ReaderViewModel
    let pair: SentencePair
    let editing: Bool
    @Binding var editDraft: String
    var arrowX: CGFloat = 16
    let onStartEdit: () -> Void
    let onCancelEdit: () -> Void
    let onCommitEdit: () -> Void
    @Environment(\.readerPalette) private var palette
    @State private var hover = false

    var body: some View {
        let settings = vm.effectiveSettings
        let maskOn = settings.maskTranslation
        let isActive = pair.idx == vm.activeSentenceIdx
        let masked = maskOn && pair.zh != nil && pair.zhState != .failed && !editing
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
                ReaderFailedRow(vm: vm, pair: pair)
            } else if masked {
                Button {
                    vm.reveal(pair.idx)
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: ReaderIcons.eyeOff).font(.system(size: 12))
                        Text("点击显示译文")
                            .font(.system(size: 12.5, weight: .medium))
                    }
                    .foregroundColor(palette.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 4)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("点按显示这一句的译文")
            } else {
                zhBody(maskOn: maskOn)
                actionsRow(maskOn: maskOn, isActive: isActive)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(width: 464, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(palette.glassElevated)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(palette.glassBorderStrong, lineWidth: 1)
        )
        .overlay(alignment: .top) {
            // 箭头：末行下方 10pt 处指向句尾（x 由 PopAnchor.arrowX 折算）。
            Triangle()
                .fill(palette.glassElevated)
                .frame(width: 16, height: 8)
                .overlay(
                    Triangle()
                        .stroke(palette.glassBorderStrong, lineWidth: 1)
                        .padding(0.5)
                )
                .offset(x: arrowX - 232, y: -7)
        }
        .shadow(color: palette.shadowSpatial, radius: 16, y: 8)
    }

    @ViewBuilder
    private func zhBody(maskOn: Bool) -> some View {
        let cnFont = readerFont(14, pair: vm.effectiveSettings.fontPair)
        Group {
            if pair.zhState == .pending {
                if let zh = pair.zh {
                    Text(zh)
                        .font(cnFont)
                        .foregroundColor(palette.textSecondary.opacity(0.75))
                        .lineSpacing(4)
                } else if vm.translating != nil {
                    SkeletonLine(width: 160)
                } else {
                    Text("译文待生成")
                        .font(.system(size: 12))
                        .foregroundColor(palette.textTertiary)
                }
            } else if let zh = pair.zh {
                Text(zh)
                    .font(cnFont)
                    .foregroundColor(palette.textSecondary)
                    .lineSpacing(4)
                    .fixedSize(horizontal: false, vertical: true)
                    .contentShape(Rectangle())
                    .onTapGesture {
                        guard maskOn else { return }
                        // 遮罩开时点按回遮（ReadingView.tsx:776-780）。
                        vm.mask(pair.idx)
                    }
                    .help(maskOn ? "点按重新遮住" : "")
            }
        }
    }

    private func actionsRow(maskOn: Bool, isActive: Bool) -> some View {
        HStack(spacing: 14) {
            Button {
                if vm.playbackPlaying && isActive {
                    vm.stopPlayback()
                } else {
                    vm.speakSentenceOnce(pair.idx)
                }
            } label: {
                Label("朗读本句", systemImage: ReaderIcons.speaker)
                    .font(.system(size: 11.5))
            }
            .buttonStyle(.plain)
            .foregroundColor(palette.textSecondary)
            .help(vm.playbackPlaying && isActive
                ? "停止朗读（Space / 播放条的 ⏸ 也可以）"
                : "朗读这一句（读完自动停，不会连读下去）")
            Button {
                vm.practiceSentence(idx: pair.idx)
            } label: {
                Label("用这句练口语", systemImage: "mic")
                    .font(.system(size: 11.5))
            }
            .buttonStyle(.plain)
            .foregroundColor(palette.textSecondary)
            .help("带着这句去口语陪练")
            if pair.zh != nil, pair.zhState != .pending, !editing {
                Button(action: onStartEdit) {
                    Label("编辑译文", systemImage: ReaderIcons.edit)
                        .font(.system(size: 11.5))
                }
                .buttonStyle(.plain)
                .foregroundColor(palette.textSecondary)
                .help("手改译文")
            }
            if maskOn {
                HStack(spacing: 3) {
                    Text("按住")
                    Text("H").font(.system(size: 10, weight: .semibold, design: .monospaced))
                        .padding(.horizontal, 4).padding(.vertical, 1)
                        .background(palette.glassBorder)
                        .clipShape(RoundedRectangle(cornerRadius: 3))
                    Text("看译文")
                }
                .font(.system(size: 11))
                .foregroundColor(palette.textTertiary)
            }
            Spacer(minLength: 0)
        }
    }
}

/// 浮层箭头小三角（形状无关内容）。
private struct Triangle: Shape {
    func path(in rect: CGRect) -> Path {
        var p = Path()
        p.move(to: CGPoint(x: rect.minX, y: rect.maxY))
        p.addLine(to: CGPoint(x: rect.midX, y: rect.minY))
        p.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
        p.closeSubpath()
        return p
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
                .font(.system(size: 22))
                .foregroundColor(palette.accent)
            Text("从一篇短文开始")
                .font(.system(size: 15, weight: .semibold))
                .foregroundColor(palette.text)
            // 引导文逐字对齐 ReadingView.tsx:1254-1258（快捷键 Mac 用 ⌘⇧R）。
            (
                Text("挑一篇感兴趣的英文读进来——逐句精读，查过的词自动进生词本，隔天到期复习。内置分级文库不需要自己找材料。也可以在任意应用里选中文字，点浮窗上的「发送到阅读室」，或按 ")
                + Text("⌘").fontWeight(.semibold)
                + Text("+")
                + Text("⇧").fontWeight(.semibold)
                + Text("+")
                + Text("R").fontWeight(.semibold)
                + Text("。")
            )
                .font(.system(size: 12.5))
                .foregroundColor(palette.textSecondary)
                .multilineTextAlignment(.center)
                .lineSpacing(4)
                .frame(maxWidth: 400)
                .fixedSize(horizontal: false, vertical: true)
            Button("添加阅读内容", action: onImport)
                .controlSize(.regular)
                .padding(.top, 8)
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
    /// 语音页生效服务商（云音色来源）；nil = 读取中（对齐 SettingsDrawer.tsx:95）。
    @State private var drawerVoiceProvider: VoiceProvider?
    /// 沉浸云真实登录态（App 层镜像，AppAuthStatusCenter；nil = 读取中）；
    /// 来源是 gateway 不代表已登录。
    @ObservedObject private var authCenter = AppAuthStatusCenter.shared
    private var gatewayLoggedIn: Bool? { authCenter.status?.loggedIn }

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
                                    get: {
                                        // 旧 xfyun 值 UI 上并入「云音色」档高亮
                                        //（SettingsDrawer.tsx:446-447）；点选写 cloud。
                                        settings.ttsProvider == .xfyun ? TtsProvider.cloud : settings.ttsProvider
                                    },
                                    set: { value in vm.patchSettings { $0.ttsProvider = value } }
                                )) {
                                    Text("Edge 在线").tag(TtsProvider.edge)
                                    Text("云音色").tag(TtsProvider.cloud)
                                    Text("系统语音").tag(TtsProvider.local)
                                }
                                .labelsHidden()
                                .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .help("Edge 在线 = 微软神经音色（免费、无需凭据，默认）；云音色 = 跟随语音页所选服务商（沉浸云或讯飞）；本地 = 系统语音（离线可用）")
                            if settings.ttsProvider == .cloud || settings.ttsProvider == .xfyun {
                                cloudVoiceSourceRows(settings: settings)
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
            // 语音页生效服务商（云音色档来源）：已存值优先，否则按讯飞凭据迁移推断。
            drawerVoiceProvider = resolveInitialVoiceProvider(stored: VoicePrefsStore.loadProvider())
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


    // MARK: - 云音色档来源行（对齐 Windows SettingsDrawer.tsx:509-611 文案逐字）

    /// 云音色档的分支行：gateway（音色来源/服务说明/去语音页配置）或 xfyun
    /// （vcn 两输入 + 凭据状态 + 设置按钮）。抽屉内不重复配置网关音色。
    @ViewBuilder
    private func cloudVoiceSourceRows(settings: ReaderSettings) -> some View {
        if drawerVoiceProvider == nil {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    rowLabel("音色来源")
                    Spacer()
                    Text("读取中…")
                        .font(.system(size: 11.5))
                        .foregroundColor(palette.textSecondary)
                }
                .help("正在读取语音页服务商")
            }
        } else if drawerVoiceProvider == .gateway {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    rowLabel("音色来源")
                    Spacer()
                    Text(gatewayLoginText)
                        .font(.system(size: 11.5))
                        .foregroundColor(gatewayLoggedIn == true ? palette.accent : palette.textSecondary)
                }
                .help("云音色来源跟随语音页所选服务商；这里不重复配置音色")
                HStack {
                    rowLabel("服务说明")
                    Spacer()
                    Text(gatewayServiceText)
                        .font(.system(size: 11.5))
                        .foregroundColor(palette.textSecondary)
                    Button(gatewayLoggedIn == false ? "去语音页登录" : "去语音页配置") {
                        openVoiceSettingsTab()
                    }
                    .controlSize(.small)
                    .buttonStyle(.bordered)
                    .help(gatewayLoggedIn == false ? "打开设置 → 语音页登录沉浸云" : "打开设置 → 语音页配置音色")
                }
                .help("沉浸云按句流式合成，首个分片到达即开始播放；音色在语音页选择后即时生效")
            }
        } else {
            VStack(alignment: .leading, spacing: 6) {
                cloudVoiceField(label: "云音色·中文", text: settings.cloudVoice, placeholder: "xiaoyan") { value in
                    vm.patchSettings { $0.cloudVoice = value }
                }
                .help("讯飞中文发音人（vcn）：中文句用它读；完整列表在讯飞控制台「语音合成」可试听，未授权音色会提示 11200。已播句子进缓存（内存+磁盘），重听不耗每日次数")
                cloudVoiceField(label: "云音色·英文", text: settings.cloudVoiceEn, placeholder: "catherine") { value in
                    vm.patchSettings { $0.cloudVoiceEn = value }
                }
                .help("讯飞英文发音人（vcn）：英文句用它读，跟读示范不再由中文音色代劳；留空沿用中文音色")
                HStack {
                    rowLabel("合成凭据")
                    Spacer()
                    Text(XfyunCredentialsStore.shared.isComplete(.tts) ? "已配置 ✓" : "未配置")
                        .font(.system(size: 11.5))
                        .foregroundColor(XfyunCredentialsStore.shared.isComplete(.tts) ? palette.accent : palette.textSecondary)
                    Button("设置") {
                        (NSApp.delegate as? AppDelegate)?.openSettingsFromReader()
                    }
                    .controlSize(.small)
                    .buttonStyle(.bordered)
                }
                .help("讯飞凭据（评测/合成/听写）在主窗口 设置 → 语音 里集中配置")
            }
        }
    }

    /// 音色来源行的登录态文案（对齐 SettingsDrawer.tsx:523-528）。
    private var gatewayLoginText: String {
        if gatewayLoggedIn == nil { return "沉浸云语音 · 正在读取登录状态…" }
        return gatewayLoggedIn! ? "沉浸云语音 · 已登录" : "沉浸云语音 · 未登录"
    }

    /// 服务说明行文案（对齐 SettingsDrawer.tsx:536-540）。
    private var gatewayServiceText: String {
        if gatewayLoggedIn == nil { return "正在读取登录状态…" }
        return gatewayLoggedIn! ? "音色在语音页选择，此处不重复配置" : "当前未登录，播放会临时使用 Edge 朗读"
    }

    /// 「去语音页配置/登录」：打开设置窗并直达「语音」分区
    /// （Windows settingsOpenTab("voice") 的 Mac 对应物）。
    private func openVoiceSettingsTab() {
        (NSApp.delegate as? AppDelegate)?.openVoiceSettings()
    }

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
