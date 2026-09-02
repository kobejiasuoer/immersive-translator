import Darwin
import Foundation

/// Serializes private diagnostic output for both the app target and ProviderCore.
public enum DiagnosticLogger {
    private static let queue = DispatchQueue(label: "local.immersive-translator.diagnostic-logger")
    private static let privateLogPermissions: mode_t = 0o600

    // One current file plus one rotated file keeps total storage near 2 MiB.
    static let maxLogBytes = 1_048_576

    public static func log(_ message: String) {
        let timestamp = ISO8601DateFormatter().string(from: Date())
        let line = "[\(timestamp)] \(message)\n"

        queue.async {
            do {
                guard let data = line.data(using: .utf8) else { return }
                try append(data, to: logFileURL())
            } catch {
                NSLog("Failed to write diagnostic log: \(error.localizedDescription)")
            }
        }
    }

    public static func logFileURL() -> URL {
        let baseURL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser
        return baseURL
            .appendingPathComponent("ImmersiveTranslator", isDirectory: true)
            .appendingPathComponent("diagnostic.log")
    }

    /// Appends bytes synchronously. Internal visibility lets ProviderCore tests
    /// exercise file-system boundaries without waiting for the logging queue.
    static func append(_ data: Data, to url: URL) throws {
        guard !data.isEmpty else { return }
        let filename = url.lastPathComponent
        guard !filename.isEmpty, filename != ".", filename != "..", !filename.contains("/") else {
            throw fileTypeError(path: url.path, expected: "log filename")
        }

        let directoryDescriptor = try openDirectory(url.deletingLastPathComponent())
        defer { close(directoryDescriptor) }

        let dataToWrite = data.count > maxLogBytes
            ? Data(data.suffix(maxLogBytes))
            : data
        try appendData(dataToWrite, named: filename, directoryDescriptor: directoryDescriptor)
    }

    private static func openDirectory(_ url: URL) throws -> Int32 {
        try FileManager.default.createDirectory(
            at: url,
            withIntermediateDirectories: true,
            attributes: nil
        )

        let flags = O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK
        let descriptor = open(url.path, flags)
        guard descriptor >= 0 else {
            throw posixError(path: url.path)
        }

        var status = stat()
        guard fstat(descriptor, &status) == 0 else {
            let error = posixError(path: url.path)
            close(descriptor)
            throw error
        }
        guard (status.st_mode & S_IFMT) == S_IFDIR else {
            close(descriptor)
            throw fileTypeError(path: url.path, expected: "directory")
        }
        return descriptor
    }

    private static func appendData(
        _ data: Data,
        named filename: String,
        directoryDescriptor: Int32
    ) throws {
        let flags = O_RDWR | O_APPEND | O_CREAT | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK
        let descriptor = openat(directoryDescriptor, filename, flags, privateLogPermissions)
        guard descriptor >= 0 else {
            throw posixError(path: filename)
        }
        defer { close(descriptor) }

        var status = stat()
        guard fstat(descriptor, &status) == 0 else {
            throw posixError(path: filename)
        }
        try validateRegularFile(status, path: filename)
        guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
            throw posixError(path: filename)
        }
        defer { flock(descriptor, LOCK_UN) }
        guard fstat(descriptor, &status) == 0 else {
            throw posixError(path: filename)
        }
        try validateRegularFile(status, path: filename)
        guard fchmod(descriptor, privateLogPermissions) == 0 else {
            throw posixError(path: filename)
        }

        let currentBytes = Int64(status.st_size)
        let allowedIncomingBytes = Int64(maxLogBytes - data.count)
        if currentBytes > allowedIncomingBytes {
            let tail = try readTail(from: descriptor, size: currentBytes, path: filename)
            try writeReplacement(
                tail,
                named: "\(filename).1",
                directoryDescriptor: directoryDescriptor
            )
            guard ftruncate(descriptor, 0) == 0 else {
                throw posixError(path: filename)
            }
        }

        // Revalidate after rotation and immediately before writing. Holding the
        // descriptor and advisory lock avoids unlink/reopen races between app processes.
        guard fstat(descriptor, &status) == 0 else {
            throw posixError(path: filename)
        }
        try validateRegularFile(status, path: filename)
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: false)
        try handle.write(contentsOf: data)
    }

    private static func readTail(from descriptor: Int32, size: Int64, path: String) throws -> Data {
        let tailBytes = min(size, Int64(maxLogBytes))
        let startOffset = size - tailBytes
        guard lseek(descriptor, off_t(startOffset), SEEK_SET) >= 0 else {
            throw posixError(path: path)
        }

        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: false)
        var result = Data()
        while result.count < Int(tailBytes) {
            let remaining = Int(tailBytes) - result.count
            guard let chunk = try handle.read(upToCount: remaining), !chunk.isEmpty else { break }
            result.append(chunk)
        }
        return result
    }

    private static func writeReplacement(
        _ data: Data,
        named filename: String,
        directoryDescriptor: Int32
    ) throws {
        // Avoid O_TRUNC until fstat has rejected symlinks, FIFOs, devices, and hard links.
        let flags = O_WRONLY | O_CREAT | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK
        let descriptor = openat(directoryDescriptor, filename, flags, privateLogPermissions)
        guard descriptor >= 0 else {
            throw posixError(path: filename)
        }
        defer { close(descriptor) }

        var status = stat()
        guard fstat(descriptor, &status) == 0 else {
            throw posixError(path: filename)
        }
        try validateRegularFile(status, path: filename)
        guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
            throw posixError(path: filename)
        }
        defer { flock(descriptor, LOCK_UN) }
        guard fstat(descriptor, &status) == 0 else {
            throw posixError(path: filename)
        }
        try validateRegularFile(status, path: filename)
        guard ftruncate(descriptor, 0) == 0 else {
            throw posixError(path: filename)
        }
        guard fchmod(descriptor, privateLogPermissions) == 0 else {
            throw posixError(path: filename)
        }

        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: false)
        try handle.write(contentsOf: data)
    }

    private static func validateRegularFile(_ status: stat, path: String) throws {
        guard (status.st_mode & S_IFMT) == S_IFREG else {
            throw fileTypeError(path: path, expected: "regular file")
        }
        guard status.st_uid == geteuid() else {
            throw NSError(
                domain: NSPOSIXErrorDomain,
                code: Int(EPERM),
                userInfo: [NSFilePathErrorKey: path, NSLocalizedDescriptionKey: "diagnostic log is not owned by the current user"]
            )
        }
        guard status.st_nlink == 1 else {
            throw NSError(
                domain: NSPOSIXErrorDomain,
                code: Int(EPERM),
                userInfo: [NSFilePathErrorKey: path, NSLocalizedDescriptionKey: "diagnostic log must have exactly one hard link"]
            )
        }
    }

    private static func posixError(path: String) -> NSError {
        NSError(
            domain: NSPOSIXErrorDomain,
            code: Int(errno),
            userInfo: [NSFilePathErrorKey: path]
        )
    }

    private static func fileTypeError(path: String, expected: String) -> NSError {
        NSError(
            domain: NSPOSIXErrorDomain,
            code: Int(EFTYPE),
            userInfo: [
                NSFilePathErrorKey: path,
                NSLocalizedDescriptionKey: "expected a \(expected) at \(path)"
            ]
        )
    }
}
