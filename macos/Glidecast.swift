// Glidecast.app: a native window around the Glidecast editor.
// Starts `node server.js` from the project folder (unless a server is already running on the
// port), shows the editor in a WKWebView, and stops the server when the app quits.

import Cocoa
import WebKit

let port = 4321
let editorURL = URL(string: "http://127.0.0.1:\(port)/")!
let logURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Glidecast.log")

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
  var window: NSWindow!
  var webView: WKWebView!
  var server: Process?

  // MARK: Lifecycle

  func applicationDidFinishLaunching(_ note: Notification) {
    buildMenu()

    let config = WKWebViewConfiguration()
    config.preferences.setValue(true, forKey: "developerExtrasEnabled")
    config.mediaTypesRequiringUserActionForPlayback = []
    webView = WKWebView(frame: .zero, configuration: config)
    webView.navigationDelegate = self
    webView.uiDelegate = self
    webView.setValue(false, forKey: "drawsBackground")

    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1600, height: 1000),
      styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    window.title = "Glidecast"
    window.minSize = NSSize(width: 1100, height: 700)
    window.backgroundColor = NSColor(red: 0.05, green: 0.055, blue: 0.063, alpha: 1)
    window.appearance = NSAppearance(named: .darkAqua)
    window.contentView = webView
    window.setFrameAutosaveName("GlidecastMain")
    if !window.setFrameUsingName("GlidecastMain") { window.center() }
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)

    showStatus("Starting Glidecast…")
    startServer()
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

  func applicationWillTerminate(_ note: Notification) {
    guard let server, server.isRunning else { return }
    server.terminate()  // SIGTERM: server.js cancels any render and closes Chromium
    let deadline = Date().addingTimeInterval(3)
    while server.isRunning && Date() < deadline { usleep(50_000) }
    if server.isRunning { kill(server.processIdentifier, SIGKILL) }
  }

  // MARK: Server

  var projectDir: URL {
    let home = Bundle.main.object(forInfoDictionaryKey: "GlidecastHome") as? String ?? "~/Glidecast"
    return URL(fileURLWithPath: (home as NSString).expandingTildeInPath)
  }

  func startServer() {
    isServerUp { up in
      if up { self.webView.load(URLRequest(url: editorURL)); return }

      let serverJS = self.projectDir.appendingPathComponent("server.js")
      guard FileManager.default.fileExists(atPath: serverJS.path) else {
        return self.showError("Couldn't find the Glidecast project at \(self.projectDir.path).",
          detail: "Rebuild the app with macos/build.sh from the project folder, or set GlidecastHome in Info.plist.")
      }
      guard let node = self.findExecutable("node") else {
        return self.showError("Node.js wasn't found.", detail: "Install it (e.g. brew install node) and reopen Glidecast.")
      }

      let p = Process()
      p.executableURL = URL(fileURLWithPath: node)
      p.arguments = [serverJS.path]
      p.currentDirectoryURL = self.projectDir
      var env = ProcessInfo.processInfo.environment
      // Apps launched from Finder get a minimal PATH; the recorder needs node and ffmpeg.
      let extra = ["/opt/homebrew/bin", "/usr/local/bin", (node as NSString).deletingLastPathComponent]
      env["PATH"] = (extra + [env["PATH"] ?? "/usr/bin:/bin"]).joined(separator: ":")
      env["PORT"] = String(port)
      p.environment = env

      FileManager.default.createFile(atPath: logURL.path, contents: nil)
      if let log = try? FileHandle(forWritingTo: logURL) {
        p.standardOutput = log
        p.standardError = log
      }
      p.terminationHandler = { proc in
        DispatchQueue.main.async {
          if self.server === proc && !NSApp.isTerminating {
            self.showError("The Glidecast server stopped (exit \(proc.terminationStatus)).", detail: self.logTail())
          }
        }
      }
      do {
        try p.run()
        self.server = p
      } catch {
        return self.showError("Couldn't start the server.", detail: error.localizedDescription)
      }
      self.waitForServer(attempts: 150)
    }
  }

  func waitForServer(attempts: Int) {
    isServerUp { up in
      if up { self.webView.load(URLRequest(url: editorURL)); return }
      guard attempts > 0, self.server?.isRunning == true else { return }
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { self.waitForServer(attempts: attempts - 1) }
    }
  }

  func isServerUp(_ done: @escaping (Bool) -> Void) {
    var req = URLRequest(url: editorURL)
    req.timeoutInterval = 1
    URLSession.shared.dataTask(with: req) { _, resp, _ in
      let ok = (resp as? HTTPURLResponse)?.statusCode == 200
      DispatchQueue.main.async { done(ok) }
    }.resume()
  }

  func findExecutable(_ name: String) -> String? {
    for dir in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
      let path = "\(dir)/\(name)"
      if FileManager.default.isExecutableFile(atPath: path) { return path }
    }
    // Fall back to the user's login shell (nvm, volta, asdf…).
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/zsh")
    p.arguments = ["-lc", "command -v \(name)"]
    let pipe = Pipe()
    p.standardOutput = pipe
    try? p.run()
    p.waitUntilExit()
    let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
      .trimmingCharacters(in: .whitespacesAndNewlines)
    return (out?.isEmpty == false) ? out : nil
  }

  func logTail() -> String {
    guard let text = try? String(contentsOf: logURL, encoding: .utf8) else { return "" }
    return text.split(separator: "\n").suffix(15).joined(separator: "\n")
  }

  // MARK: Status pages

  func page(_ body: String) -> String {
    """
    <html><body style="margin:0;height:100vh;display:grid;place-items:center;background:#0d0e10;color:#e7e8ea;
    font:14px -apple-system,system-ui;-webkit-user-select:text"><div style="max-width:560px;text-align:center">\(body)</div></body></html>
    """
  }

  func esc(_ s: String) -> String {
    s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
  }

  func showStatus(_ text: String) {
    webView.loadHTMLString(page("<p style='color:#8a8f99'>\(esc(text))</p>"), baseURL: nil)
  }

  func showError(_ title: String, detail: String) {
    webView.loadHTMLString(
      page("""
        <h3 style="font-weight:500">\(esc(title))</h3>
        <pre style="text-align:left;white-space:pre-wrap;color:#8a8f99;font:11px ui-monospace,Menlo">\(esc(detail))</pre>
        <p style="color:#8a8f99">Log: ~/Library/Logs/Glidecast.log</p>
        """), baseURL: nil)
  }

  // MARK: Web view behavior

  // Links that open new windows go to the default browser.
  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
               for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if let url = action.request.url { NSWorkspace.shared.open(url) }
    return nil
  }

  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
               decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    if action.shouldPerformDownload { return decisionHandler(.download) }
    if let url = action.request.url, action.navigationType == .linkActivated,
       url.host != "127.0.0.1" && url.host != "localhost" {
      NSWorkspace.shared.open(url)
      return decisionHandler(.cancel)
    }
    decisionHandler(.allow)
  }

  func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
               decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
    decisionHandler(response.canShowMIMEType ? .allow : .download)
  }

  func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
    download.delegate = self
  }

  func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
    download.delegate = self
  }

  // Export project → save panel.
  func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                completionHandler: @escaping (URL?) -> Void) {
    let panel = NSSavePanel()
    panel.nameFieldStringValue = suggestedFilename
    panel.beginSheetModal(for: window) { result in
      guard result == .OK, let url = panel.url else { return completionHandler(nil) }
      try? FileManager.default.removeItem(at: url)
      completionHandler(url)
    }
  }

  // Import project → open panel.
  func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
    let panel = NSOpenPanel()
    panel.allowsMultipleSelection = parameters.allowsMultipleSelection
    panel.canChooseDirectories = false
    panel.beginSheetModal(for: window) { result in
      completionHandler(result == .OK ? panel.urls : nil)
    }
  }

  func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
    let alert = NSAlert()
    alert.messageText = message
    alert.beginSheetModal(for: window) { _ in completionHandler() }
  }

  func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
    let alert = NSAlert()
    alert.messageText = message
    alert.addButton(withTitle: "OK")
    alert.addButton(withTitle: "Cancel")
    alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }

  // MARK: Menu

  @objc func reloadEditor(_ sender: Any?) { webView.load(URLRequest(url: editorURL)) }
  @objc func openRenders(_ sender: Any?) {
    let dir = projectDir.appendingPathComponent("renders")
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    NSWorkspace.shared.open(dir)
  }
  @objc func openLog(_ sender: Any?) { NSWorkspace.shared.open(logURL) }

  func buildMenu() {
    let main = NSMenu()

    let appItem = NSMenuItem()
    let appMenu = NSMenu()
    appMenu.addItem(withTitle: "About Glidecast", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
    appMenu.addItem(.separator())
    appMenu.addItem(withTitle: "Hide Glidecast", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
    appMenu.addItem(withTitle: "Quit Glidecast", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    appItem.submenu = appMenu
    main.addItem(appItem)

    let fileItem = NSMenuItem()
    let fileMenu = NSMenu(title: "File")
    fileMenu.addItem(withTitle: "Open Renders Folder", action: #selector(openRenders(_:)), keyEquivalent: "o")
    fileMenu.addItem(withTitle: "Show Server Log", action: #selector(openLog(_:)), keyEquivalent: "")
    fileMenu.addItem(.separator())
    fileMenu.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
    fileItem.submenu = fileMenu
    main.addItem(fileItem)

    // Needed so ⌘C / ⌘V / ⌘A work in the editor's text fields.
    let editItem = NSMenuItem()
    let editMenu = NSMenu(title: "Edit")
    editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
    editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
    editMenu.addItem(.separator())
    editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    editItem.submenu = editMenu
    main.addItem(editItem)

    let viewItem = NSMenuItem()
    let viewMenu = NSMenu(title: "View")
    viewMenu.addItem(withTitle: "Reload", action: #selector(reloadEditor(_:)), keyEquivalent: "r")
    viewMenu.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
      .keyEquivalentModifierMask = [.command, .control]
    viewItem.submenu = viewMenu
    main.addItem(viewItem)

    let windowItem = NSMenuItem()
    let windowMenu = NSMenu(title: "Window")
    windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
    windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
    windowItem.submenu = windowMenu
    main.addItem(windowItem)
    NSApp.windowsMenu = windowMenu

    NSApp.mainMenu = main
  }
}

extension NSApplication {
  var isTerminating: Bool { (delegate as? AppDelegate)?.terminating ?? false }
}

extension AppDelegate {
  var terminating: Bool {
    get { objc_getAssociatedObject(self, &terminatingKey) as? Bool ?? false }
    set { objc_setAssociatedObject(self, &terminatingKey, newValue, .OBJC_ASSOCIATION_RETAIN) }
  }

  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    terminating = true
    return .terminateNow
  }
}
nonisolated(unsafe) var terminatingKey: UInt8 = 0

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
