import CoreGraphics
import Vision

enum OCRError: LocalizedError {
    case recognitionFailed

    var errorDescription: String? {
        switch self {
        case .recognitionFailed:
            return "OCR 识别失败。"
        }
    }
}

enum OCRReader {
    static func recognizeText(
        in image: CGImage,
        mode: OCRRecognitionMode = .accurate,
        languagePreset: OCRLanguagePreset = .autoMixed
    ) async throws -> String {
        try await Task.detached(priority: .userInitiated) {
            let preparedImage = prepareImageForRecognition(image)
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = mode == .accurate ? .accurate : .fast
            request.usesLanguageCorrection = mode == .accurate
            request.recognitionLanguages = languagePreset.recognitionLanguages
            request.minimumTextHeight = minimumTextHeight(for: preparedImage)

            let handler = VNImageRequestHandler(cgImage: preparedImage)
            try handler.perform([request])

            guard let observations = request.results, !observations.isEmpty else {
                return ""
            }

            let lines = observations
                .compactMap { observation -> OCRLine? in
                    guard let text = observation.topCandidates(1).first?.string else { return nil }
                    let cleaned = cleanup(text)
                    guard !cleaned.isEmpty else { return nil }
                    return OCRLine(rect: observation.boundingBox, text: cleaned)
                }

            return mergeLines(lines)
        }.value
    }
}

private struct OCRLine {
    let rect: CGRect
    let text: String
}

private func prepareImageForRecognition(_ image: CGImage) -> CGImage {
    let width = image.width
    let height = image.height
    let maxSide = max(width, height)
    let minUsefulSide = 1400

    guard maxSide < minUsefulSide else {
        return image
    }

    let scale = min(3.0, CGFloat(minUsefulSide) / CGFloat(maxSide))
    let targetWidth = Int((CGFloat(width) * scale).rounded())
    let targetHeight = Int((CGFloat(height) * scale).rounded())
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    let bitmapInfo = CGImageAlphaInfo.premultipliedLast.rawValue

    guard let context = CGContext(
        data: nil,
        width: targetWidth,
        height: targetHeight,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: colorSpace,
        bitmapInfo: bitmapInfo
    ) else {
        return image
    }

    context.interpolationQuality = .high
    context.draw(image, in: CGRect(x: 0, y: 0, width: targetWidth, height: targetHeight))
    return context.makeImage() ?? image
}

private func minimumTextHeight(for image: CGImage) -> Float {
    let shortSide = min(image.width, image.height)
    if shortSide < 600 {
        return 0.006
    }
    if shortSide < 1200 {
        return 0.004
    }
    return 0.0025
}

private func cleanup(_ text: String) -> String {
    text
        .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        .trimmingCharacters(in: .whitespacesAndNewlines)
}

private func mergeLines(_ lines: [OCRLine]) -> String {
    guard !lines.isEmpty else { return "" }

    let sorted = lines.sorted { left, right in
        let yDelta = abs(left.rect.midY - right.rect.midY)
        if yDelta > max(0.012, min(left.rect.height, right.rect.height) * 0.55) {
            return left.rect.midY > right.rect.midY
        }
        return left.rect.minX < right.rect.minX
    }

    var rows: [[OCRLine]] = []
    for line in sorted {
        if let lastRow = rows.indices.last,
           let anchor = rows[lastRow].first,
           abs(anchor.rect.midY - line.rect.midY) <= max(0.014, max(anchor.rect.height, line.rect.height) * 0.7) {
            rows[lastRow].append(line)
        } else {
            rows.append([line])
        }
    }

    return rows
        .map { row in
            row.sorted { $0.rect.minX < $1.rect.minX }
                .map(\.text)
                .joined(separator: " ")
        }
        .joined(separator: "\n")
}
