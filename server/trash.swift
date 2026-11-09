import Foundation
import Darwin
import CryptoKit

struct BoundIdentity: Decodable {
    let dev: String, ino: String
    let size: Int64
    let mtimeMs: Double, ctimeMs: Double
}
struct ParentIdentity: Decodable {let dev: String, ino: String}
struct BoundTrash: Decodable {let identity: BoundIdentity, parent: ParentIdentity, sha256: String}
func failBound(_ text: String) -> NSError {NSError(domain:"BoundTrash",code:1,userInfo:[NSLocalizedDescriptionKey:text])}
func mtime(_ s: stat) -> Double {Double(s.st_mtimespec.tv_sec)*1000+Double(s.st_mtimespec.tv_nsec)/1_000_000}
func ctime(_ s: stat) -> Double {Double(s.st_ctimespec.tv_sec)*1000+Double(s.st_ctimespec.tv_nsec)/1_000_000}
func identityMatches(_ s: stat, _ e: BoundIdentity, includeCTime: Bool=true) -> Bool {
    (s.st_mode & S_IFMT) == S_IFREG && String(s.st_dev)==e.dev && String(s.st_ino)==e.ino &&
    s.st_size==e.size && abs(mtime(s)-e.mtimeMs)<0.001 && (!includeCTime || abs(ctime(s)-e.ctimeMs)<0.001)
}
func current(_ fd:Int32) throws -> stat {var s=stat();guard fstat(fd,&s)==0 else {throw failBound("无法核对原文件身份")};return s}
func at(_ directory:Int32,_ name:String) throws -> stat {
    var s=stat();guard fstatat(directory,name,&s,AT_SYMLINK_NOFOLLOW)==0 else {throw failBound("原文件位置已变化")};return s
}

func sameNode(_ a: stat, _ b: stat) -> Bool {
    a.st_dev == b.st_dev && a.st_ino == b.st_ino && (a.st_mode & S_IFMT) == (b.st_mode & S_IFMT)
}
func stable(_ a: stat, _ b: stat) -> Bool {
    sameNode(a,b) && a.st_size == b.st_size && a.st_mtimespec.tv_sec == b.st_mtimespec.tv_sec &&
    a.st_mtimespec.tv_nsec == b.st_mtimespec.tv_nsec && a.st_ctimespec.tv_sec == b.st_ctimespec.tv_sec &&
    a.st_ctimespec.tv_nsec == b.st_ctimespec.tv_nsec
}
func descriptorPath(_ fd: Int32) -> String? {
    var buffer = [CChar](repeating:0,count:Int(MAXPATHLEN))
    let result = buffer.withUnsafeMutableBytes {fcntl(fd,F_GETPATH,$0.baseAddress!)}
    return result == 0 ? String(cString:buffer) : nil
}
func canonicalPath(_ file: String) -> String? {
    guard let resolved = realpath(file,nil) else {return nil}
    defer {free(resolved)}
    return String(cString:resolved)
}
func heldHash(_ fd: Int32, _ size: Int64) throws -> String {
    var hash = SHA256(), buffer = [UInt8](repeating:0,count:1024*1024), remaining = size
    // A concurrently growing file must not make this read unbounded.
    while remaining > 0 {
        let count = Int(min(remaining,Int64(buffer.count)))
        let n = buffer.withUnsafeMutableBytes {Darwin.read(fd,$0.baseAddress,count)}
        if n < 0 {if errno == EINTR {continue}; throw failBound("无法完成原件内容核验")}
        if n == 0 {throw failBound("原件长度发生变化，未送入废纸篓")}
        hash.update(data:Data(buffer.prefix(n))); remaining -= Int64(n)
    }
    return hash.finalize().map({String(format:"%02x",$0)}).joined()
}

// The bound protocol claims through directory FDs before using a private pathname.
// A substituted original entry is never sent to Trash; rollback never overwrites.
func boundTrash(_ file:String,_ expected:BoundTrash) throws -> String {
    let digest = expected.sha256.lowercased()
    guard digest.utf8.count == 64, digest.utf8.allSatisfy({(48...57).contains($0) || (97...102).contains($0)}),
          expected.identity.size > 0, expected.identity.mtimeMs.isFinite, expected.identity.ctimeMs.isFinite,
          file.hasPrefix("/"), !file.utf8.contains(0) else {throw failBound("移动校验参数无效")}
    let url = URL(fileURLWithPath:file), parent = url.deletingLastPathComponent().path, name = url.lastPathComponent
    guard canonicalPath(file) == file, !name.isEmpty, name != ".", name != ".." else {throw failBound("原文件路径已变化，未移除")}
    let parentFD = open(parent,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC)
    guard parentFD >= 0 else {throw failBound("原文件夹不可用，未移除")}
    defer {close(parentFD)}
    let ps = try current(parentFD)
    guard String(ps.st_dev) == expected.parent.dev, String(ps.st_ino) == expected.parent.ino,
          identityMatches(try at(parentFD,name),expected.identity) else {throw failBound("原件或文件夹已变化，未移除")}
    let originalFD = openat(parentFD,name,O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC)
    guard originalFD >= 0 else {throw failBound("无法打开原件，未移除")}
    defer {close(originalFD)}
    guard identityMatches(try current(originalFD),expected.identity) else {throw failBound("原件已被替换，未移除")}
    let claimName = ".shiguang-intake-" + UUID().uuidString
    guard mkdirat(parentFD,claimName,0o700) == 0 else {throw failBound("无法安全暂存原件，原位置保留")}
    let created = try at(parentFD,claimName), claimFD = openat(parentFD,claimName,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC)
    guard claimFD >= 0 else {
        if let named = try? at(parentFD,claimName), sameNode(named,created) {unlinkat(parentFD,claimName,AT_REMOVEDIR)}
        throw failBound("暂存位置无法打开，原件未领取；位置：" + parent + "/" + claimName)
    }
    defer {close(claimFD)}
    let claimIdentity = try current(claimFD)
    var claimed = false, trashSucceeded = false, claimedIdentity: stat?
    func claimPath() -> String {(descriptorPath(claimFD) ?? parent + "/" + claimName) + "/" + name}
    func removeEmptyClaim() {
        if let named = try? at(parentFD,claimName), sameNode(named,claimIdentity) {unlinkat(parentFD,claimName,AT_REMOVEDIR)}
    }
    do {
        guard sameNode(created,claimIdentity), claimIdentity.st_uid == getuid(), claimIdentity.st_mode & 0o777 == 0o700 else {throw failBound("暂存目录身份或权限变化，原件未领取")}
        guard identityMatches(try at(parentFD,name),expected.identity) else {throw failBound("原件位置变化，未移除")}
        guard renameatx_np(parentFD,name,claimFD,name,UInt32(RENAME_EXCL)) == 0 else {throw failBound("原件位置变化，未移除")}
        claimed = true
        let claimedStat = try at(claimFD,name); claimedIdentity = claimedStat
        let held = try current(originalFD)
        // Claiming changes ctime itself; all other registered identity fields still match.
        guard identityMatches(claimedStat,expected.identity,includeCTime:false), stable(claimedStat,held) else {throw failBound("原路径被替换，未送入废纸篓")}
        let hash = try heldHash(originalFD,expected.identity.size)
        let after = try current(originalFD), pathStat = try at(claimFD,name)
        guard identityMatches(after,expected.identity,includeCTime:false), stable(claimedStat,after), stable(pathStat,after),
              hash == digest else {throw failBound("原件内容发生变化，未送入废纸篓")}
        // Check both names and held descriptors again at the private-path boundary.
        var parentNow = stat(), privateNow = stat()
        guard lstat(parent,&parentNow) == 0, sameNode(parentNow,ps),
              sameNode(try at(parentFD,claimName),claimIdentity),
              (try current(claimFD)).st_mode & 0o777 == 0o700,
              lstat(claimPath(),&privateNow) == 0, stable(privateNow,after), stable(try current(originalFD),after) else {throw failBound("领取位置或原件已变化，未送入废纸篓")}
        var resulting: NSURL?
        try FileManager.default.trashItem(at:URL(fileURLWithPath:claimPath()),resultingItemURL:&resulting)
        trashSucceeded = true
        // If Foundation reports no destination after moving, never invent a recovery path.
        guard let result = resulting?.path else {throw failBound("UNKNOWN：FileManager 已返回成功但缺少废纸篓结果路径；未执行恢复；原领取位置：" + claimPath())}
        var destination = stat()
        guard lstat(result,&destination) == 0, identityMatches(destination,expected.identity,includeCTime:false),
              stable(destination,try current(originalFD)) else {throw failBound("废纸篓结果身份待核对；返回位置：" + result)}
        claimed = false; removeEmptyClaim(); return result
    } catch {
        if trashSucceeded {
            removeEmptyClaim()
            throw failBound("UNKNOWN：废纸篓操作已返回成功，未执行恢复；" + error.localizedDescription)
        }
        if claimed {
            let retained = claimPath()
            guard let owned = claimedIdentity, let named = try? at(claimFD,name), sameNode(named,owned) else {
                throw failBound("UNKNOWN：领取位置已变化，未恢复或重复移除；原领取位置：" + retained + "；" + error.localizedDescription)
            }
            // RENAME_EXCL keeps any newly created original-path entry intact.
            if renameatx_np(claimFD,name,parentFD,name,UInt32(RENAME_EXCL)) != 0 {
                throw failBound("恢复原位置受阻，未覆盖现有文件；文件保留在：" + retained + "；" + error.localizedDescription)
            }
            removeEmptyClaim()
            throw failBound(error.localizedDescription + "；已恢复到：" + (descriptorPath(parentFD) ?? parent) + "/" + name)
        }
        removeEmptyClaim(); throw error
    }
}

do {
    guard [2,3].contains(CommandLine.arguments.count) else { throw NSError(domain: "Trash", code: 1) }
    if CommandLine.arguments.count==3 {
        let expected=try JSONDecoder().decode(BoundTrash.self,from:Data(CommandLine.arguments[2].utf8))
        let destination=try boundTrash(CommandLine.arguments[1],expected)
        print(String(data:try JSONEncoder().encode(destination),encoding:.utf8)!)
        exit(0)
    }
    var resulting: NSURL?
    try FileManager.default.trashItem(at: URL(fileURLWithPath: CommandLine.arguments[1]), resultingItemURL: &resulting)
    guard let destination = resulting else { throw NSError(domain: "Trash", code: 2) }
    let data = try JSONEncoder().encode(destination.path!)
    print(String(data: data, encoding: .utf8)!)
} catch {
    fputs("\(error)\n", stderr)
    exit(1)
}
