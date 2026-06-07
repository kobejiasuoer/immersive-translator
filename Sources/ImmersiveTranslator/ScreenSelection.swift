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

    override var acceptsFirstResponder: Bool { true }

    override func viewDidMoveToWindow() {
        window?.makeKey()
    }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.black.withAlphaComponent(0.36).setFill()
        bounds.fill()

        guard let selectionRect else {
            drawCrosshair(at: hoverPoint)
            drawHint()
            return
        }

        NSColor.clear.setFill()
        selectionRect.fill(using: .clear)

        NSColor.systemTeal.setStroke()
        let path = NSBezierPath(rect: selectionRect)
        path.lineWidth = 2.5
        path.stroke()

        NSColor.systemTeal.withAlphaComponent(0.14).setFill()
        selectionRect.fill()

        drawRuleOfThirds(in: selectionRect)
        drawHandles(in: selectionRect)
        drawSelectionSize(selectionRect)
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

    private func drawSelectionSize(_ rect: CGRect) {
        let scale = window?.screen?.backingScaleFactor ?? 1
        let pixelWidth = Int(rect.width * scale)
        let pixelHeight = Int(rect.height * scale)
        let text = isDragging
            ? "\(pixelWidth) x \(pixelHeight) px  ·  松开开始 OCR"
            : "\(pixelWidth) x \(pixelHeight) px"
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedSystemFont(ofSize: 12, weight: .medium),
            .foregroundColor: NSColor.white,
            .backgroundColor: NSColor.black.withAlphaComponent(0.72)
        ]
        let attributed = NSAttributedString(string: " \(text) ", attributes: attributes)
        let size = attributed.size()
        let x = min(max(rect.minX, bounds.minX + 12), bounds.maxX - size.width - 12)
        let y = rect.minY - size.height - 8 > bounds.minY + 12
            ? rect.minY - size.height - 8
            : min(rect.maxY + 8, bounds.maxY - size.height - 12)
        attributed.draw(at: NSPoint(x: x, y: y))
    }

    private func drawHint() {
        let text = "拖拽框选要翻译的文字区域 · Esc 取消"
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 18, weight: .semibold),
            .foregroundColor: NSColor.white,
            .backgroundColor: NSColor.black.withAlphaComponent(0.62)
        ]
        let attributed = NSAttributedString(string: " \(text) ", attributes: attributes)
        let size = attributed.size()
        let point = NSPoint(
            x: bounds.midX - size.width / 2,
            y: bounds.midY - size.height / 2
        )
        attributed.draw(at: point)
    }

    private func drawCrosshair(at point: CGPoint?) {
        guard let point else { return }
        NSColor.white.withAlphaComponent(0.45).setStroke()
        let path = NSBezierPath()
        path.lineWidth = 1
        path.move(to: NSPoint(x: bounds.minX, y: point.y))
        path.line(to: NSPoint(x: bounds.maxX, y: point.y))
        path.move(to: NSPoint(x: point.x, y: bounds.minY))
        path.line(to: NSPoint(x: point.x, y: bounds.maxY))
        path.stroke()
    }

    private func drawRuleOfThirds(in rect: CGRect) {
        guard rect.width >= 120, rect.height >= 80 else { return }
        NSColor.white.withAlphaComponent(0.24).setStroke()
        let path = NSBezierPath()
        path.lineWidth = 1
        for fraction in [1.0 / 3.0, 2.0 / 3.0] {
            let x = rect.minX + rect.width * fraction
            path.move(to: NSPoint(x: x, y: rect.minY))
            path.line(to: NSPoint(x: x, y: rect.maxY))

            let y = rect.minY + rect.height * fraction
            path.move(to: NSPoint(x: rect.minX, y: y))
            path.line(to: NSPoint(x: rect.maxX, y: y))
        }
        path.stroke()
    }

    private func drawHandles(in rect: CGRect) {
        NSColor.systemTeal.setFill()
        let handleSize: CGFloat = 7
        let points = [
            CGPoint(x: rect.minX, y: rect.minY),
            CGPoint(x: rect.midX, y: rect.minY),
            CGPoint(x: rect.maxX, y: rect.minY),
            CGPoint(x: rect.maxX, y: rect.midY),
            CGPoint(x: rect.maxX, y: rect.maxY),
            CGPoint(x: rect.midX, y: rect.maxY),
            CGPoint(x: rect.minX, y: rect.maxY),
            CGPoint(x: rect.minX, y: rect.midY)
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
}
