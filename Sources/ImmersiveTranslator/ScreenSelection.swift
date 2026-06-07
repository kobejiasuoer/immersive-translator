import AppKit

final class ScreenSelectionController {
    private var windows: [ScreenSelectionWindow] = []
    private let onImage: (CGImage) -> Void
    private let onCancel: (ScreenSelectionCancelReason) -> Void

    init(onImage: @escaping (CGImage) -> Void, onCancel: @escaping (ScreenSelectionCancelReason) -> Void) {
        self.onImage = onImage
        self.onCancel = onCancel
    }

    func begin() {
        NSApplication.shared.activate(ignoringOtherApps: true)

        windows = NSScreen.screens.map { screen in
            let window = ScreenSelectionWindow(screen: screen)
            window.selectionView.onComplete = { [weak self, weak window] rect in
                guard let self, let window else { return }
                self.finish(screen: window.targetScreen, selection: rect)
            }
            window.selectionView.onCancel = { [weak self] in
                self?.cancel()
            }
            window.orderFrontRegardless()
            return window
        }

        if let targetWindow = windowUnderMouse() ?? windows.first {
            targetWindow.makeKeyAndOrderFront(nil)
            targetWindow.selectionView.window?.makeFirstResponder(targetWindow.selectionView)
        }
    }

    private func finish(screen: NSScreen, selection: CGRect) {
        guard selection.width >= 20, selection.height >= 12 else {
            releaseWindows()
            onCancel(.tooSmall)
            return
        }

        hideWindows()
        guard let image = capture(screen: screen, selection: selection) else {
            releaseWindows()
            onCancel(.captureFailed)
            return
        }
        releaseWindows()
        onImage(image)
    }

    private func cancel() {
        releaseWindows()
        onCancel(.userCancelled)
    }

    private func hideWindows() {
        windows.forEach { window in
            window.selectionView.onComplete = nil
            window.selectionView.onCancel = nil
            window.orderOut(nil)
        }
    }

    private func releaseWindows() {
        hideWindows()
        windows.removeAll()
    }

    private func capture(screen: NSScreen, selection: CGRect) -> CGImage? {
        guard let displayID = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID else {
            return nil
        }

        let pixelWidth = CGFloat(CGDisplayPixelsWide(displayID))
        let pixelHeight = CGFloat(CGDisplayPixelsHigh(displayID))
        let scaleX = pixelWidth / screen.frame.width
        let scaleY = pixelHeight / screen.frame.height
        let screenBounds = CGRect(origin: .zero, size: screen.frame.size)
        let clampedSelection = selection.standardized
            .insetBy(dx: -6, dy: -6)
            .intersection(screenBounds)
        guard clampedSelection.width >= 1, clampedSelection.height >= 1 else {
            return nil
        }

        let minX = floor(clampedSelection.minX * scaleX)
        let maxX = ceil(clampedSelection.maxX * scaleX)
        let minY = floor((screen.frame.height - clampedSelection.maxY) * scaleY)
        let maxY = ceil((screen.frame.height - clampedSelection.minY) * scaleY)
        let pixelBounds = CGRect(x: 0, y: 0, width: pixelWidth, height: pixelHeight)
        let rect = CGRect(
            x: minX,
            y: minY,
            width: maxX - minX,
            height: maxY - minY
        ).intersection(pixelBounds).integral

        guard rect.width >= 1, rect.height >= 1 else {
            return nil
        }

        return CGDisplayCreateImage(displayID, rect: rect)
    }

    private func windowUnderMouse() -> ScreenSelectionWindow? {
        let mouseLocation = NSEvent.mouseLocation
        return windows.first { window in
            window.targetScreen.frame.contains(mouseLocation)
        }
    }
}

enum ScreenSelectionCancelReason {
    case userCancelled
    case tooSmall
    case captureFailed
}

final class ScreenSelectionWindow: NSWindow {
    let targetScreen: NSScreen
    let selectionView = ScreenSelectionView()

    init(screen: NSScreen) {
        targetScreen = screen
        super.init(
            contentRect: screen.frame,
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        backgroundColor = .clear
        isOpaque = false
        ignoresMouseEvents = false
        level = .screenSaver
        hasShadow = false
        animationBehavior = .none
        isReleasedWhenClosed = false
        acceptsMouseMovedEvents = true
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        contentView = selectionView
        selectionView.frame = NSRect(origin: .zero, size: screen.frame.size)
    }

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

final class ScreenSelectionView: NSView {
    var onComplete: ((CGRect) -> Void)?
    var onCancel: (() -> Void)?

    private var startPoint: CGPoint?
    private var currentPoint: CGPoint?
    private var hoverPoint: CGPoint?
    private var isDragging = false
    private let accentColor = NSColor.systemTeal

    override var acceptsFirstResponder: Bool { true }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
        true
    }

    override func viewDidMoveToWindow() {
        window?.makeFirstResponder(self)
    }

    override func draw(_ dirtyRect: NSRect) {
        drawBaseOverlay()

        guard let selectionRect else {
            drawCrosshair(at: hoverPoint)
            drawIdleHint(at: hoverPoint)
            return
        }

        drawSelectionHole(selectionRect)
        drawSelectionBorder(selectionRect)
        drawCornerGuides(in: selectionRect)
        drawHandles(in: selectionRect)
        drawSelectionHUD(selectionRect)
    }

    override func mouseDown(with event: NSEvent) {
        startPoint = convert(event.locationInWindow, from: nil)
        currentPoint = startPoint
        isDragging = true
        needsDisplay = true
    }

    override func mouseDragged(with event: NSEvent) {
        currentPoint = convert(event.locationInWindow, from: nil)
        hoverPoint = currentPoint
        needsDisplay = true
    }

    override func mouseUp(with event: NSEvent) {
        currentPoint = convert(event.locationInWindow, from: nil)
        isDragging = false
        if let selectionRect {
            onComplete?(selectionRect)
        } else {
            onCancel?()
        }
    }

    override func mouseMoved(with event: NSEvent) {
        hoverPoint = convert(event.locationInWindow, from: nil)
        needsDisplay = true
    }

    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 {
            onCancel?()
        } else {
            super.keyDown(with: event)
        }
    }

    private var selectionRect: CGRect? {
        guard let startPoint, let currentPoint else { return nil }
        let x = min(startPoint.x, currentPoint.x)
        let y = min(startPoint.y, currentPoint.y)
        let width = abs(startPoint.x - currentPoint.x)
        let height = abs(startPoint.y - currentPoint.y)
        guard width >= 2, height >= 2 else { return nil }
        return CGRect(x: x, y: y, width: width, height: height)
    }

    private func drawBaseOverlay() {
        NSColor.black.withAlphaComponent(0.24).setFill()
        bounds.fill()
    }

    private func drawSelectionHole(_ rect: CGRect) {
        NSColor.black.withAlphaComponent(0.28).setFill()
        let overlay = NSBezierPath(rect: bounds)
        overlay.append(NSBezierPath(rect: rect))
        overlay.windingRule = .evenOdd
        overlay.fill()

        NSColor.white.withAlphaComponent(0.04).setFill()
        rect.fill()
    }

    private func drawSelectionBorder(_ rect: CGRect) {
        accentColor.setStroke()
        let path = NSBezierPath(roundedRect: rect, xRadius: 4, yRadius: 4)
        path.lineWidth = 2
        path.stroke()

        NSColor.white.withAlphaComponent(0.65).setStroke()
        let innerRect = rect.insetBy(dx: 1.5, dy: 1.5)
        guard innerRect.width > 0, innerRect.height > 0 else { return }
        let innerPath = NSBezierPath(roundedRect: innerRect, xRadius: 3, yRadius: 3)
        innerPath.lineWidth = 1
        innerPath.stroke()
    }

    private func drawSelectionHUD(_ rect: CGRect) {
        let scale = window?.screen?.backingScaleFactor ?? 1
        let pixelWidth = Int(rect.width * scale)
        let pixelHeight = Int(rect.height * scale)
        let title = isDragging ? "松开开始 OCR" : "OCR 选区"
        let subtitle = "\(pixelWidth) x \(pixelHeight) px  ·  Esc 取消"
        drawPill(title: title, subtitle: subtitle, near: rect)
    }

    private func drawIdleHint(at point: CGPoint?) {
        let anchor = point ?? CGPoint(x: bounds.midX, y: bounds.midY)
        let hintRect = CGRect(x: anchor.x - 132, y: anchor.y + 18, width: 264, height: 62)
            .clamped(to: bounds.insetBy(dx: 16, dy: 16))
        drawPill(
            title: "框选文字区域",
            subtitle: "拖拽选择 · Esc 取消",
            in: hintRect
        )
    }

    private func drawCrosshair(at point: CGPoint?) {
        guard let point else { return }
        NSColor.white.withAlphaComponent(0.36).setStroke()
        let path = NSBezierPath()
        path.lineWidth = 1
        path.move(to: NSPoint(x: bounds.minX, y: point.y))
        path.line(to: NSPoint(x: bounds.maxX, y: point.y))
        path.move(to: NSPoint(x: point.x, y: bounds.minY))
        path.line(to: NSPoint(x: point.x, y: bounds.maxY))
        path.stroke()

        accentColor.withAlphaComponent(0.92).setFill()
        NSBezierPath(ovalIn: CGRect(x: point.x - 3, y: point.y - 3, width: 6, height: 6)).fill()
    }

    private func drawCornerGuides(in rect: CGRect) {
        guard rect.width >= 28, rect.height >= 28 else { return }
        accentColor.setStroke()
        let path = NSBezierPath()
        path.lineWidth = 3
        let length = min(CGFloat(26), min(rect.width, rect.height) / 3)

        path.move(to: CGPoint(x: rect.minX, y: rect.minY + length))
        path.line(to: CGPoint(x: rect.minX, y: rect.minY))
        path.line(to: CGPoint(x: rect.minX + length, y: rect.minY))

        path.move(to: CGPoint(x: rect.maxX - length, y: rect.minY))
        path.line(to: CGPoint(x: rect.maxX, y: rect.minY))
        path.line(to: CGPoint(x: rect.maxX, y: rect.minY + length))

        path.move(to: CGPoint(x: rect.maxX, y: rect.maxY - length))
        path.line(to: CGPoint(x: rect.maxX, y: rect.maxY))
        path.line(to: CGPoint(x: rect.maxX - length, y: rect.maxY))

        path.move(to: CGPoint(x: rect.minX + length, y: rect.maxY))
        path.line(to: CGPoint(x: rect.minX, y: rect.maxY))
        path.line(to: CGPoint(x: rect.minX, y: rect.maxY - length))

        path.stroke()
    }

    private func drawHandles(in rect: CGRect) {
        guard rect.width >= 48, rect.height >= 36 else { return }
        accentColor.setFill()
        let handleSize: CGFloat = 5
        let points = [
            CGPoint(x: rect.minX, y: rect.minY),
            CGPoint(x: rect.maxX, y: rect.minY),
            CGPoint(x: rect.maxX, y: rect.maxY),
            CGPoint(x: rect.minX, y: rect.maxY)
        ]

        for point in points {
            let handleRect = CGRect(
                x: point.x - handleSize / 2,
                y: point.y - handleSize / 2,
                width: handleSize,
                height: handleSize
            )
            NSBezierPath(roundedRect: handleRect, xRadius: 2, yRadius: 2).fill()
        }
    }

    private func drawPill(title: String, subtitle: String, near rect: CGRect) {
        let width: CGFloat = 236
        let height: CGFloat = 54
        var origin = CGPoint(x: rect.minX, y: rect.minY - height - 10)
        if origin.y < bounds.minY + 12 {
            origin.y = rect.maxY + 10
        }
        if origin.y + height > bounds.maxY - 12 {
            origin.y = bounds.maxY - height - 12
        }
        if origin.x + width > bounds.maxX - 12 {
            origin.x = bounds.maxX - width - 12
        }
        if origin.x < bounds.minX + 12 {
            origin.x = bounds.minX + 12
        }
        drawPill(title: title, subtitle: subtitle, in: CGRect(origin: origin, size: CGSize(width: width, height: height)))
    }

    private func drawPill(title: String, subtitle: String, in rect: CGRect) {
        let path = NSBezierPath(roundedRect: rect, xRadius: 12, yRadius: 12)
        NSColor.black.withAlphaComponent(0.74).setFill()
        path.fill()
        NSColor.white.withAlphaComponent(0.14).setStroke()
        path.lineWidth = 1
        path.stroke()

        let titleAttributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 14, weight: .semibold),
            .foregroundColor: NSColor.white
        ]
        let subtitleAttributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 11, weight: .regular),
            .foregroundColor: NSColor.white.withAlphaComponent(0.72)
        ]
        NSAttributedString(string: title, attributes: titleAttributes)
            .draw(at: CGPoint(x: rect.minX + 14, y: rect.minY + 28))
        NSAttributedString(string: subtitle, attributes: subtitleAttributes)
            .draw(at: CGPoint(x: rect.minX + 14, y: rect.minY + 11))
    }
}

private extension CGRect {
    func clamped(to bounds: CGRect) -> CGRect {
        var rect = self
        if rect.minX < bounds.minX {
            rect.origin.x = bounds.minX
        }
        if rect.minY < bounds.minY {
            rect.origin.y = bounds.minY
        }
        if rect.maxX > bounds.maxX {
            rect.origin.x = bounds.maxX - rect.width
        }
        if rect.maxY > bounds.maxY {
            rect.origin.y = bounds.maxY - rect.height
        }
        return rect
    }
}
