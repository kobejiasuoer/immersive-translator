import AppKit

// ---------------------------------------------------------------------------
// 菜单栏复习到期角标（对齐 Windows tray_badge.rs：红色圆底 + 白字数字、
// due = 0 无角标、上限 999）。规格：docs/mac-ui-fix-specs-2026-11-02/tray.md §2.2。
// 纯 AppKit 绘制、不新增图片资产（对齐 tray_badge.rs「不引图形依赖」思路）；
// Mac 把「红色圆底白字」移植为圆角胶囊，不移植像素合成实现（平台差异 §4-1/§4-7）。
// ---------------------------------------------------------------------------

enum StatusBarBadge {
    /// Windows tray_badge.rs:22 BADGE_RGB [224,67,64]（注释：与 --err #e5484d 接近的托盘红）。
    static let badgeRed = NSColor(srgbRed: 224 / 255, green: 67 / 255, blue: 64 / 255, alpha: 1)

    /// 角标显示文案：上限 999（tray_badge.rs:66-71：>999 显示 999），负数按 0 处理。
    static func displayText(due: Int) -> String {
        String(min(max(due, 0), 999))
    }

    /// due <= 0 → nil（tray_badge.rs:27-29 + 测试 due_zero_keeps_base：原图返回无角标）。
    /// 否则红色圆角胶囊（高 14pt、圆角半径 7）+ 白色粗体等宽数字居中；
    /// 2x Retina 位图、isTemplate = false（红底白字在深浅色菜单栏均成立，无需模板适配）。
    static func badgeImage(due: Int) -> NSImage? {
        guard due > 0 else { return nil }
        let text = displayText(due: due) as NSString
        // 字体沿用原红字角标的等宽数字语义（App.swift 旧 attributedTitle 同款字族）。
        let font = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .bold)
        let attributes: [NSAttributedString.Key: Any] = [
            .font: font,
            .foregroundColor: NSColor.white,
        ]
        let textSize = text.size(withAttributes: attributes)
        let height: CGFloat = 14
        let horizontalPadding: CGFloat = 6
        let width = ceil(textSize.width) + horizontalPadding * 2
        return bitmapImage(pointsWidth: width, pointsHeight: height) { rect in
            let capsule = NSBezierPath(roundedRect: rect, xRadius: height / 2, yRadius: height / 2)
            badgeRed.setFill()
            capsule.fill()
            let textRect = CGRect(
                x: (rect.width - textSize.width) / 2,
                y: (rect.height - textSize.height) / 2,
                width: textSize.width,
                height: textSize.height
            )
            text.draw(in: textRect, withAttributes: attributes)
        }
    }

    /// 托盘按钮合成图：托盘图标（左）+ 角标胶囊（右），间距 3pt；due <= 0 → 图标
    /// 副本（无角标）；base 为 nil 返回 nil（App 资源缺失时走「译」文字兜底路径）。
    /// 说明：规格 §2.2 原设计是 `button.title = "译"` + `image = 胶囊`；本函数落地时
    /// 品牌施工轮已把托盘底座换成 18pt 彩色「书页对话」图标（Brand.trayIconImage，
    /// App.swift configureMenuBar），故改为在图标底座上合成胶囊——图标承载（品牌轮）
    /// 与红胶囊角标语义（本规格）都保留。
    static func trayIconWithBadge(base: NSImage?, due: Int) -> NSImage? {
        guard let base else { return nil }
        guard due > 0, let badge = badgeImage(due: due) else {
            let copy = base.copy() as? NSImage
            copy?.isTemplate = base.isTemplate
            return copy
        }
        let gap: CGFloat = 3
        let width = base.size.width + gap + badge.size.width
        let height = max(base.size.height, badge.size.height)
        return bitmapImage(pointsWidth: width, pointsHeight: height) { rect in
            let baseY = (rect.height - base.size.height) / 2
            base.draw(
                in: NSRect(x: 0, y: baseY, width: base.size.width, height: base.size.height),
                from: .zero,
                operation: .sourceOver,
                fraction: 1
            )
            let badgeY = (rect.height - badge.size.height) / 2
            badge.draw(
                in: NSRect(x: base.size.width + gap, y: badgeY, width: badge.size.width, height: badge.size.height),
                from: .zero,
                operation: .sourceOver,
                fraction: 1
            )
        }
    }

    // MARK: 绘制底座

    /// 2x Retina 位图：按 2x 像素离屏绘制、rep.size 回写 pt——渲染结果与当前显示器
    /// 倍率无关（XCTest 离屏环境同样确定性），比 lockFocus 依赖屏幕 scale 更稳。
    private static func bitmapImage(
        pointsWidth: CGFloat,
        pointsHeight: CGFloat,
        draw: (NSRect) -> Void
    ) -> NSImage? {
        let scale: CGFloat = 2
        guard let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: Int(pointsWidth * scale),
            pixelsHigh: Int(pointsHeight * scale),
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: 0,
            bitsPerPixel: 0
        ) else { return nil }
        NSGraphicsContext.saveGraphicsState()
        guard let context = NSGraphicsContext(bitmapImageRep: rep) else {
            NSGraphicsContext.restoreGraphicsState()
            return nil
        }
        NSGraphicsContext.current = context
        context.cgContext.scaleBy(x: scale, y: scale)
        draw(NSRect(x: 0, y: 0, width: pointsWidth, height: pointsHeight))
        NSGraphicsContext.restoreGraphicsState()
        rep.size = NSSize(width: pointsWidth, height: pointsHeight)

        let image = NSImage(size: NSSize(width: pointsWidth, height: pointsHeight))
        image.addRepresentation(rep)
        image.isTemplate = false
        return image
    }
}
