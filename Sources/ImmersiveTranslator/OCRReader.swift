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
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = mode == .accurate ? .accurate : .fast
            request.usesLanguageCorrection = mode == .accurate
            request.recognitionLanguages = languagePreset.recognitionLanguages

            let handler = VNImageRequestHandler(cgImage: image)
            try handler.perform([request])

            guard let observations = request.results, !observations.isEmpty else {
                return ""
            }

            let lines = observations
                .compactMap { observation -> (CGRect, String)? in
                    guard let text = observation.topCandidates(1).first?.string else { return nil }
                    return (observation.boundingBox, text)
                }
                .sorted { left, right in
                    let yDelta = abs(left.0.midY - right.0.midY)
                    if yDelta > 0.02 {
                        return left.0.midY > right.0.midY
                    }
                    return left.0.minX < right.0.minX
                }
                .map(\.1)

            return lines.joined(separator: "\n")
        }.value
    }
}
