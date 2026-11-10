import AppKit
import CoreGraphics
import SystemConfiguration
import Darwin

// One bounded JSON request on stdin; stdout never contains paths or user data.
let protocolVersion = 1
let maxInput = 1024 * 1024

struct NativeFailure: Error {
    let code: String
    init(_ code: String) { self.code = code }
}

func emit(_ value: [String: Any], status: Int32 = 0) -> Never {
    var output = value
    output["protocol"] = protocolVersion
    let data = (try? JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])) ?? Data()
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
    exit(status)
}

func request() throws -> [String: Any] {
    var input = Data()
    while true {
        let chunk = FileHandle.standardInput.readData(ofLength: 16384)
        if chunk.isEmpty { break }
        input.append(chunk)
        if input.count > maxInput { throw NativeFailure("INVALID_FILES") }
    }
    guard let value = try? JSONSerialization.jsonObject(with: input) as? [String: Any],
          let version = value["protocol"] as? NSNumber,
          CFGetTypeID(version) != CFBooleanGetTypeID(), version.doubleValue == Double(protocolVersion),
          let operation = value["operation"] as? String,
          ["capabilities", "clipboard-version", "copy-files", "reveal-files"].contains(operation)
    else { throw NativeFailure("NATIVE_PROTOCOL_ERROR") }
    return value
}

func desktopSession() throws {
    let environment = ProcessInfo.processInfo.environment
    guard environment["MEDIA_CONTAINER"] != "1", environment["container"] == nil,
          environment["CONTAINER"] != "1",
          !FileManager.default.fileExists(atPath: "/.dockerenv"),
          !FileManager.default.fileExists(atPath: "/run/.containerenv")
    else { throw NativeFailure("DESKTOP_PLATFORM_UNAVAILABLE") }
    let uid = geteuid()
    var consoleUID: uid_t = 0
    var consoleGID: gid_t = 0
    guard uid > 0, getuid() == uid,
          SCDynamicStoreCopyConsoleUser(nil, &consoleUID, &consoleGID) != nil, consoleUID == uid,
          let session = CGSessionCopyCurrentDictionary() as? [String: Any],
          session[kCGSessionOnConsoleKey as String] as? Bool == true,
          session[kCGSessionLoginDoneKey as String] as? Bool == true,
          (session[kCGSessionUserIDKey as String] as? NSNumber)?.uint32Value == uid
    else { throw NativeFailure("DESKTOP_SESSION_UNAVAILABLE") }
}

func files(_ value: [String: Any]) throws -> [NSURL] {
    guard let paths = value["paths"] as? [String], paths.count <= 1000,
          paths.allSatisfy({ $0.hasPrefix("/") && !$0.utf8.contains(0) && $0.utf8.count <= 8192 })
    else { throw NativeFailure("INVALID_FILES") }
    guard !paths.isEmpty else { throw NativeFailure("EMPTY_FILES") }
    return try paths.map { file in
        let url = URL(fileURLWithPath: file, isDirectory: false)
        guard let attributes = try? url.resourceValues(forKeys: [.isRegularFileKey]),
              attributes.isRegularFile == true, FileManager.default.isReadableFile(atPath: file)
        else { throw NativeFailure("FILE_UNAVAILABLE") }
        return url as NSURL
    }
}

func changeCount(_ value: Any?) throws -> Int {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
          number.doubleValue.isFinite, number.doubleValue >= 0,
          number.doubleValue <= 9007199254740991,
          number.doubleValue.rounded(.towardZero) == number.doubleValue
    else { throw NativeFailure("INVALID_CHANGE_COUNT") }
    return number.intValue
}

do {
    let value = try request()
    try desktopSession()
    switch value["operation"] as! String {
    case "capabilities":
        // No NSPasteboard contents, Finder dispatch, file walk or compilation.
        emit(["ok": true, "clipboard": ["available": true], "revealMany": ["available": true]])
    case "clipboard-version":
        emit(["ok": true, "changeCount": NSPasteboard.general.changeCount])
    case "copy-files":
        let expected = try changeCount(value["expectedChangeCount"])
        let urls = try files(value)
        let pasteboard = NSPasteboard.general
        // All validation precedes clearContents. AppKit has no cross-process CAS;
        // keep the final version check immediately adjacent to the write.
        guard pasteboard.changeCount == expected else { throw NativeFailure("CLIPBOARD_CHANGED") }
        pasteboard.clearContents()
        guard pasteboard.writeObjects(urls) else { throw NativeFailure("CLIPBOARD_WRITE_FAILED") }
        emit(["ok": true, "ack": "written", "count": urls.count, "changeCount": pasteboard.changeCount])
    case "reveal-files":
        let urls = try files(value)
        NSWorkspace.shared.activateFileViewerSelecting(urls.map { $0 as URL })
        // This void API acknowledges dispatch, never observed Finder selection.
        emit(["ok": true, "ack": "dispatched", "count": urls.count])
    default:
        throw NativeFailure("NATIVE_PROTOCOL_ERROR")
    }
} catch let failure as NativeFailure {
    emit(["ok": false, "code": failure.code], status: 2)
} catch {
    emit(["ok": false, "code": "NATIVE_FAILED"], status: 2)
}
