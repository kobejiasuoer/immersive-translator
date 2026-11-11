import AppKit
import XCTest
@testable import ImmersiveTranslator

/// QA BUG-005 防回归：默认「混合」OCR 预设（语言列表 en-US 在首位）识别中文素材输出拉丁乱码或 0 字符。
/// 修复后「混合」预设由 Vision 自动检测语言。识别用例走真实 Vision（OCRReader.recognizeText 全管线），
/// 不用替身：渲染一张文字图喂给识别，断言中文能识别出来、英文结果没有退化。
final class OCRLanguagePresetTests: XCTestCase {

    func testOnlyAutoMixedPresetUsesAutomaticLanguageDetection() {
        XCTAssertTrue(OCRLanguagePreset.autoMixed.automaticallyDetectsLanguage)
        for preset in OCRLanguagePreset.allCases where preset != .autoMixed {
            XCTAssertFalse(preset.automaticallyDetectsLanguage, "\(preset.rawValue) 语言明确，应仍按列表顺序识别")
        }
    }

    func testAutoMixedPresetRecognizesChineseText() async throws {
        let image = try XCTUnwrap(Self.renderText(
            "沉浸口语是一款面向语言学习者的桌面应用。\n它提供划词翻译、截图识别与沉浸阅读三大能力。"
        ))
        let outcome = try await OCRReader.recognizeText(in: image, mode: .accurate, languagePreset: .autoMixed)

        let cjkCount = outcome.text.unicodeScalars.filter { (0x4E00...0x9FFF).contains($0.value) }.count
        // 修复前 en-US 优先：输出为空或纯拉丁乱码（CJK 字符数为 0）。
        XCTAssertGreaterThanOrEqual(cjkCount, 20, "混合预设应识别出中文，实际：\(outcome.text)")
        XCTAssertEqual(outcome.usedPreset, .autoMixed)
    }

    func testAutoMixedPresetStillRecognizesEnglishText() async throws {
        let image = try XCTUnwrap(Self.renderText(
            "The quick brown fox jumps over the lazy dog.\nLanguage learners often capture screenshots."
        ))
        let outcome = try await OCRReader.recognizeText(in: image, mode: .accurate, languagePreset: .autoMixed)

        XCTAssertTrue(outcome.text.contains("quick brown fox"), "英文识别不应退化，实际：\(outcome.text)")
        XCTAssertTrue(outcome.text.contains("screenshots"), "英文识别不应退化，实际：\(outcome.text)")
    }

    /// 用系统字体把文字画成白底黑字的 2x 位图（模拟 Retina 截图）。
    private static func renderText(_ text: String) -> CGImage? {
        let attributed = NSAttributedString(string: text, attributes: [
            .font: NSFont.systemFont(ofSize: 16),
            .foregroundColor: NSColor.black
        ])
        let textBounds = attributed.boundingRect(
            with: NSSize(width: 560, height: 1000),
            options: [.usesLineFragmentOrigin, .usesFontLeading]
        )
        let size = NSSize(width: 600, height: ceil(textBounds.height) + 24)
        let scale: CGFloat = 2
        guard let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: Int(size.width * scale),
            pixelsHigh: Int(size.height * scale),
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: 0,
            bitsPerPixel: 0
        ), let context = NSGraphicsContext(bitmapImageRep: rep) else {
            return nil
        }
        rep.size = size
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = context
        NSColor.white.setFill()
        NSRect(origin: .zero, size: size).fill()
        attributed.draw(
            with: NSRect(x: 20, y: 12, width: 560, height: ceil(textBounds.height)),
            options: [.usesLineFragmentOrigin, .usesFontLeading]
        )
        NSGraphicsContext.restoreGraphicsState()
        return rep.cgImage
    }
}
