import CoreGraphics
import Foundation
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

struct OCRRecognitionOutcome {
    let text: String
    let configuredMode: OCRRecognitionMode
    let configuredPreset: OCRLanguagePreset
    let usedMode: OCRRecognitionMode
    let usedPreset: OCRLanguagePreset

    var modeDowngraded: Bool {
        configuredMode == .fast && usedMode == .accurate
    }

    var usedFallbackPreset: Bool {
        usedPreset != configuredPreset
    }

    var hasFallback: Bool {
        modeDowngraded || usedFallbackPreset
    }
}

enum OCRReader {
    static func recognizeText(
        in image: CGImage,
        mode: OCRRecognitionMode = .accurate,
        languagePreset: OCRLanguagePreset = .autoMixed
    ) async throws -> OCRRecognitionOutcome {
        try await Task.detached(priority: .userInitiated) {
            let preparedImage = prepareImageForRecognition(image)
            var lastError: Error?
            var completedAttempt = false

            let attempts = makeRecognitionAttempts(mode: mode, languagePreset: languagePreset)
            var usedAttempt = attempts.first
                ?? OCRRecognitionAttempt(mode: mode, languagePreset: languagePreset)
            var producedText = ""

            for attempt in attempts {
                do {
                    let text = try performRecognition(in: preparedImage, attempt: attempt)
                    completedAttempt = true
                    if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        usedAttempt = attempt
                        producedText = text
                        break
                    }
                } catch {
                    lastError = error
                }
            }

            if producedText.isEmpty, !completedAttempt, let lastError {
                throw lastError
            }

            return OCRRecognitionOutcome(
                text: producedText,
                configuredMode: mode,
                configuredPreset: languagePreset,
                usedMode: usedAttempt.mode,
                usedPreset: usedAttempt.languagePreset
            )
        }.value
    }

    static func effectiveMode(_ mode: OCRRecognitionMode, preset: OCRLanguagePreset) -> OCRRecognitionMode {
        effectiveRecognitionMode(mode, for: preset)
    }
}

private struct OCRRecognitionAttempt: Equatable {
    let mode: OCRRecognitionMode
    let languagePreset: OCRLanguagePreset
}

private func makeRecognitionAttempts(
    mode: OCRRecognitionMode,
    languagePreset: OCRLanguagePreset
) -> [OCRRecognitionAttempt] {
    var attempts: [OCRRecognitionAttempt] = []

    let primaryMode = effectiveRecognitionMode(mode, for: languagePreset)
    appendRecognitionAttempt(mode: primaryMode, languagePreset: languagePreset, to: &attempts)

    for fallbackPreset in languagePreset.fallbackPresets {
        appendRecognitionAttempt(mode: .accurate, languagePreset: fallbackPreset, to: &attempts)
    }

    return attempts
}

private func appendRecognitionAttempt(
    mode: OCRRecognitionMode,
    languagePreset: OCRLanguagePreset,
    to attempts: inout [OCRRecognitionAttempt]
) {
    let attempt = OCRRecognitionAttempt(mode: mode, languagePreset: languagePreset)
    guard !attempts.contains(attempt) else { return }
    attempts.append(attempt)
}

private func effectiveRecognitionMode(_ mode: OCRRecognitionMode, for languagePreset: OCRLanguagePreset) -> OCRRecognitionMode {
    guard mode == .fast else { return mode }
    return supportsAllRecognitionLanguages(languagePreset.recognitionLanguages, mode: .fast) ? .fast : .accurate
}

private func performRecognition(in image: CGImage, attempt: OCRRecognitionAttempt) throws -> String {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = recognitionLevel(for: attempt.mode)
    request.usesLanguageCorrection = attempt.mode == .accurate

    let languages = supportedRecognitionLanguages(
        from: attempt.languagePreset.recognitionLanguages,
        level: request.recognitionLevel
    )
    guard !languages.isEmpty else {
        return ""
    }

    request.recognitionLanguages = languages
    request.minimumTextHeight = minimumTextHeight(for: image)

    let handler = VNImageRequestHandler(cgImage: image)
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
}

private func recognitionLevel(for mode: OCRRecognitionMode) -> VNRequestTextRecognitionLevel {
    mode == .accurate ? .accurate : .fast
}

private func supportsAllRecognitionLanguages(_ languages: [String], mode: OCRRecognitionMode) -> Bool {
    let level = recognitionLevel(for: mode)
    guard let supported = supportedRecognitionLanguageSet(level: level) else {
        return true
    }
    return languages.allSatisfy(supported.contains)
}

private func supportedRecognitionLanguages(
    from languages: [String],
    level: VNRequestTextRecognitionLevel
) -> [String] {
    guard let supported = supportedRecognitionLanguageSet(level: level) else {
        return languages
    }
    return languages.filter(supported.contains)
}

private func supportedRecognitionLanguageSet(level: VNRequestTextRecognitionLevel) -> Set<String>? {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = level
    guard let languages = try? request.supportedRecognitionLanguages() else {
        return nil
    }
    return Set(languages)
}

private struct OCRLine {
    let rect: CGRect
    let text: String
}

private struct OCRRow {
    let index: Int
    var lines: [OCRLine]
}

private struct OCRSegment {
    let rowIndex: Int
    var rect: CGRect
    var text: String
}

private struct OCRBlock {
    var segments: [OCRSegment]
    var rect: CGRect
    var averageLineHeight: CGFloat

    init(segment: OCRSegment) {
        segments = [segment]
        rect = segment.rect
        averageLineHeight = segment.rect.height
    }

    mutating func add(_ segment: OCRSegment) {
        segments.append(segment)
        rect = rect.union(segment.rect)
        averageLineHeight = segments.map { $0.rect.height }.average
    }
}

private enum OCRBoundary {
    case join
    case line
    case paragraph
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

    let rows = makeRows(from: lines)
    let segments = makeSegments(from: rows)
    let blocks = makeBlocks(from: segments)

    return blocks
        .sorted(by: blockReadingOrder)
        .map(renderBlock)
        .filter { !$0.isEmpty }
        .joined(separator: "\n\n")
        .replacingOccurrences(of: "\n{3,}", with: "\n\n", options: .regularExpression)
}

private func makeRows(from lines: [OCRLine]) -> [OCRRow] {
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
        .enumerated()
        .map { index, row in
            OCRRow(index: index, lines: row.sorted { $0.rect.minX < $1.rect.minX })
        }
}

private func makeSegments(from rows: [OCRRow]) -> [OCRSegment] {
    rows.flatMap { row -> [OCRSegment] in
        var segments: [OCRSegment] = []

        for line in row.lines {
            guard var last = segments.popLast() else {
                segments.append(OCRSegment(rowIndex: row.index, rect: line.rect, text: line.text))
                continue
            }

            let gap = max(CGFloat(0), line.rect.minX - last.rect.maxX)
            let rowHeight = max(last.rect.height, line.rect.height)
            if shouldJoinSameVisualLine(left: last, right: line, gap: gap, rowHeight: rowHeight) {
                last.rect = last.rect.union(line.rect)
                last.text = joinInline(last.text, line.text)
                segments.append(last)
            } else {
                segments.append(last)
                segments.append(OCRSegment(rowIndex: row.index, rect: line.rect, text: line.text))
            }
        }

        return segments
    }
}

private func shouldJoinSameVisualLine(left: OCRSegment, right: OCRLine, gap: CGFloat, rowHeight: CGFloat) -> Bool {
    if gap <= 0 {
        return true
    }

    let tightGap = max(CGFloat(0.016), rowHeight * 0.85)
    if gap <= tightGap {
        return true
    }

    let cautiousWordGap = max(CGFloat(0.024), rowHeight * 1.35)
    guard gap <= cautiousWordGap else {
        return false
    }

    return isLikelyInlineFragment(left.text) && isLikelyInlineFragment(right.text)
}

private func makeBlocks(from segments: [OCRSegment]) -> [OCRBlock] {
    var blocks: [OCRBlock] = []
    let sorted = segments.sorted(by: segmentReadingOrder)

    for segment in sorted {
        if let index = bestBlockIndex(for: segment, in: blocks) {
            blocks[index].add(segment)
        } else {
            blocks.append(OCRBlock(segment: segment))
        }
    }

    return blocks
}

private func bestBlockIndex(for segment: OCRSegment, in blocks: [OCRBlock]) -> Int? {
    blocks
        .enumerated()
        .compactMap { index, block -> (index: Int, score: CGFloat)? in
            guard canAdd(segment, to: block) else { return nil }
            return (index, blockScore(for: segment, in: block))
        }
        .min { $0.score < $1.score }?
        .index
}

private func canAdd(_ segment: OCRSegment, to block: OCRBlock) -> Bool {
    guard !block.segments.contains(where: { $0.rowIndex == segment.rowIndex }) else {
        return false
    }

    guard let neighbor = nearestVerticalNeighbor(to: segment, in: block),
          isNearVerticalNeighbor(segment, neighbor: neighbor) else {
        return false
    }

    if looksLikeSeparateColumnOrRegion(segment: segment, block: block, neighbor: neighbor) {
        return false
    }

    let overlap = max(
        horizontalOverlap(segment.rect, neighbor.rect),
        horizontalOverlap(segment.rect, block.rect)
    )
    let minWidth = max(CGFloat(0.001), min(segment.rect.width, block.rect.width))
    let overlapRatio = overlap / minWidth
    let leadingDelta = abs(segment.rect.minX - leadingAnchor(for: block))
    let centerDelta = min(
        abs(segment.rect.midX - neighbor.rect.midX),
        abs(segment.rect.midX - block.rect.midX)
    )
    let lineHeight = max(segment.rect.height, block.averageLineHeight)
    let leadingTolerance = max(CGFloat(0.035), lineHeight * 2.0)
    let centerTolerance = max(CGFloat(0.045), minWidth * 0.35)
    let blockIsWide = block.rect.width > 0.68
    let segmentIsWide = segment.rect.width > 0.68

    if blockIsWide, !segmentIsWide, leadingDelta > leadingTolerance {
        return false
    }
    if segmentIsWide, !blockIsWide, leadingDelta > leadingTolerance {
        return false
    }

    if overlapRatio >= 0.42 {
        return true
    }
    if leadingDelta <= leadingTolerance {
        return true
    }
    return centerDelta <= centerTolerance
}

private func nearestVerticalNeighbor(to segment: OCRSegment, in block: OCRBlock) -> OCRSegment? {
    block.segments.min { left, right in
        let leftGap = verticalGapBetween(segment.rect, left.rect)
        let rightGap = verticalGapBetween(segment.rect, right.rect)
        if leftGap != rightGap {
            return leftGap < rightGap
        }
        return abs(segment.rect.midX - left.rect.midX) < abs(segment.rect.midX - right.rect.midX)
    }
}

private func isNearVerticalNeighbor(_ segment: OCRSegment, neighbor: OCRSegment) -> Bool {
    let lineHeight = max(segment.rect.height, neighbor.rect.height, 0.001)
    let verticalGap = verticalGapBetween(segment.rect, neighbor.rect)

    let sameRegionTolerance = max(CGFloat(0.048), lineHeight * 1.9)
    if verticalGap <= sameRegionTolerance {
        return true
    }

    let segmentStartsParagraph = previousEndsStrongly(neighbor.text) || startsStructuredLine(segment.text)
    return segmentStartsParagraph && verticalGap <= max(CGFloat(0.070), lineHeight * 2.6)
}

private func blockScore(for segment: OCRSegment, in block: OCRBlock) -> CGFloat {
    let neighbor = nearestVerticalNeighbor(to: segment, in: block)
    let leadingDelta = abs(segment.rect.minX - leadingAnchor(for: block))
    let centerDelta = neighbor.map { abs(segment.rect.midX - $0.rect.midX) }
        ?? abs(segment.rect.midX - block.rect.midX)
    let verticalGap = neighbor.map { verticalGapBetween(segment.rect, $0.rect) }
        ?? max(CGFloat(0), block.rect.minY - segment.rect.maxY)
    return leadingDelta * 2.0 + centerDelta + verticalGap * 0.4
}

private func looksLikeSeparateColumnOrRegion(segment: OCRSegment, block: OCRBlock, neighbor: OCRSegment) -> Bool {
    let lineHeight = max(segment.rect.height, neighbor.rect.height, block.averageLineHeight, 0.001)
    let overlap = horizontalOverlap(segment.rect, neighbor.rect)
    let minNeighborWidth = max(CGFloat(0.001), min(segment.rect.width, neighbor.rect.width))
    let overlapRatio = overlap / minNeighborWidth
    let leadingDeltaFromNeighbor = abs(segment.rect.minX - neighbor.rect.minX)
    let leadingDeltaFromBlock = abs(segment.rect.minX - leadingAnchor(for: block))
    let centerDelta = abs(segment.rect.midX - neighbor.rect.midX)
    let strongHorizontalShift = leadingDeltaFromNeighbor > max(CGFloat(0.070), lineHeight * 3.0)
        && leadingDeltaFromBlock > max(CGFloat(0.062), lineHeight * 2.6)
    let centerLooksDifferent = centerDelta > max(CGFloat(0.12), minNeighborWidth * 0.75)

    if overlapRatio < 0.18, strongHorizontalShift, centerLooksDifferent {
        return true
    }

    let blockIsWide = block.rect.width > 0.64
    let segmentIsNarrow = segment.rect.width < block.rect.width * 0.45
    let startsAwayFromBlock = leadingDeltaFromBlock > max(CGFloat(0.090), lineHeight * 3.3)
    if blockIsWide, segmentIsNarrow, startsAwayFromBlock, overlapRatio < 0.34 {
        return true
    }

    if previousEndsStrongly(neighbor.text),
       !startsStructuredLine(segment.text),
       leadingDeltaFromNeighbor > max(CGFloat(0.060), lineHeight * 2.4),
       overlapRatio < 0.30 {
        return true
    }

    return false
}

private func leadingAnchor(for block: OCRBlock) -> CGFloat {
    let anchors = block.segments
        .map { $0.rect.minX }
        .sorted()
    guard !anchors.isEmpty else {
        return block.rect.minX
    }
    return anchors[anchors.count / 2]
}

private func verticalGapBetween(_ left: CGRect, _ right: CGRect) -> CGFloat {
    if left.maxY < right.minY {
        return right.minY - left.maxY
    }
    if right.maxY < left.minY {
        return left.minY - right.maxY
    }
    return 0
}

private func renderBlock(_ block: OCRBlock) -> String {
    let segments = block.segments.sorted(by: segmentReadingOrder)
    guard var output = segments.first?.text else { return "" }

    let preserveLines = shouldPreferLineBreaks(in: segments)
    var previous = segments[0]
    for segment in segments.dropFirst() {
        let boundary = boundaryBetween(
            previous: previous,
            next: segment,
            block: block,
            preserveLines: preserveLines
        )
        if boundary == .line,
           shouldJoinStructuredListContinuation(previous: lastRenderedLine(in: output), next: segment.text) {
            output = appendingToLastRenderedLine(output, segment.text)
            previous = segment
            continue
        }
        switch boundary {
        case .join:
            output = joinParagraphLine(output, segment.text)
        case .line:
            output += "\n\(segment.text)"
        case .paragraph:
            output += "\n\n\(segment.text)"
        }
        previous = segment
    }

    return output
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .replacingOccurrences(of: "\n{3,}", with: "\n\n", options: .regularExpression)
}

private func boundaryBetween(
    previous: OCRSegment,
    next: OCRSegment,
    block: OCRBlock,
    preserveLines: Bool
) -> OCRBoundary {
    let verticalGap = max(CGFloat(0), previous.rect.minY - next.rect.maxY)
    let lineHeight = max(CGFloat(0.001), max(previous.rect.height, next.rect.height))
    let gapRatio = verticalGap / lineHeight

    if gapRatio > 1.15 || verticalGap > 0.052 {
        return .paragraph
    }
    if looksLikeTableOfContentsLine(previous.text) || looksLikeTableOfContentsLine(next.text) {
        return .line
    }
    if shouldJoinTechnicalTokenWithoutSpace(left: previous.text, right: next.text) {
        return .join
    }
    if looksLikeKeyValueLine(previous.text) || looksLikeKeyValueLine(next.text) {
        return .line
    }
    if looksLikeDanglingFieldBoundary(previous: previous.text, next: next.text) {
        return .line
    }
    if looksLikeCodeOrQuoteLine(previous.text) || looksLikeCodeOrQuoteLine(next.text) {
        return .line
    }
    if looksLikeCrossColumnOrRegionBoundary(previous: previous, next: next, block: block) {
        return .paragraph
    }
    if looksLikeRaggedStructuredBoundary(previous: previous, next: next) {
        return .line
    }
    if preserveLines {
        return gapRatio > 0.75 ? .paragraph : .line
    }
    if startsStructuredLine(next.text) || startsStructuredLine(previous.text) {
        return .line
    }
    if isShortUIBoundary(previous.text, next.text) {
        return .line
    }

    let leadingDelta = abs(previous.rect.minX - next.rect.minX)
    let blockWidth = max(CGFloat(0.001), block.rect.width)
    let previousFillsLine = previous.rect.width >= blockWidth * 0.58
    let leadingTolerance = max(CGFloat(0.04), lineHeight * 2.2)

    if leadingDelta > leadingTolerance {
        return previousEndsStrongly(previous.text) ? .paragraph : .line
    }
    if looksLikeHeading(previous.text, next: next.text, in: blockWidth, width: previous.rect.width) {
        return .paragraph
    }
    if previousFillsLine || !previousEndsStrongly(previous.text) || startsLikeContinuation(next.text) {
        return .join
    }
    return .line
}

private func looksLikeCrossColumnOrRegionBoundary(
    previous: OCRSegment,
    next: OCRSegment,
    block: OCRBlock
) -> Bool {
    guard block.segments.count >= 3 else { return false }

    let lineHeight = max(previous.rect.height, next.rect.height, block.averageLineHeight, 0.001)
    let leadingDelta = abs(previous.rect.minX - next.rect.minX)
    let centerDelta = abs(previous.rect.midX - next.rect.midX)
    let overlap = horizontalOverlap(previous.rect, next.rect)
    let minWidth = max(CGFloat(0.001), min(previous.rect.width, next.rect.width))
    let overlapRatio = overlap / minWidth
    let strongLeadingShift = leadingDelta > max(CGFloat(0.095), lineHeight * 3.6)
    let strongCenterShift = centerDelta > max(CGFloat(0.115), minWidth * 0.72)

    guard strongLeadingShift, strongCenterShift, overlapRatio < 0.26 else {
        return false
    }

    let anchors = clusteredLeadingAnchors(in: block.segments)
    if let first = anchors.first,
       let last = anchors.last,
       anchors.count >= 2,
       last - first > max(CGFloat(0.14), lineHeight * 4.4) {
        return true
    }

    let verticalGap = max(CGFloat(0), previous.rect.minY - next.rect.maxY)
    let closeVertically = verticalGap <= max(CGFloat(0.038), lineHeight * 1.5)
    let oneLineIsNarrowRegion = min(previous.rect.width, next.rect.width) < block.rect.width * 0.58
    return block.segments.count >= 4 && closeVertically && oneLineIsNarrowRegion
}

private func shouldPreferLineBreaks(in segments: [OCRSegment]) -> Bool {
    guard segments.count >= 2 else { return false }

    if looksLikeTabularOrKeyValueBlock(segments) {
        return true
    }

    let tableOfContentsCount = segments.filter { looksLikeTableOfContentsLine($0.text) }.count
    if tableOfContentsCount >= 2 {
        return true
    }

    let codeOrQuoteCount = segments.filter { looksLikeCodeOrQuoteLine($0.text) }.count
    if codeOrQuoteCount >= 2 {
        return true
    }

    if segments.contains(where: { looksLikeDanglingFieldLabelLine($0.text) }) {
        return false
    }

    if looksLikeMultiColumnOrRegionBlock(segments) {
        return true
    }

    let shortCount = segments.filter { looksLikeShortUILabel($0.text) || startsStructuredLine($0.text) }.count
    let shortRatio = Double(shortCount) / Double(segments.count)
    let averageLength = Double(segments.map { meaningfulLength($0.text) }.reduce(0, +)) / Double(segments.count)

    if segments.count <= 3 {
        return shortCount == segments.count && averageLength <= 22
    }
    return shortRatio >= 0.62 && averageLength <= 28
}

private func blockReadingOrder(_ left: OCRBlock, _ right: OCRBlock) -> Bool {
    let verticalOverlapAmount = verticalOverlap(left.rect, right.rect)
    let minHeight = max(CGFloat(0.001), min(left.rect.height, right.rect.height))
    if verticalOverlapAmount / minHeight > 0.28 {
        return left.rect.minX < right.rect.minX
    }

    let topDelta = abs(left.rect.maxY - right.rect.maxY)
    let lineHeight = max(left.averageLineHeight, right.averageLineHeight)
    if topDelta <= max(CGFloat(0.035), lineHeight * 2.0), abs(left.rect.minX - right.rect.minX) > 0.04 {
        return left.rect.minX < right.rect.minX
    }
    return left.rect.maxY > right.rect.maxY
}

private func segmentReadingOrder(_ left: OCRSegment, _ right: OCRSegment) -> Bool {
    let yDelta = abs(left.rect.midY - right.rect.midY)
    if yDelta > max(CGFloat(0.012), min(left.rect.height, right.rect.height) * 0.55) {
        return left.rect.midY > right.rect.midY
    }
    return left.rect.minX < right.rect.minX
}

private func horizontalOverlap(_ left: CGRect, _ right: CGRect) -> CGFloat {
    max(CGFloat(0), min(left.maxX, right.maxX) - max(left.minX, right.minX))
}

private func verticalOverlap(_ left: CGRect, _ right: CGRect) -> CGFloat {
    max(CGFloat(0), min(left.maxY, right.maxY) - max(left.minY, right.minY))
}

private func joinInline(_ left: String, _ right: String) -> String {
    let left = left.trimmingCharacters(in: .whitespacesAndNewlines)
    let right = right.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !left.isEmpty else { return right }
    guard !right.isEmpty else { return left }
    return left + (needsSpaceBetween(left, right) ? " " : "") + right
}

private func joinParagraphLine(_ left: String, _ right: String) -> String {
    let left = left.trimmingCharacters(in: .whitespacesAndNewlines)
    let right = right.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !left.isEmpty else { return right }
    guard !right.isEmpty else { return left }

    if let dehyphenated = dehyphenatedLineBreakJoin(left: left, right: right) {
        return dehyphenated
    }
    if shouldJoinTechnicalTokenWithoutSpace(left: left, right: right) {
        return left + right
    }
    return left + (needsSpaceBetween(left, right) ? " " : "") + right
}

private func appendingToLastRenderedLine(_ output: String, _ line: String) -> String {
    guard let range = output.range(of: "\n", options: .backwards) else {
        return joinParagraphLine(output, line)
    }

    let prefix = output[..<range.upperBound]
    let lastLine = output[range.upperBound...]
    return String(prefix) + joinParagraphLine(String(lastLine), line)
}

private func lastRenderedLine(in output: String) -> String {
    guard let range = output.range(of: "\n", options: .backwards) else {
        return output
    }
    return String(output[range.upperBound...])
}

private func shouldJoinStructuredListContinuation(previous: String, next: String) -> Bool {
    guard startsListItemLine(previous),
          !endsListItemContinuation(previous),
          looksLikeListContinuationLine(next) else {
        return false
    }
    return true
}

private func looksLikeListContinuationLine(_ text: String) -> Bool {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard meaningfulLength(trimmed) >= 4,
          !startsStructuredLine(trimmed),
          !looksLikeTableOfContentsLine(trimmed),
          !looksLikeKeyValueLine(trimmed),
          !looksLikeDelimitedTableLine(trimmed),
          !looksLikeDanglingFieldLabelLine(trimmed),
          !looksLikeCodeOrQuoteLine(trimmed),
          !looksLikeStandaloneFieldValueLine(trimmed) else {
        return false
    }

    if startsWithLowercaseLatin(trimmed) {
        return true
    }
    if let first = firstMeaningfulScalar(in: trimmed), isCJK(first) {
        return true
    }
    return meaningfulLength(trimmed) >= 12 && !looksLikeShortUILabel(trimmed)
}

private func endsListItemContinuation(_ text: String) -> Bool {
    guard let last = lastMeaningfulScalar(in: text) else {
        return true
    }
    return CharacterSet(charactersIn: ".!?:。！？：").contains(last)
}

private func dehyphenatedLineBreakJoin(left: String, right: String) -> String? {
    guard startsWithLowercaseLatin(right),
          let trailing = lastMeaningfulScalar(in: left),
          isLineBreakHyphen(trailing) else {
        return nil
    }

    let leftBeforeHyphen = String(left.dropLast())
    guard let previous = lastMeaningfulScalar(in: leftBeforeHyphen),
          isLatinLetter(previous) else {
        return nil
    }

    if shouldPreserveHyphenatedCompoundLineBreak(
        leftBeforeHyphen: leftBeforeHyphen,
        right: right,
        hyphen: trailing
    ) {
        return left + right
    }

    return leftBeforeHyphen + right
}

private func shouldPreserveHyphenatedCompoundLineBreak(
    leftBeforeHyphen: String,
    right: String,
    hyphen: Unicode.Scalar
) -> Bool {
    guard hyphen.value != 0x00AD,
          let leftFragment = trailingLatinHyphenFragment(in: leftBeforeHyphen),
          let rightFragment = leadingLatinFragment(in: right),
          rightFragment.count >= 2 else {
        return false
    }

    if leftFragment.contains("-") {
        return true
    }

    return commonHyphenatedLineBreakPrefixes.contains(leftFragment.lowercased())
}

private func shouldJoinTechnicalTokenWithoutSpace(left: String, right: String) -> Bool {
    guard let trailing = trailingTechnicalTokenFragment(in: left),
          let leading = leadingTechnicalTokenFragment(in: right) else {
        return false
    }

    let joined = trailing + leading
    guard joined.range(of: #"[A-Za-z0-9]"#, options: .regularExpression) != nil else {
        return false
    }

    if trailing.hasSuffix("@") || leading.hasPrefix("@") {
        return joined.range(of: #"^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.-]+"#, options: .regularExpression) != nil
    }
    if trailing.range(of: #"https?://"#, options: [.regularExpression, .caseInsensitive]) != nil {
        return true
    }
    if trailing.hasSuffix("/") || leading.hasPrefix("/") {
        return joined.range(of: #"^~?/|/[A-Za-z0-9._~%+\-]"#, options: .regularExpression) != nil
    }
    if trailing.hasSuffix(".") || leading.hasPrefix(".") {
        return isLikelyDotSeparatedTechnicalJoin(trailing: trailing, leading: leading, joined: joined)
    }
    if trailing.hasSuffix("-") || leading.hasPrefix("-") || trailing.hasSuffix("_") || leading.hasPrefix("_") {
        return joined.range(of: #"[A-Za-z0-9][-_][A-Za-z0-9]"#, options: .regularExpression) != nil
    }
    if trailing.hasSuffix(":") || leading.hasPrefix(":") {
        return joined.range(
            of: #"^(?:https?|file|ftp|s3|gs|ssh):[/A-Za-z0-9]"#,
            options: [.regularExpression, .caseInsensitive]
        ) != nil
            || joined.range(of: #"^[A-Za-z]:[/\\]"#, options: .regularExpression) != nil
    }
    return false
}

private func isLikelyDotSeparatedTechnicalJoin(trailing: String, leading: String, joined: String) -> Bool {
    if joined.range(of: #"\d+\.\d+"#, options: .regularExpression) != nil {
        return true
    }

    let trailingPrefix = trailing.hasSuffix(".") ? String(trailing.dropLast()) : trailing
    let separatorScalars = CharacterSet(charactersIn: "/:@._~%+-")
    if trailingPrefix.unicodeScalars.contains(where: { separatorScalars.contains($0) }) {
        return true
    }

    let leadingSuffix = leading.hasPrefix(".") ? String(leading.dropFirst()) : leading
    let leadingHead = leadingSuffix
        .split(whereSeparator: { "/:?#".contains($0) })
        .first
        .map(String.init) ?? ""
    return commonTechnicalTopLevelDomains.contains(leadingHead.lowercased())
}

private func trailingTechnicalTokenFragment(in text: String) -> String? {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let range = trimmed.range(
        of: #"[A-Za-z0-9][A-Za-z0-9._~%+\-/:@]*[._~%+\-/:@]$"#,
        options: .regularExpression
    ) else {
        return nil
    }
    return String(trimmed[range])
}

private func leadingTechnicalTokenFragment(in text: String) -> String? {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let range = trimmed.range(
        of: #"^[._~%+\-/:@]?[A-Za-z0-9][A-Za-z0-9._~%+\-/:@]*"#,
        options: .regularExpression
    ) else {
        return nil
    }
    return String(trimmed[range])
}

private func trailingLatinHyphenFragment(in text: String) -> String? {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let range = trimmed.range(
        of: #"[A-Za-z][A-Za-z-]*$"#,
        options: .regularExpression
    ) else {
        return nil
    }
    return String(trimmed[range])
}

private func leadingLatinFragment(in text: String) -> String? {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let range = trimmed.range(
        of: #"^[a-z]{2,}"#,
        options: .regularExpression
    ) else {
        return nil
    }
    return String(trimmed[range])
}

private func startsListItemLine(_ text: String) -> Bool {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return false }
    if trimmed.range(of: #"^[-*•·●○]\s*\S"#, options: .regularExpression) != nil {
        return true
    }
    if trimmed.range(of: #"^\[[ xX✓✔-]\]\s*\S"#, options: .regularExpression) != nil {
        return true
    }
    if trimmed.range(of: #"^[☐☑☒✓✔]\s*\S"#, options: .regularExpression) != nil {
        return true
    }
    if trimmed.range(of: #"^\d{1,3}[\.)、]\s*\S"#, options: .regularExpression) != nil {
        return true
    }
    if trimmed.range(of: #"^[A-Za-z][\.)]\s*\S"#, options: .regularExpression) != nil {
        return true
    }
    if trimmed.range(of: #"^[（(]\s*(\d{1,3}|[A-Za-z]|[IVXLCDMivxlcdm]{1,8}|[一二三四五六七八九十百千万]+)\s*[）)]\s*\S"#, options: .regularExpression) != nil {
        return true
    }
    if trimmed.range(of: #"^[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳⑴⑵⑶⑷⑸⑹⑺⑻⑼⑽⒈⒉⒊⒋⒌⒍⒎⒏⒐⒑❶❷❸❹❺❻❼❽❾❿]\s*\S"#, options: .regularExpression) != nil {
        return true
    }
    if trimmed.range(of: #"^[IVXLCDMivxlcdm]{1,8}[\.)]\s*\S"#, options: .regularExpression) != nil {
        return true
    }
    if trimmed.range(of: #"^[一二三四五六七八九十百千万]+[、\.)．]\s*\S"#, options: .regularExpression) != nil {
        return true
    }
    return false
}

private func needsSpaceBetween(_ left: String, _ right: String) -> Bool {
    guard let last = lastMeaningfulScalar(in: left),
          let first = firstMeaningfulScalar(in: right) else {
        return false
    }

    if isClosingPunctuation(first) || isOpeningPunctuation(last) {
        return false
    }
    if isCJK(last), isCJK(first) {
        return false
    }
    if isCJK(last), isCJKPunctuation(first) {
        return false
    }
    if isCJKPunctuation(last), isCJK(first) {
        return false
    }
    return true
}

private func isLikelyInlineFragment(_ text: String) -> Bool {
    let length = meaningfulLength(text)
    if length <= 3 {
        return true
    }
    if wordCount(text) == 1, length <= 14, !containsSentencePunctuation(text) {
        return true
    }
    return false
}

private func startsStructuredLine(_ text: String) -> Bool {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return false }

    if trimmed.range(of: #"^[-*•·●○]\s*\S"#, options: .regularExpression) != nil {
        return true
    }
    if trimmed.range(of: #"^\[[ xX✓✔-]\]\s*\S"#, options: .regularExpression) != nil {
        return true
    }
    if trimmed.range(of: #"^[☐☑☒✓✔]\s*\S"#, options: .regularExpression) != nil {
        return true
    }
    if trimmed.range(of: #"^\d{1,3}[\.)、]\s*\S"#, options: .regularExpression) != nil {
        return true
    }
    if trimmed.range(of: #"^[A-Za-z][\.)]\s*\S"#, options: .regularExpression) != nil {
        return true
    }
    if trimmed.range(of: #"^[（(]\s*(\d{1,3}|[A-Za-z]|[IVXLCDMivxlcdm]{1,8}|[一二三四五六七八九十百千万]+)\s*[）)]\s*\S"#, options: .regularExpression) != nil {
        return true
    }
    if trimmed.range(of: #"^[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳⑴⑵⑶⑷⑸⑹⑺⑻⑼⑽⒈⒉⒊⒋⒌⒍⒎⒏⒐⒑❶❷❸❹❺❻❼❽❾❿]\s*\S"#, options: .regularExpression) != nil {
        return true
    }
    if trimmed.range(of: #"^[IVXLCDMivxlcdm]{1,8}[\.)]\s*\S"#, options: .regularExpression) != nil {
        return true
    }
    if trimmed.range(of: #"^[一二三四五六七八九十百千万]+[、\.)．]\s*\S"#, options: .regularExpression) != nil {
        return true
    }
    if trimmed.range(of: #"^第[一二三四五六七八九十百千万]+[章节条项]\s*\S"#, options: .regularExpression) != nil {
        return true
    }
    if trimmed.range(of: #"^#{1,6}\s+\S"#, options: .regularExpression) != nil {
        return true
    }
    if trimmed.range(of: #"^>{1,3}\s*\S"#, options: .regularExpression) != nil {
        return true
    }
    return false
}

private func looksLikeKeyValueLine(_ text: String) -> Bool {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard meaningfulLength(trimmed) >= 3 else { return false }

    if looksLikeTableOfContentsLine(trimmed) {
        return true
    }
    if looksLikeDelimitedTableLine(trimmed) {
        return true
    }
    if trimmed.range(of: #"^[^:：]{1,24}[:：]\s*\S"#, options: .regularExpression) != nil {
        return true
    }
    if trimmed.range(of: #"^[^=＝]{1,24}[=＝]\s*\S"#, options: .regularExpression) != nil {
        return true
    }
    if trimmed.range(of: #"^\S.{0,22}\s{2,}\S"#, options: .regularExpression) != nil {
        return true
    }
    return false
}

private func looksLikeDanglingFieldLabelLine(_ text: String) -> Bool {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    let length = meaningfulLength(trimmed)
    guard length >= 2, length <= 32 else { return false }
    guard let last = lastMeaningfulScalar(in: trimmed),
          CharacterSet(charactersIn: ":：").contains(last) else {
        return false
    }
    guard trimmed.range(of: #"[.!?。！？]$"#, options: .regularExpression) == nil,
          !looksLikeTableOfContentsLine(trimmed),
          !looksLikeDelimitedTableLine(trimmed) else {
        return false
    }

    let label = String(trimmed.dropLast())
        .trimmingCharacters(in: .whitespacesAndNewlines)
    guard meaningfulLength(label) >= 1 else { return false }

    if label.unicodeScalars.contains(where: isCJK) {
        return meaningfulLength(label) <= 18
    }
    return wordCount(label) <= 5
}

private func looksLikeDanglingFieldBoundary(previous: String, next: String) -> Bool {
    looksLikeDanglingFieldLabelLine(previous) || looksLikeDanglingFieldLabelLine(next)
}

private func looksLikeTableOfContentsLine(_ text: String) -> Bool {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard meaningfulLength(trimmed) >= 6 else { return false }

    if trimmed.range(
        of: #".{2,}\s*[.·•‧⋯…]{2,}\s*(?:[A-Za-z]?\d{1,4}|[IVXLCDMivxlcdm]{1,8})\s*$"#,
        options: .regularExpression
    ) != nil {
        return true
    }

    return trimmed.range(
        of: #"^(?:\d{1,2}(?:[\.)]\d{1,2})*|[IVXLCDMivxlcdm]{1,8}|第[一二三四五六七八九十百千万]+[章节篇])\s+.{2,}\s{2,}(?:\d{1,4}|[IVXLCDMivxlcdm]{1,8})$"#,
        options: .regularExpression
    ) != nil
}

private func looksLikeDelimitedTableLine(_ text: String) -> Bool {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.range(of: #"\S(?:\t+|\s{2,})\S"#, options: .regularExpression) != nil {
        return true
    }

    if trimmed.filter({ $0 == "|" }).count >= 2 {
        return true
    }

    return trimmed.range(
        of: #"^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$"#,
        options: .regularExpression
    ) != nil
}

private func looksLikeTabularOrKeyValueBlock(_ segments: [OCRSegment]) -> Bool {
    guard segments.count >= 2 else { return false }

    let keyValueCount = segments.filter { looksLikeKeyValueLine($0.text) }.count
    if keyValueCount >= 2 {
        return true
    }

    let shortOrStructuredCount = segments.filter {
        looksLikeShortUILabel($0.text) || startsStructuredLine($0.text)
    }.count
    let shortRatio = Double(shortOrStructuredCount) / Double(segments.count)
    let leadingAnchors = clusteredLeadingAnchors(in: segments)

    if segments.count >= 3, shortRatio >= 0.66, leadingAnchors.count >= 2 {
        return true
    }

    let widths = segments.map(\.rect.width)
    let averageWidth = widths.reduce(0, +) / CGFloat(widths.count)
    let widthVariance = widths.map { abs($0 - averageWidth) }.reduce(0, +) / CGFloat(widths.count)
    return segments.count >= 3
        && shortRatio >= 0.50
        && widthVariance > max(CGFloat(0.040), averageWidth * 0.28)
}

private func looksLikeMultiColumnOrRegionBlock(_ segments: [OCRSegment]) -> Bool {
    guard segments.count >= 6 else { return false }

    let anchors = clusteredLeadingAnchors(in: segments)
    guard anchors.count >= 2,
          let first = anchors.first,
          let last = anchors.last,
          last - first > max(CGFloat(0.16), (segments.map(\.rect.height).average) * 5.0) else {
        return false
    }

    let lengths = segments.map { meaningfulLength($0.text) }
    let shortCount = segments.filter { looksLikeShortUILabel($0.text) || startsStructuredLine($0.text) }.count
    let shortRatio = Double(shortCount) / Double(segments.count)
    if shortRatio >= 0.55 {
        return true
    }

    let averageLength = Double(lengths.reduce(0, +)) / Double(lengths.count)
    let alternatingCount = alternatingLineLengthCount(in: lengths)
    return alternatingCount >= 3 && averageLength <= 46
}

private func alternatingLineLengthCount(in lengths: [Int]) -> Int {
    guard lengths.count >= 3 else { return 0 }

    var count = 0
    for index in 1..<(lengths.count - 1) {
        let previous = lengths[index - 1]
        let current = lengths[index]
        let next = lengths[index + 1]
        let isValley = previous - current >= 12 && next - current >= 12
        let isPeak = current - previous >= 12 && current - next >= 12
        if isValley || isPeak {
            count += 1
        }
    }
    return count
}

private func looksLikeRaggedStructuredBoundary(previous: OCRSegment, next: OCRSegment) -> Bool {
    let leadingDelta = abs(previous.rect.minX - next.rect.minX)
    let widthDelta = abs(previous.rect.width - next.rect.width)
    let lineHeight = max(previous.rect.height, next.rect.height, 0.001)
    let bothShort = looksLikeShortUILabel(previous.text) && looksLikeShortUILabel(next.text)
    let keyValuePair = looksLikeKeyValueLine(previous.text) || looksLikeKeyValueLine(next.text)
    let visiblyShifted = leadingDelta > max(CGFloat(0.045), lineHeight * 1.9)
    let widthLooksRagged = widthDelta > max(CGFloat(0.080), min(previous.rect.width, next.rect.width) * 0.55)

    return (bothShort || keyValuePair) && (visiblyShifted || widthLooksRagged)
}

private func clusteredLeadingAnchors(in segments: [OCRSegment]) -> [CGFloat] {
    let tolerance = max(
        CGFloat(0.018),
        (segments.map(\.rect.height).average) * 0.85
    )
    return segments
        .map { $0.rect.minX }
        .sorted()
        .reduce(into: [CGFloat]()) { clusters, value in
            guard let last = clusters.last else {
                clusters.append(value)
                return
            }
            if abs(last - value) > tolerance {
                clusters.append(value)
            }
        }
}

private func isShortUIBoundary(_ previous: String, _ next: String) -> Bool {
    looksLikeShortUILabel(previous) && looksLikeShortUILabel(next)
}

private func looksLikeShortUILabel(_ text: String) -> Bool {
    let length = meaningfulLength(text)
    guard length > 0 else { return false }
    if containsSentencePunctuation(text), length > 10 {
        return false
    }

    let cjkCount = text.unicodeScalars.filter(isCJK).count
    if cjkCount >= 10 {
        return false
    }
    if length <= 18 {
        return true
    }
    return wordCount(text) <= 3 && length <= 28
}

private func looksLikeStandaloneFieldValueLine(_ text: String) -> Bool {
    looksLikeStandaloneValueLine(text)
        || looksLikeStandaloneStatusLine(text)
        || looksLikeStandaloneIdentifierValueLine(text)
}

private func looksLikeStandaloneValueLine(_ text: String) -> Bool {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard meaningfulLength(trimmed) >= 1, meaningfulLength(trimmed) <= 30 else { return false }

    if trimmed.range(
        of: #"^[+\-−]?\s*(?:[$€¥£]\s*)?\d[\d,.\s]*(?:%|[A-Za-z]{1,6}|[万亿年月日天时分秒]+|[mMkKgGtTpP]?[bB]/s?)?$"#,
        options: .regularExpression
    ) != nil {
        return true
    }

    return trimmed.range(
        of: #"^[+\-−]?\s*(?:[$€¥£]\s*)?\d[\d,.\s]*\s*(?:/|of)\s*\d[\d,.\s]*(?:%|[A-Za-z]{1,6})?$"#,
        options: [.regularExpression, .caseInsensitive]
    ) != nil
}

private func looksLikeStandaloneIdentifierValueLine(_ text: String) -> Bool {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    let length = meaningfulLength(trimmed)
    guard length >= 3, length <= 80,
          !containsSentencePunctuation(trimmed),
          !trimmed.contains(where: \.isWhitespace) else {
        return false
    }

    if trimmed.range(of: #"^https?://\S+$"#, options: [.regularExpression, .caseInsensitive]) != nil {
        return true
    }
    if trimmed.range(of: #"^[A-Za-z0-9][A-Za-z0-9._:/@+-]*[0-9][A-Za-z0-9._:/@+-]*$"#, options: .regularExpression) != nil {
        return true
    }
    return trimmed.range(of: #"^[A-Za-z0-9][A-Za-z0-9._:/@+-]*[-_/:@][A-Za-z0-9._:/@+-]*$"#, options: .regularExpression) != nil
}

private func looksLikeStandaloneStatusLine(_ text: String) -> Bool {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard meaningfulLength(trimmed) >= 2, meaningfulLength(trimmed) <= 20 else { return false }

    return trimmed.range(
        of: #"^(?:ok|done|failed|error|pending|active|inactive|enabled|disabled|online|offline|on|off|yes|no|成功|失败|完成|待处理|进行中|启用|停用|开启|关闭|正常|异常|在线|离线|通过|未通过)$"#,
        options: [.regularExpression, .caseInsensitive]
    ) != nil
}

private func looksLikeHeading(_ text: String, next: String, in blockWidth: CGFloat, width: CGFloat) -> Bool {
    let length = meaningfulLength(text)
    guard length > 0, length <= 28 else { return false }
    guard !startsStructuredLine(text), !previousEndsStrongly(text) else { return false }

    let nextLength = meaningfulLength(next)
    if looksLikeShortUILabel(text), nextLength >= length + 6 {
        return true
    }
    return length <= 18 && width < blockWidth * 0.55 && nextLength > length
}

private func previousEndsStrongly(_ text: String) -> Bool {
    guard let last = lastMeaningfulScalar(in: text) else { return false }
    return CharacterSet(charactersIn: ".!?。！？；;…").contains(last)
}

private func containsSentencePunctuation(_ text: String) -> Bool {
    text.unicodeScalars.contains { CharacterSet(charactersIn: ".!?。！？；;，,、").contains($0) }
}

private func looksLikeCodeOrQuoteLine(_ text: String) -> Bool {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return false }
    if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
        return true
    }
    if trimmed.range(of: #"^(`{1,3}|'{3})\S"#, options: .regularExpression) != nil {
        return true
    }
    if trimmed.range(of: #"^[{}\[\]().,;]\s*$"#, options: .regularExpression) != nil {
        return true
    }
    if trimmed.range(of: #"^</?[A-Za-z][A-Za-z0-9:-]*(\s|>|/>)"#, options: .regularExpression) != nil {
        return true
    }
    if trimmed.range(of: #"^(func|let|var|class|struct|enum|import|return|guard|throw|try|await|const|function|def|public|private|protected|static)\b"#, options: .regularExpression) != nil {
        return true
    }
    if trimmed.range(of: #"^(if|else|for|while)\b.*(?:[;:{}]|\))\s*$"#, options: .regularExpression) != nil {
        return true
    }
    if trimmed.range(of: #"^[A-Za-z_][A-Za-z0-9_\.]*\s*\([^)]*\)\s*[;{]?$"#, options: .regularExpression) != nil {
        return true
    }
    return false
}

private func startsLikeContinuation(_ text: String) -> Bool {
    guard let first = firstMeaningfulScalar(in: text) else { return false }
    if isCJK(first) {
        return true
    }
    if (0x0061...0x007A).contains(first.value) || (0x0030...0x0039).contains(first.value) {
        return true
    }
    return CharacterSet(charactersIn: "，,.;:!?)]}）。！？；：").contains(first)
}

private func startsWithLowercaseLatin(_ text: String) -> Bool {
    guard let first = firstMeaningfulScalar(in: text) else { return false }
    return (0x0061...0x007A).contains(first.value)
}

private func wordCount(_ text: String) -> Int {
    text.split { character in
        character.isWhitespace || character.isPunctuation
    }.count
}

private func meaningfulLength(_ text: String) -> Int {
    text.unicodeScalars.filter { !CharacterSet.whitespacesAndNewlines.contains($0) }.count
}

private func firstMeaningfulScalar(in text: String) -> Unicode.Scalar? {
    text.unicodeScalars.first { !CharacterSet.whitespacesAndNewlines.contains($0) }
}

private func lastMeaningfulScalar(in text: String) -> Unicode.Scalar? {
    text.unicodeScalars.reversed().first { !CharacterSet.whitespacesAndNewlines.contains($0) }
}

private func isCJK(_ scalar: Unicode.Scalar) -> Bool {
    switch scalar.value {
    case 0x4E00...0x9FFF, 0x3400...0x4DBF, 0xF900...0xFAFF:
        return true
    default:
        return false
    }
}

private func isCJKPunctuation(_ scalar: Unicode.Scalar) -> Bool {
    CharacterSet(charactersIn: "，。！？；：、）】》」』").contains(scalar)
}

private func isLatinLetter(_ scalar: Unicode.Scalar) -> Bool {
    (0x0041...0x005A).contains(scalar.value) || (0x0061...0x007A).contains(scalar.value)
}

private func isLineBreakHyphen(_ scalar: Unicode.Scalar) -> Bool {
    CharacterSet(charactersIn: "-\u{00AD}\u{2010}\u{2011}").contains(scalar)
}

private func isClosingPunctuation(_ scalar: Unicode.Scalar) -> Bool {
    CharacterSet(charactersIn: ".,!?;:%)]}，。！？；：、）】》」』").contains(scalar)
}

private func isOpeningPunctuation(_ scalar: Unicode.Scalar) -> Bool {
    CharacterSet(charactersIn: "([{\u{300C}\u{300E}\u{300A}\u{3010}").contains(scalar)
}

private let commonHyphenatedLineBreakPrefixes: Set<String> = [
    "anti", "cross", "end", "full", "high", "long", "low", "multi", "non",
    "open", "post", "pre", "real", "self", "short", "well", "zero"
]

private let commonTechnicalTopLevelDomains: Set<String> = [
    "app", "ai", "au", "ca", "cloud", "cn", "co", "com", "de", "dev", "edu", "fr",
    "gov", "io", "jp", "me", "net", "online", "org", "site", "tech", "top", "uk",
    "us", "xyz"
]

private extension Array where Element == CGFloat {
    var average: CGFloat {
        guard !isEmpty else { return 0 }
        return reduce(0, +) / CGFloat(count)
    }
}
