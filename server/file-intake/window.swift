import Cocoa
import WebKit

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let args = CommandLine.arguments
func presentAfterLaunch(_ alert: NSAlert, result: @escaping (NSApplication.ModalResponse) -> Int32) -> Never {
    // NSApplication.run completes launch before dispatching the queued dialog.
    // The service-off/error branches need the same lifecycle as the WK window.
    DispatchQueue.main.async {
        app.activate(ignoringOtherApps:true)
        exit(result(alert.runModal()))
    }
    app.run()
    exit(2)
}
if args.count >= 2 && args[1] == "--start-alert" {
    let alert = NSAlert()
    alert.messageText = "拾光尚未启动"
    alert.informativeText = "本次选择已保留。启动本机素材服务后继续选择项目与文件夹，不会自动导入。"
    alert.addButton(withTitle: "启动拾光并继续")
    alert.addButton(withTitle: "取消")
    presentAfterLaunch(alert) {$0 == .alertFirstButtonReturn ? 0 : 2}
}
if args.count >= 3 && args[1] == "--error" {
    let alert = NSAlert()
    alert.alertStyle = .warning
    alert.messageText = "尚未开始收纳"
    alert.informativeText = args[2]
    alert.addButton(withTitle: "知道了")
    presentAfterLaunch(alert) {_ in 1}
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
