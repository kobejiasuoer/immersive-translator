import XCTest
@testable import ProviderCore

final class ProviderProfileTests: XCTestCase {
    func testBuiltinPresetsStayUniqueAndOfferTheirCurrentModel() {
        let presets = ProviderProfile.builtinPresets

        XCTAssertEqual(presets.map(\.id), ["deepseek", "zhipu", "openai"])
        XCTAssertEqual(Set(presets.map(\.id)).count, presets.count)
        XCTAssertEqual(Set(presets.map(\.displayName)).count, presets.count)

        for preset in presets {
            XCTAssertTrue(preset.isBuiltin)
            XCTAssertTrue(preset.customModels.isEmpty)
            XCTAssertTrue(preset.modelCandidates.contains(preset.model))
        }
    }

    func testModelCandidatesTrimAndDeduplicateCustomHistory() {
        let profile = ProviderProfile(
            id: "custom",
            displayName: "Custom",
            endpoint: "https://example.com/v1/chat/completions",
            model: "model-a",
            isBuiltin: false,
            customModels: [" model-a ", "model-b", "model-a", "", " model-c "]
        )

        XCTAssertEqual(profile.modelCandidates, ["model-a", "model-b", "model-c"])
    }

    func testModelCandidatesIncludeCurrentCustomModel() {
        let profile = ProviderProfile(
            id: "custom",
            displayName: "Custom",
            endpoint: "https://example.com/v1/chat/completions",
            model: "current-model",
            isBuiltin: false,
            customModels: ["older-model"]
        )

        XCTAssertEqual(profile.modelCandidates, ["current-model", "older-model"])
    }

    func testAppendingCustomModelsKeepsTheEightMostRecentUniqueValues() {
        var profile = ProviderProfile(
            id: "custom",
            displayName: "Custom",
            endpoint: "https://example.com/v1/chat/completions",
            model: "model-0",
            isBuiltin: false,
            customModels: []
        )

        for index in 0..<10 {
            profile.appendCustomModel(" model-\(index) ")
        }
        profile.appendCustomModel("model-9")

        XCTAssertEqual(profile.customModels, (2..<10).map { "model-\($0)" })
    }

    func testAppendingModelDoesNotDuplicateWhitespaceVariant() {
        var profile = ProviderProfile(
            id: "custom",
            displayName: "Custom",
            endpoint: "https://example.com/v1/chat/completions",
            model: "model-a",
            isBuiltin: false,
            customModels: [" model-a "]
        )

        profile.appendCustomModel("model-a")

        XCTAssertEqual(profile.customModels, ["model-a"])
    }

    func testPersistedModelHistoryIsNormalizedAndCapped() throws {
        let profile = try JSONDecoder().decode(
            ProviderProfile.self,
            from: Data("""
            {
              "id": "custom",
              "displayName": "Custom",
              "endpoint": "https://example.com/v1",
              "model": "current",
              "isBuiltin": false,
              "customModels": [" old-0 ", "old-1", "old-1", "", " old-2 ", "old-3", "old-4", "old-5", "old-6", "old-7", "old-8"]
            }
            """.utf8)
        )

        XCTAssertEqual(profile.customModels, ["old-1", "old-2", "old-3", "old-4", "old-5", "old-6", "old-7", "old-8"])
    }
}
