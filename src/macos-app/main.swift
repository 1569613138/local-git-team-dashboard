import AppKit
import Foundation
import WebKit

private let projectRoot = "/Users/00560611/WorkBuddy/2026-10-15-15-56-52"
private let nodePath = "/Users/00560611/.workbuddy/binaries/node/versions/22.22.2-6/bin/node"
private let dashboardPort = 4175
private let dashboardURL = URL(string: "http://127.0.0.1:\(dashboardPort)/")!
private let healthURL = URL(string: "http://127.0.0.1:\(dashboardPort)/api/health")!

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var loadingView: NSView!
    private var serverProcess: Process?
    private var startedServer = false
    private var loadingLabel: NSTextField!
    private var retryButton: NSButton!
    private var attempts = 0
    private let maximumAttempts = 60

    func applicationDidFinishLaunching(_ notification: Notification) {
        configureMenu()
        createWindow()
        ensureServerAndLoad()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationWillTerminate(_ notification: Notification) {
        stopManagedServer()
    }

    private func configureMenu() {
        let mainMenu = NSMenu()
        let appMenuItem = NSMenuItem()
        mainMenu.addItem(appMenuItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "关于 Git贡献看板", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "刷新页面", action: #selector(reloadPage), keyEquivalent: "r")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "退出 Git贡献看板", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appMenuItem.submenu = appMenu
        NSApplication.shared.mainMenu = mainMenu
    }

    private func createWindow() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.autoresizingMask = [.width, .height]
        webView.isHidden = true

        loadingView = NSView()
        loadingView.translatesAutoresizingMaskIntoConstraints = false

        let progress = NSProgressIndicator()
        progress.style = .spinning
        progress.controlSize = .large
        progress.startAnimation(nil)
        progress.translatesAutoresizingMaskIntoConstraints = false

        loadingLabel = NSTextField(labelWithString: "正在启动代码贡献看板…")
        loadingLabel.font = .systemFont(ofSize: 15, weight: .medium)
        loadingLabel.textColor = .secondaryLabelColor
        loadingLabel.alignment = .center
        loadingLabel.translatesAutoresizingMaskIntoConstraints = false

        retryButton = NSButton(title: "重新启动", target: self, action: #selector(retryStart))
        retryButton.bezelStyle = .rounded
        retryButton.isHidden = true
        retryButton.translatesAutoresizingMaskIntoConstraints = false

        loadingView.addSubview(progress)
        loadingView.addSubview(loadingLabel)
        loadingView.addSubview(retryButton)

        let contentView = NSView()
        contentView.addSubview(webView)
        contentView.addSubview(loadingView)
        webView.translatesAutoresizingMaskIntoConstraints = false

        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
            webView.topAnchor.constraint(equalTo: contentView.topAnchor),
            webView.bottomAnchor.constraint(equalTo: contentView.bottomAnchor),
            loadingView.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
            loadingView.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
            loadingView.topAnchor.constraint(equalTo: contentView.topAnchor),
            loadingView.bottomAnchor.constraint(equalTo: contentView.bottomAnchor),
            progress.centerXAnchor.constraint(equalTo: loadingView.centerXAnchor),
            progress.centerYAnchor.constraint(equalTo: loadingView.centerYAnchor, constant: -28),
            loadingLabel.topAnchor.constraint(equalTo: progress.bottomAnchor, constant: 18),
            loadingLabel.centerXAnchor.constraint(equalTo: loadingView.centerXAnchor),
            retryButton.topAnchor.constraint(equalTo: loadingLabel.bottomAnchor, constant: 16),
            retryButton.centerXAnchor.constraint(equalTo: loadingView.centerXAnchor),
        ])

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1360, height: 860),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "Git 代码贡献看板"
        window.titlebarAppearsTransparent = false
        window.minSize = NSSize(width: 980, height: 640)
        window.contentView = contentView
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }

    private func ensureServerAndLoad() {
        attempts = 0
        retryButton.isHidden = true
        loadingView.isHidden = false
        loadingLabel.stringValue = "正在检查本地统计服务…"
        webView.isHidden = true
        checkHealth { [weak self] available in
            guard let self else { return }
            if available {
                self.loadDashboard()
            } else {
                self.startServer()
            }
        }
    }

    private func startServer() {
        guard FileManager.default.isExecutableFile(atPath: nodePath) else {
            showFailure("未找到 Node.js 22，无法启动统计服务。")
            return
        }
        guard FileManager.default.fileExists(atPath: "\(projectRoot)/src/server/index.js") else {
            showFailure("项目目录不存在，无法启动统计服务。")
            return
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: nodePath)
        process.arguments = ["\(projectRoot)/src/server/index.js", "--config", "\(projectRoot)/config/app.local.json"]
        process.currentDirectoryURL = URL(fileURLWithPath: projectRoot)
        var environment = ProcessInfo.processInfo.environment
        environment["PORT"] = String(dashboardPort)
        environment["GIT_STATS_CONFIG"] = "\(projectRoot)/config/app.local.json"
        process.environment = environment
        process.standardOutput = Pipe()
        process.standardError = Pipe()
        process.terminationHandler = { [weak self] process in
            DispatchQueue.main.async {
                guard let self, self.startedServer, process.terminationStatus != 0, self.webView.isHidden else { return }
                self.showFailure("统计服务启动失败，请点击重新启动。")
            }
        }

        do {
            try process.run()
            serverProcess = process
            startedServer = true
            loadingLabel.stringValue = "正在加载仓库统计数据…"
            waitForServer()
        } catch {
            showFailure("无法启动统计服务：\(error.localizedDescription)")
        }
    }

    private func waitForServer() {
        attempts += 1
        checkHealth { [weak self] available in
            guard let self else { return }
            if available {
                self.loadDashboard()
            } else if self.attempts < self.maximumAttempts {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                    self.waitForServer()
                }
            } else {
                self.showFailure("等待统计服务超时，请点击重新启动。")
            }
        }
    }

    private func checkHealth(completion: @escaping (Bool) -> Void) {
        var request = URLRequest(url: healthURL)
        request.timeoutInterval = 1.5
        URLSession.shared.dataTask(with: request) { _, response, _ in
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            DispatchQueue.main.async { completion((200..<300).contains(status)) }
        }.resume()
    }

    private func loadDashboard() {
        loadingLabel.stringValue = "正在打开看板…"
        webView.load(URLRequest(url: dashboardURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15))
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loadingView.isHidden = true
        webView.isHidden = false
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showFailure("页面加载失败：\(error.localizedDescription)")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showFailure("页面加载失败：\(error.localizedDescription)")
    }

    private func showFailure(_ message: String) {
        loadingView.isHidden = false
        loadingLabel.stringValue = message
        retryButton.isHidden = false
        webView.isHidden = true
    }

    private func stopManagedServer() {
        guard startedServer, let process = serverProcess, process.isRunning else { return }
        process.terminate()
    }

    @objc private func retryStart() {
        stopManagedServer()
        serverProcess = nil
        startedServer = false
        ensureServerAndLoad()
    }

    @objc private func reloadPage() {
        if webView.isHidden {
            ensureServerAndLoad()
        } else {
            webView.reloadFromOrigin()
        }
    }
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
