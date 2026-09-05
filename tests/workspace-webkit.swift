// Run with the isolated fixture server, never against the user's open app:
// node tests/workspace-browser-server.mjs
// swift tests/workspace-webkit.swift
import Cocoa
import WebKit

final class Results: NSObject, WKScriptMessageHandler {
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        let result = message.body as? [String: Any] ?? [:]
        print(result)
        exit((result["ok"] as? Bool) == true ? 0 : 1)
    }
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let config = WKWebViewConfiguration()
config.websiteDataStore = .nonPersistent()
let results = Results()
config.userContentController.add(results, name: "results")
let view = WKWebView(frame: NSRect(x: 0, y: 0, width: 1440, height: 900), configuration: config)
let window = NSWindow(contentRect: view.frame, styleMask: [.borderless], backing: .buffered, defer: false)
window.contentView = view
// Keep the test view laid out without replacing or interacting with CodePlus.
window.orderBack(nil)
view.load(URLRequest(url: URL(string: "http://127.0.0.1:4175/app?autorun")!))
DispatchQueue.main.asyncAfter(deadline: .now() + 30) { print("FAIL: WebKit fixture timed out"); exit(1) }
app.run()
