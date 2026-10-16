import Foundation

do {
    guard CommandLine.arguments.count == 2 else { throw NSError(domain: "Trash", code: 1) }
    var resulting: NSURL?
    try FileManager.default.trashItem(at: URL(fileURLWithPath: CommandLine.arguments[1]), resultingItemURL: &resulting)
    guard let destination = resulting else { throw NSError(domain: "Trash", code: 2) }
    let data = try JSONEncoder().encode(destination.path!)
    print(String(data: data, encoding: .utf8)!)
} catch {
    fputs("\(error)\n", stderr)
    exit(1)
}
