import Cocoa
import WebKit

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let args = CommandLine.arguments

// The page reports its theme after rendering; the shell remembers it so the next
// window (or a start/error prompt) opens in the same colours without a white flash.
enum Look {
    static let darkKey = "intake.appearance.dark", backgroundKey = "intake.appearance.background"
    static func color(_ hex: String) -> NSColor? {
        guard hex.count == 7, hex.hasPrefix("#"), let v = UInt32(hex.dropFirst(), radix: 16) else {return nil}
        return NSColor(srgbRed: CGFloat((v >> 16) & 255) / 255, green: CGFloat((v >> 8) & 255) / 255, blue: CGFloat(v & 255) / 255, alpha: 1)
    }
    static func apply(_ window: NSWindow) {
        let d = UserDefaults.standard
        guard d.object(forKey: darkKey) != nil else {return}
        window.appearance = NSAppearance(named: d.bool(forKey: darkKey) ? .darkAqua : .aqua)
        if let bg = d.string(forKey: backgroundKey).flatMap(color) {window.backgroundColor = bg}
    }
    static func remember(_ message: String, _ window: NSWindow) {
        let parts = message.split(separator: ":", maxSplits: 1).map(String.init)
        guard let mode = parts.first, mode == "dark" || mode == "light" else {return}
        let d = UserDefaults.standard
        d.set(mode == "dark", forKey: darkKey)
        if parts.count == 2, color(parts[1]) != nil {d.set(parts[1], forKey: backgroundKey)} else {d.removeObject(forKey: backgroundKey)}
        apply(window)
    }
}

/// A transparent strip over the page header: dragging it moves the window, a double click zooms.
/// The header has no controls of its own, so nothing interactive sits underneath.
final class DragStrip: NSView {
    override var mouseDownCanMoveWindow: Bool {true}
    override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2 {window?.performZoom(nil)} else {window?.performDrag(with: event)}
    }
}

/// Plain title area: traffic lights float over content, the window title stays for Mission Control.
func blendTitlebar(_ window: NSWindow) {
    window.titlebarAppearsTransparent = true
    window.titleVisibility = .hidden
    window.styleMask.insert(.fullSizeContentView)
}

final class IntakePrompt: NSObject, NSWindowDelegate {
    var window: NSWindow!
    let handoffId: String?
    var answered = false
    init(handoffId: String?, message: String) {
        self.handoffId = handoffId
        super.init()
        window = NSWindow(contentRect:NSRect(x:0,y:0,width:440,height:180),
                          styleMask:[.titled,.closable],backing:.buffered,defer:false)
        window.title = handoffId == nil ? "尚未开始收纳" : "启动拾光"
        blendTitlebar(window)
        Look.apply(window)
        window.delegate = self
        window.isReleasedWhenClosed = false
        // Same family as the intake window: icon tile, one strong sentence, quieter detail, buttons bottom-right.
        let symbol = NSImage(systemSymbolName: handoffId == nil ? "exclamationmark.circle" : "folder.badge.plus", accessibilityDescription: nil)
        let icon = NSImageView(image: symbol ?? NSImage())
        icon.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 22, weight: .regular)
        icon.contentTintColor = handoffId == nil ? .systemRed : .systemGreen
        icon.translatesAutoresizingMaskIntoConstraints = false
        let title = NSTextField(labelWithString:handoffId == nil ? "这次没有开始收纳" : "拾光还没启动")
        title.font = .systemFont(ofSize:15, weight:.semibold)
        let body = NSTextField(wrappingLabelWithString:message)
        body.font = .systemFont(ofSize:12)
        body.textColor = .secondaryLabelColor
        body.maximumNumberOfLines = 4
        body.lineBreakMode = .byTruncatingTail
        body.toolTip = message
        let actions = NSStackView()
        actions.orientation = .horizontal
        actions.spacing = 8
        let cancel = NSButton(title:handoffId == nil ? "知道了" : "取消",target:self,action:#selector(cancelled))
        cancel.bezelStyle = .rounded
        cancel.keyEquivalent = "\u{1b}"
        actions.addArrangedSubview(cancel)
        if handoffId != nil {
            let start = NSButton(title:"启动拾光并继续",target:self,action:#selector(started))
            start.bezelStyle = .rounded
            start.bezelColor = .controlAccentColor
            // A stray Return while this window appears must not consent to start.
            actions.addArrangedSubview(start)
        }
        let text = NSStackView(views:[title,body])
        text.orientation = .vertical
        text.alignment = .leading
        text.spacing = 6
        let row = NSStackView(views:[icon,text])
        row.orientation = .horizontal
        row.alignment = .top
        row.spacing = 14
        let content = NSStackView(views:[row,actions])
        content.orientation = .vertical
        content.alignment = .trailing
        content.spacing = 18
        content.translatesAutoresizingMaskIntoConstraints = false
        window.contentView!.addSubview(content)
        NSLayoutConstraint.activate([
            icon.widthAnchor.constraint(equalToConstant:30),
            content.leadingAnchor.constraint(equalTo:window.contentView!.leadingAnchor,constant:24),
            content.trailingAnchor.constraint(equalTo:window.contentView!.trailingAnchor,constant:-24),
            content.topAnchor.constraint(equalTo:window.contentView!.topAnchor,constant:40),
            content.bottomAnchor.constraint(lessThanOrEqualTo:window.contentView!.bottomAnchor,constant:-20),
            row.widthAnchor.constraint(equalTo:content.widthAnchor),
            body.widthAnchor.constraint(lessThanOrEqualToConstant:340)
        ])
        window.initialFirstResponder = cancel
        window.center()
        window.makeKeyAndOrderFront(nil)
        app.activate(ignoringOtherApps:true)
    }
    @objc func started() {
        guard !answered, let id = handoffId else {return}
        answered = true
        guard let data = try? JSONSerialization.data(withJSONObject:["action":"start","handoffId":id]) else {exit(1)}
        FileHandle.standardOutput.write(data)
        exit(0)
    }
    @objc func cancelled() {guard !answered else {return};answered = true;exit(handoffId == nil ? 1 : 2)}
    func windowWillClose(_ notification:Notification) {cancelled()}
}
if args.count >= 2 && args[1] == "--start-alert" {
    guard args.count == 3, UUID(uuidString:args[2]) != nil else {exit(2)}
    let prompt = IntakePrompt(handoffId:args[2],message:"你选的文件已经记下。启动后会打开收纳窗口，由你确认去向，不会自动导入。")
    app.run()
    withExtendedLifetime(prompt) {}
    exit(2)
}
if args.count >= 3 && args[1] == "--error" {
    let prompt = IntakePrompt(handoffId:nil,message:args[2])
    app.run()
    withExtendedLifetime(prompt) {}
    exit(1)
}
guard args.count == 3, args[1] == "--url", let url = URL(string:args[2]),
      url.scheme == "http", url.host == "127.0.0.1", url.port != nil,
      url.path == "/", url.user == nil, url.password == nil, url.query == nil,
      let fragment = url.fragment, fragment.hasPrefix("/file-intake/"),
      UUID(uuidString:String(fragment.dropFirst("/file-intake/".count))) != nil else {exit(2)}

final class IntakeWindow: NSObject, NSWindowDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    static let frameName = "ShiguangIntakeWindow"
    static let headerHeight: CGFloat = 52
    static let closeDelay: TimeInterval = 3
    var window: NSWindow!
    var view: WKWebView!
    var closing = false
    let origin: URL
    init(_ url: URL) {
        origin = URL(string:"http://127.0.0.1:\(url.port!)/")!
        super.init()
        let config = WKWebViewConfiguration()
        config.userContentController.add(self,name:"intake")
        config.userContentController.add(self,name:"intakeAppearance")
        view = WKWebView(frame:.zero,configuration:config)
        view.navigationDelegate = self
        // Let the window colour show until the page paints, instead of a white flash.
        view.setValue(false, forKey:"drawsBackground")
        window = NSWindow(contentRect:NSRect(x:0,y:0,width:760,height:690),
                          styleMask:[.titled,.closable,.resizable,.miniaturizable],backing:.buffered,defer:false)
        window.title = "收纳素材到拾光"
        blendTitlebar(window)
        // An empty unified toolbar makes the title area 52pt tall, matching the page header,
        // so the traffic lights sit centred on the same line as the page title.
        let toolbar = NSToolbar(identifier:"ShiguangIntakeToolbar")
        window.toolbar = toolbar
        window.toolbarStyle = .unified
        window.titlebarSeparatorStyle = .none
        window.minSize = NSSize(width:600,height:560)
        Look.apply(window)
        window.delegate = self
        let content = NSView()
        view.translatesAutoresizingMaskIntoConstraints = false
        let strip = DragStrip()
        strip.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(view)
        content.addSubview(strip)
        NSLayoutConstraint.activate([
            view.leadingAnchor.constraint(equalTo:content.leadingAnchor),
            view.trailingAnchor.constraint(equalTo:content.trailingAnchor),
            view.topAnchor.constraint(equalTo:content.topAnchor),
            view.bottomAnchor.constraint(equalTo:content.bottomAnchor),
            strip.leadingAnchor.constraint(equalTo:content.leadingAnchor),
            strip.trailingAnchor.constraint(equalTo:content.trailingAnchor),
            strip.topAnchor.constraint(equalTo:content.topAnchor),
            strip.heightAnchor.constraint(equalToConstant:IntakeWindow.headerHeight)
        ])
        window.contentView = content
        if !window.setFrameUsingName(IntakeWindow.frameName) {window.center()}
        window.setFrameAutosaveName(IntakeWindow.frameName)
        window.makeKeyAndOrderFront(nil)
        app.activate(ignoringOtherApps:true)
        view.load(URLRequest(url:url))
    }
    func windowWillClose(_ notification:Notification) {app.terminate(nil)}
    func userContentController(_ controller:WKUserContentController,didReceive message:WKScriptMessage) {
        guard message.frameInfo.isMainFrame,
              message.frameInfo.securityOrigin.host == "127.0.0.1",
              message.frameInfo.securityOrigin.port == origin.port,
              let text = message.body as? String, text.count <= 64 else {return}
        if message.name == "intakeAppearance" {Look.remember(text, window);return}
        // A durable receipt leaves the summary readable for a moment; an explicit close is immediate.
        if text == "accepted" {
            guard !closing else {return}
            closing = true
            DispatchQueue.main.asyncAfter(deadline:.now() + IntakeWindow.closeDelay) {[weak self] in self?.window.close()}
        } else if text == "close" || text == "cancel" {window.close()}
    }
    func webView(_ webView:WKWebView,decidePolicyFor action:WKNavigationAction,
                 decisionHandler:@escaping(WKNavigationActionPolicy)->Void) {
        guard let target=action.request.url,target.scheme == origin.scheme,target.host == origin.host,
              target.port == origin.port else {decisionHandler(.cancel);return}
        if action.targetFrame == nil {
            if target.path == "/" {NSWorkspace.shared.open(target)}
            decisionHandler(.cancel)
        } else {decisionHandler(.allow)}
    }
}
let controller = IntakeWindow(url)
app.run()
