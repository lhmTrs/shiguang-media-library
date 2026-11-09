import Cocoa
import WebKit

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let args = CommandLine.arguments

final class IntakePrompt: NSObject, NSWindowDelegate {
    var window: NSWindow!
    let handoffId: String?
    var answered = false
    init(handoffId: String?, message: String) {
        self.handoffId = handoffId
        super.init()
        window = NSWindow(contentRect:NSRect(x:0,y:0,width:520,height:230),
                          styleMask:[.titled,.closable],backing:.buffered,defer:false)
        window.title = handoffId == nil ? "尚未开始收纳" : "启动拾光"
        window.delegate = self
        window.isReleasedWhenClosed = false
        let content = NSStackView()
        content.orientation = .vertical
        content.alignment = .leading
        content.spacing = 18
        content.translatesAutoresizingMaskIntoConstraints = false
        let title = NSTextField(labelWithString:handoffId == nil ? "尚未开始收纳" : "拾光尚未启动")
        title.font = .boldSystemFont(ofSize:20)
        let body = NSTextField(wrappingLabelWithString:message)
        body.font = .systemFont(ofSize:13)
        body.maximumNumberOfLines = 4
        body.lineBreakMode = .byTruncatingTail
        body.toolTip = message
        let actions = NSStackView()
        actions.orientation = .horizontal
        actions.spacing = 10
        let cancel = NSButton(title:handoffId == nil ? "知道了" : "取消",target:self,action:#selector(cancelled))
        cancel.bezelStyle = .rounded
        cancel.keyEquivalent = "\u{1b}"
        actions.addArrangedSubview(cancel)
        if handoffId != nil {
            let start = NSButton(title:"启动拾光并继续",target:self,action:#selector(started))
            start.bezelStyle = .rounded
            // A stray Return while this window appears must not consent to start.
            actions.addArrangedSubview(start)
        }
        for view in [title,body,actions] {content.addArrangedSubview(view)}
        window.contentView!.addSubview(content)
        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo:window.contentView!.leadingAnchor,constant:24),
            content.trailingAnchor.constraint(equalTo:window.contentView!.trailingAnchor,constant:-24),
            content.topAnchor.constraint(equalTo:window.contentView!.topAnchor,constant:24),
            content.bottomAnchor.constraint(lessThanOrEqualTo:window.contentView!.bottomAnchor,constant:-24),
            body.widthAnchor.constraint(equalTo:content.widthAnchor)
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
    let prompt = IntakePrompt(handoffId:args[2],message:"本次选择已保留。启动本机素材服务后继续选择项目与文件夹，不会自动导入。")
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
    var window: NSWindow!
    var view: WKWebView!
    let origin: URL
    init(_ url: URL) {
        origin = URL(string:"http://127.0.0.1:\(url.port!)/")!
        super.init()
        let config = WKWebViewConfiguration()
        config.userContentController.add(self,name:"intake")
        view = WKWebView(frame:.zero,configuration:config)
        view.navigationDelegate = self
        window = NSWindow(contentRect:NSRect(x:0,y:0,width:760,height:690),
                          styleMask:[.titled,.closable,.resizable,.miniaturizable],backing:.buffered,defer:false)
        window.title = "收纳视频到拾光"
        window.minSize = NSSize(width:600,height:560)
        window.delegate = self
        window.contentView = view
        window.center()
        window.makeKeyAndOrderFront(nil)
        app.activate(ignoringOtherApps:true)
        view.load(URLRequest(url:url))
    }
    func windowWillClose(_ notification:Notification) {app.terminate(nil)}
    func userContentController(_ controller:WKUserContentController,didReceive message:WKScriptMessage) {
        guard message.frameInfo.isMainFrame,
              message.frameInfo.securityOrigin.host == "127.0.0.1",
              message.frameInfo.securityOrigin.port == origin.port,
              let text = message.body as? String else {return}
        if text == "accepted" || text == "cancel" {window.close()}
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
