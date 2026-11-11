import Foundation
import ImageIO
import Vision
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
          operation == "detect-face"
    else { throw NativeFailure("NATIVE_PROTOCOL_ERROR") }
    return value
}

// The caller provides one private, verified photo snapshot, never an API path.
func detectFace(_ value: [String: Any]) throws -> [String: Any] {
    guard let paths = value["paths"] as? [String], paths.count == 1, paths[0].hasPrefix("/"),
          paths[0].utf8.count <= 8192, !paths[0].utf8.contains(0)
    else { throw NativeFailure("INVALID_FILES") }
    let url = URL(fileURLWithPath: paths[0], isDirectory: false)
    guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
          let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
          let originalWidth = props[kCGImagePropertyPixelWidth] as? Int,
          let originalHeight = props[kCGImagePropertyPixelHeight] as? Int,
          originalWidth > 0, originalHeight > 0, originalWidth <= 60_000_000 / originalHeight
    else { return ["ok": true, "status": "unsupported"] }
    let orientation = props[kCGImagePropertyOrientation] as? Int ?? 1
    guard let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceThumbnailMaxPixelSize: 1600,
        kCGImageSourceShouldCacheImmediately: true
    ] as CFDictionary) else { return ["ok": true, "status": "unsupported"] }
    let rotates = (5...8).contains(orientation)
    let request = VNDetectFaceRectanglesRequest()
    try VNImageRequestHandler(cgImage: thumbnail, orientation: .up).perform([request])
    let observations = request.results ?? []
    guard observations.count <= 32 else { return ["ok": true, "status": "not_found"] }
    let faces: [[String: Any]] = observations.map { observation in
        let b = observation.boundingBox
        var result: [String: Any] = [
            "x": b.minX, "y": 1 - b.maxY, "w": b.width, "h": b.height,
            "confidence": observation.confidence
        ]
        if let yaw = observation.yaw, yaw.doubleValue.isFinite { result["yaw"] = yaw }
        return result
    }
    return ["ok": true, "status": "decoded", "faces": faces,
            "width": rotates ? originalHeight : originalWidth,
            "height": rotates ? originalWidth : originalHeight]
}

do {
    let value = try request()
    emit(try detectFace(value))
} catch let failure as NativeFailure {
    emit(["ok": false, "code": failure.code], status: 2)
} catch {
    emit(["ok": false, "code": "NATIVE_FAILED"], status: 2)
}
