import Foundation
import XCTest
@testable import ProviderCore

final class ProviderMigrationTests: XCTestCase {
    func testEndpointSpellingVariantsMatchABuiltinProvider() {
        XCTAssertTrue(
            ProviderMigration.matches(
                "  HTTPS://API.OPENAI.COM/v1/chat/completions/  ",
                "https://api.openai.com/v1/chat/completions"
            )
        )
        XCTAssertEqual(
            ProviderMigration.normalizedHost("https://api.openai.com/v1/chat/completions/"),
            "api.openai.com"
        )
        XCTAssertEqual(
            ProviderMigration.normalizedHost(
                "https://api.openai.com/v1/chat/completions/?api_key=legacy-secret#debug"
            ),
            "api.openai.com"
        )
        XCTAssertTrue(
            ProviderMigration.matches(
                "https://api.openai.com/v1",
                "https://api.openai.com/v1/chat/completions"
            )
        )
        XCTAssertTrue(
            ProviderMigration.matches(
                "https://open.bigmodel.cn/api/paas/v4/",
                "https://open.bigmodel.cn/api/paas/v4/chat/completions"
            )
        )
    }

    func testDifferentHostsAndSchemesDoNotMatch() {
        XCTAssertFalse(
            ProviderMigration.matches(
                "https://api.openai.com/v1/chat/completions",
                "https://api.deepseek.com/chat/completions"
            )
        )
        XCTAssertFalse(
            ProviderMigration.matches(
                "ftp://api.openai.com/v1/chat/completions",
                "https://api.openai.com/v1/chat/completions"
            )
        )
        XCTAssertFalse(
            ProviderMigration.matches(
                "https://api.openai.com/custom/path",
                "https://api.openai.com/v1/chat/completions"
            )
        )
        XCTAssertFalse(ProviderMigration.matches("", "https://api.openai.com/v1/chat/completions"))
    }

    func testStoredProviderNormalizationMigratesUnambiguousWhitespaceID() throws {
        let custom = ProviderProfile(
            id: " custom-id ",
            displayName: "Custom",
            endpoint: "https://example.com/v1",
            model: "custom-model",
            isBuiltin: false,
            customModels: ["older-model"]
        )
        var activeProviderID = custom.id
        var credentialMoves: [(String, String)] = []

        let providers = ProviderMigration.normalizeStoredProviders(
            ProviderProfile.builtinPresets + [custom],
            activeProviderID: &activeProviderID,
            onProviderIDChange: { oldID, newID in
                credentialMoves.append((oldID, newID))
                return true
            }
        )

        let normalized = try XCTUnwrap(providers.first { $0.displayName == custom.displayName })
        XCTAssertEqual(normalized.id, "custom-id")
        XCTAssertEqual(normalized.endpoint, custom.endpoint)
        XCTAssertEqual(normalized.customModels, custom.customModels)
        XCTAssertEqual(activeProviderID, normalized.id)
        XCTAssertEqual(credentialMoves.map { "\($0.0)->\($0.1)" }, [" custom-id ->custom-id"])
    }

    func testStoredProviderNormalizationPreservesCredentialSpellingOnCopyFailure() throws {
        let custom = ProviderProfile(
            id: " custom-id ",
            displayName: "Custom",
            endpoint: "https://example.com/v1",
            model: "custom-model",
            isBuiltin: false,
            customModels: []
        )
        // Simulate the inconsistent spelling persisted by a previous build.
        var activeProviderID = "custom-id"

        let providers = ProviderMigration.normalizeStoredProviders(
            ProviderProfile.builtinPresets + [custom],
            activeProviderID: &activeProviderID,
            onProviderIDChange: { _, _ in false }
        )

        let preserved = try XCTUnwrap(providers.first { $0.displayName == custom.displayName })
        XCTAssertEqual(preserved.id, custom.id)
        XCTAssertEqual(activeProviderID, custom.id)
        XCTAssertTrue(providers.contains { $0.id == activeProviderID })
    }

    func testMigrationSelectsMatchingBuiltinAndCarriesLegacyValues() {
        withIsolatedDefaults { defaults in
            defaults.set(
                " HTTPS://API.OPENAI.COM/v1/chat/completions/?debug=true ",
                forKey: ProviderMigration.legacyEndpointKey
            )
            defaults.set(" gpt-custom ", forKey: ProviderMigration.legacyModelKey)

            var providers = ProviderProfile.builtinPresets
            var activeProviderID = "deepseek"
            ProviderMigration.runIfNeeded(
                providers: &providers,
                activeProviderID: &activeProviderID,
                defaults: defaults
            )

            XCTAssertEqual(activeProviderID, "openai")
            XCTAssertEqual(providers.first { $0.id == "openai" }?.endpoint, "HTTPS://API.OPENAI.COM/v1/chat/completions/?debug=true")
            XCTAssertEqual(providers.first { $0.id == "openai" }?.model, "gpt-custom")
        }
    }

    func testMigrationImportsUnknownEndpointAndIsIdempotent() throws {
        try withIsolatedDefaults { defaults in
            defaults.set("https://example.com/v1", forKey: ProviderMigration.legacyEndpointKey)
            defaults.set("example-model", forKey: ProviderMigration.legacyModelKey)

            var providers = ProviderProfile.builtinPresets
            var activeProviderID = "deepseek"
            ProviderMigration.runIfNeeded(
                providers: &providers,
                activeProviderID: &activeProviderID,
                defaults: defaults
            )

            let importedID = try XCTUnwrap(providers.first { !$0.isBuiltin }?.id)
            XCTAssertEqual(activeProviderID, importedID)
            XCTAssertEqual(providers.first { $0.id == importedID }?.model, "example-model")

            defaults.set("https://another.example/v1", forKey: ProviderMigration.legacyEndpointKey)
            ProviderMigration.runIfNeeded(
                providers: &providers,
                activeProviderID: &activeProviderID,
                defaults: defaults
            )
            XCTAssertEqual(providers.filter { !$0.isBuiltin }.count, 1)
            XCTAssertEqual(activeProviderID, importedID)
        }
    }

    func testMigrationReusesEquivalentCustomProviderInsteadOfImportingADuplicate() {
        withIsolatedDefaults { defaults in
            defaults.set("https://example.com/custom/path/?token=legacy", forKey: ProviderMigration.legacyEndpointKey)
            defaults.set("example-model", forKey: ProviderMigration.legacyModelKey)

            let existing = ProviderProfile(
                id: "existing-custom",
                displayName: "Existing",
                endpoint: "https://example.com/custom/path",
                model: "older-model",
                isBuiltin: false,
                customModels: []
            )
            var providers = ProviderProfile.builtinPresets + [existing]
            var activeProviderID = "deepseek"

            ProviderMigration.runIfNeeded(
                providers: &providers,
                activeProviderID: &activeProviderID,
                defaults: defaults
            )

            XCTAssertEqual(providers.filter { !$0.isBuiltin }.map(\.id), [existing.id])
            XCTAssertEqual(activeProviderID, existing.id)
            XCTAssertEqual(providers.last?.endpoint, "https://example.com/custom/path/?token=legacy")
            XCTAssertEqual(providers.last?.model, "example-model")
        }
    }

    func testV2RepairsKnownProviderImportedByV1() {
        withIsolatedDefaults { defaults in
            defaults.set(true, forKey: "didMigrateProvidersV1")
            defaults.set(
                "HTTPS://API.OPENAI.COM/v1/?debug=true",
                forKey: ProviderMigration.legacyEndpointKey
            )
            defaults.set("legacy-openai-model", forKey: ProviderMigration.legacyModelKey)

            let imported = ProviderProfile(
                id: "legacy-import",
                displayName: "导入的提供商",
                endpoint: "HTTPS://API.OPENAI.COM/v1/?debug=true",
                model: "legacy-openai-model",
                isBuiltin: false,
                customModels: ["older-model"]
            )
            var providers = ProviderProfile.builtinPresets + [imported]
            var activeProviderID = imported.id
            var providerIDChanges: [(String, String)] = []

            ProviderMigration.runIfNeeded(
                providers: &providers,
                activeProviderID: &activeProviderID,
                defaults: defaults,
                onProviderIDChange: {
                    providerIDChanges.append(($0, $1))
                    return true
                }
            )

            XCTAssertEqual(activeProviderID, "openai")
            XCTAssertFalse(providers.contains { $0.id == imported.id })
            XCTAssertEqual(providerIDChanges.map { "\($0.0)->\($0.1)" }, ["legacy-import->openai"])

            let openAI = providers.first { $0.id == "openai" }
            XCTAssertEqual(openAI?.endpoint, imported.endpoint)
            XCTAssertEqual(openAI?.model, imported.model)
            XCTAssertTrue(openAI?.customModels.contains("older-model") == true)
            XCTAssertTrue(openAI?.customModels.contains("legacy-openai-model") == true)

            ProviderMigration.runIfNeeded(
                providers: &providers,
                activeProviderID: &activeProviderID,
                defaults: defaults,
                onProviderIDChange: {
                    providerIDChanges.append(($0, $1))
                    return true
                }
            )
            XCTAssertEqual(providerIDChanges.count, 1)
            XCTAssertEqual(providers.count, ProviderProfile.builtinPresets.count)
        }
    }

    func testV2PreservesImportedProviderUsingUnknownCustomPath() {
        withIsolatedDefaults { defaults in
            defaults.set(true, forKey: "didMigrateProvidersV1")
            defaults.set(
                "https://api.openai.com/internal/gateway",
                forKey: ProviderMigration.legacyEndpointKey
            )

            let imported = ProviderProfile(
                id: "custom-path-import",
                displayName: "导入的提供商",
                endpoint: "https://api.openai.com/internal/gateway",
                model: "proxy-model",
                isBuiltin: false,
                customModels: []
            )
            var providers = ProviderProfile.builtinPresets + [imported]
            var activeProviderID = imported.id
            var providerIDChanges: [(String, String)] = []

            ProviderMigration.runIfNeeded(
                providers: &providers,
                activeProviderID: &activeProviderID,
                defaults: defaults,
                onProviderIDChange: {
                    providerIDChanges.append(($0, $1))
                    return true
                }
            )

            XCTAssertEqual(activeProviderID, imported.id)
            XCTAssertEqual(providers.last, imported)
            XCTAssertTrue(providerIDChanges.isEmpty)
        }
    }

    func testV2DoesNotCompleteWhenKeychainMigrationFails() {
        withIsolatedDefaults { defaults in
            defaults.set(true, forKey: "didMigrateProvidersV1")
            defaults.set("https://api.openai.com/v1", forKey: ProviderMigration.legacyEndpointKey)

            let imported = ProviderProfile(
                id: "legacy-import-failed",
                displayName: "导入的提供商",
                endpoint: "https://api.openai.com/v1",
                model: "legacy-model",
                isBuiltin: false,
                customModels: []
            )
            var providers = ProviderProfile.builtinPresets + [imported]
            var activeProviderID = imported.id

            let didComplete = ProviderMigration.runIfNeeded(
                providers: &providers,
                activeProviderID: &activeProviderID,
                defaults: defaults,
                onProviderIDChange: { _, _ in false }
            )

            XCTAssertFalse(didComplete)
            XCTAssertFalse(defaults.bool(forKey: "didMigrateProvidersV2"))
            XCTAssertTrue(providers.contains { $0.id == imported.id })
            XCTAssertEqual(activeProviderID, imported.id)
        }
    }

    func testV2DoesNotMergeUserNamedCustomProvider() {
        withIsolatedDefaults { defaults in
            defaults.set(true, forKey: "didMigrateProvidersV1")
            defaults.set("https://api.openai.com/v1", forKey: ProviderMigration.legacyEndpointKey)

            let custom = ProviderProfile(
                id: "user-openai-proxy",
                displayName: "My OpenAI",
                endpoint: "https://api.openai.com/v1",
                model: "custom-model",
                isBuiltin: false,
                customModels: []
            )
            var providers = ProviderProfile.builtinPresets + [custom]
            var activeProviderID = custom.id

            ProviderMigration.runIfNeeded(
                providers: &providers,
                activeProviderID: &activeProviderID,
                defaults: defaults
            )

            XCTAssertEqual(activeProviderID, custom.id)
            XCTAssertEqual(providers.last, custom)
        }
    }

    func testMigrationTrimsWhitespaceAndDoesNotImportAnEmptyEndpoint() {
        let suiteName = "ProviderMigrationTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }

        defaults.set("   ", forKey: ProviderMigration.legacyEndpointKey)
        defaults.set("legacy-model", forKey: ProviderMigration.legacyModelKey)

        var providers = ProviderProfile.builtinPresets
        var activeProviderID = "deepseek"
        ProviderMigration.runIfNeeded(
            providers: &providers,
            activeProviderID: &activeProviderID,
            defaults: defaults
        )

        XCTAssertEqual(providers.count, ProviderProfile.builtinPresets.count)
        XCTAssertEqual(activeProviderID, "deepseek")
    }

    func testMigrationCompletionCanWaitForCallerPersistence() {
        withIsolatedDefaults { defaults in
            defaults.set("https://api.openai.com/v1", forKey: ProviderMigration.legacyEndpointKey)

            var providers = ProviderProfile.builtinPresets
            var activeProviderID = "deepseek"
            let didRun = ProviderMigration.runIfNeeded(
                providers: &providers,
                activeProviderID: &activeProviderID,
                defaults: defaults,
                markCompleted: false
            )

            XCTAssertTrue(didRun)
            XCTAssertFalse(defaults.bool(forKey: "didMigrateProvidersV1"))
            XCTAssertFalse(defaults.bool(forKey: "didMigrateProvidersV2"))

            ProviderMigration.markCompleted(defaults: defaults)
            XCTAssertTrue(defaults.bool(forKey: "didMigrateProvidersV1"))
            XCTAssertTrue(defaults.bool(forKey: "didMigrateProvidersV2"))
            XCTAssertFalse(
                ProviderMigration.runIfNeeded(
                    providers: &providers,
                    activeProviderID: &activeProviderID,
                    defaults: defaults
                )
            )
        }
    }

    private func withIsolatedDefaults(_ body: (UserDefaults) throws -> Void) rethrows {
        let suiteName = "ProviderMigrationTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }
        try body(defaults)
    }
}
