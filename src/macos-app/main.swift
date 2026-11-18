import AppKit
import Foundation
import WebKit

private let applicationName = "Git贡献看板"
private let defaultPathFilter: [String: Any] = [
    "directories": ["node_modules", "dist", "build", "coverage", "vendor"],
    "suffixes": [".min.js", ".min.css", ".map", ".gz", ".br", ".zip", ".tgz"],
    "files": ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml"],
]

private func slug(_ value: String, fallback: String) -> String {
    let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-")
    let normalized = value.unicodeScalars.map { allowed.contains($0) ? Character(String($0).lowercased()) : "-" }
    let compact = String(normalized).replacingOccurrences(of: "-+", with: "-", options: .regularExpression).trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    return compact.isEmpty ? fallback : compact
}

private func textField(_ placeholder: String, value: String = "") -> NSTextField {
    let field = NSTextField(string: value)
    field.placeholderString = placeholder
    field.translatesAutoresizingMaskIntoConstraints = false
    return field
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var loadingView: NSView!
    private var configurationView: NSView!
    private var configurationEditor: NSTextView!
    private var configurationMessage: NSTextField!
    private var serverProcess: Process?
    private var outputPipe: Pipe?
    private var errorPipe: Pipe?
    private var loadingLabel: NSTextField!
    private var retryButton: NSButton!
    private var attempts = 0
    private let maximumAttempts = 80
    private var dashboardPort = Int.random(in: 42_000...52_000)

    private lazy var resourcesURL: URL = Bundle.main.resourceURL ?? URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
    private lazy var dashboardRootURL: URL = {
        if let developmentRoot = ProcessInfo.processInfo.environment["GIT_DASHBOARD_DEV_ROOT"], !developmentRoot.isEmpty {
            return URL(fileURLWithPath: developmentRoot, isDirectory: true)
        }
        return resourcesURL.appendingPathComponent("dashboard", isDirectory: true)
    }()
    private lazy var nodeURL: URL = {
        if let developmentNode = ProcessInfo.processInfo.environment["GIT_DASHBOARD_NODE_PATH"], !developmentNode.isEmpty {
            return URL(fileURLWithPath: developmentNode)
        }
        return resourcesURL.appendingPathComponent("runtime/node")
    }()
    private lazy var supportURL: URL = {
        if let override = ProcessInfo.processInfo.environment["GIT_DASHBOARD_SUPPORT_DIR"], !override.isEmpty {
            return URL(fileURLWithPath: override, isDirectory: true)
        }
        return FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(applicationName, isDirectory: true)
    }()
    private lazy var configURL = supportURL.appendingPathComponent("config.json")
    private lazy var cacheURL = supportURL.appendingPathComponent("cache/git-stats", isDirectory: true)
    private lazy var repositoriesURL = supportURL.appendingPathComponent("repositories", isDirectory: true)
    private lazy var logsURL = supportURL.appendingPathComponent("logs", isDirectory: true)
    private var dashboardURL: URL { URL(string: "http://127.0.0.1:\(dashboardPort)/")! }
    private var healthURL: URL { URL(string: "http://127.0.0.1:\(dashboardPort)/api/health")! }

    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            try prepareSupportDirectories()
        } catch {
            showFatalAlert("无法创建应用数据目录：\(error.localizedDescription)")
            NSApplication.shared.terminate(nil)
            return
        }
        configureMenu()
        createWindow()
        if FileManager.default.fileExists(atPath: configURL.path) {
            ensureServerAndLoad()
        } else {
            showConfiguration()
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        stopManagedServer()
    }

    private func prepareSupportDirectories() throws {
        for directory in [supportURL, cacheURL, repositoriesURL, logsURL] {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        }
    }

    private func configureMenu() {
        let mainMenu = NSMenu()
        let appMenuItem = NSMenuItem()
        mainMenu.addItem(appMenuItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "关于 \(applicationName)", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "配置…", action: #selector(openConfiguration), keyEquivalent: ",")
        appMenu.addItem(withTitle: "刷新页面", action: #selector(reloadPage), keyEquivalent: "r")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "退出 \(applicationName)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appMenuItem.submenu = appMenu
        NSApplication.shared.mainMenu = mainMenu
    }

    private func createWindow() {
        let webConfiguration = WKWebViewConfiguration()
        webConfiguration.websiteDataStore = .default()
        webView = WKWebView(frame: .zero, configuration: webConfiguration)
        webView.navigationDelegate = self
        webView.translatesAutoresizingMaskIntoConstraints = false
        webView.isHidden = true

        loadingView = createLoadingView()
        configurationView = createConfigurationView()
        configurationView.isHidden = true

        let contentView = NSView()
        for view in [webView!, loadingView!, configurationView!] {
            contentView.addSubview(view)
            NSLayoutConstraint.activate([
                view.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
                view.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
                view.topAnchor.constraint(equalTo: contentView.topAnchor),
                view.bottomAnchor.constraint(equalTo: contentView.bottomAnchor),
            ])
        }

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1360, height: 860),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "Git 代码贡献看板"
        window.minSize = NSSize(width: 980, height: 640)
        window.contentView = contentView
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }

    private func createLoadingView() -> NSView {
        let view = NSView()
        view.translatesAutoresizingMaskIntoConstraints = false
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
        for item in [progress, loadingLabel!, retryButton!] { view.addSubview(item) }
        NSLayoutConstraint.activate([
            progress.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            progress.centerYAnchor.constraint(equalTo: view.centerYAnchor, constant: -28),
            loadingLabel.topAnchor.constraint(equalTo: progress.bottomAnchor, constant: 18),
            loadingLabel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            retryButton.topAnchor.constraint(equalTo: loadingLabel.bottomAnchor, constant: 16),
            retryButton.centerXAnchor.constraint(equalTo: view.centerXAnchor),
        ])
        return view
    }

    private func createConfigurationView() -> NSView {
        let view = NSView()
        view.translatesAutoresizingMaskIntoConstraints = false

        let title = NSTextField(labelWithString: "配置 Git 贡献看板")
        title.font = .systemFont(ofSize: 24, weight: .semibold)
        let subtitle = NSTextField(wrappingLabelWithString: "配置只保存在本机。可先选择本地仓库或添加远程仓库，再按需添加成员映射。高级用户可直接编辑完整 JSON。")
        subtitle.textColor = .secondaryLabelColor
        subtitle.maximumNumberOfLines = 2

        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.borderType = .bezelBorder
        scroll.translatesAutoresizingMaskIntoConstraints = false
        configurationEditor = NSTextView()
        configurationEditor.isRichText = false
        configurationEditor.isAutomaticQuoteSubstitutionEnabled = false
        configurationEditor.font = NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
        configurationEditor.textContainerInset = NSSize(width: 12, height: 12)
        scroll.documentView = configurationEditor

        let addLocal = NSButton(title: "选择本地仓库…", target: self, action: #selector(addLocalRepository))
        let addRemote = NSButton(title: "添加远程仓库…", target: self, action: #selector(addRemoteRepository))
        let addMember = NSButton(title: "添加成员…", target: self, action: #selector(addMemberMapping))
        let save = NSButton(title: "保存并启动", target: self, action: #selector(saveConfiguration))
        save.keyEquivalent = "\r"
        save.bezelStyle = .rounded
        save.contentTintColor = .controlAccentColor
        configurationMessage = NSTextField(labelWithString: "")
        configurationMessage.textColor = .systemRed
        configurationMessage.lineBreakMode = .byTruncatingTail

        let buttonStack = NSStackView(views: [addLocal, addRemote, addMember, NSView(), configurationMessage, save])
        buttonStack.orientation = .horizontal
        buttonStack.spacing = 10
        buttonStack.alignment = .centerY
        buttonStack.setHuggingPriority(.defaultLow, for: .horizontal)

        let stack = NSStackView(views: [title, subtitle, scroll, buttonStack])
        stack.orientation = .vertical
        stack.spacing = 14
        stack.alignment = .leading
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 48),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -48),
            stack.topAnchor.constraint(equalTo: view.topAnchor, constant: 36),
            stack.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -32),
            title.widthAnchor.constraint(equalTo: stack.widthAnchor),
            subtitle.widthAnchor.constraint(equalTo: stack.widthAnchor),
            scroll.widthAnchor.constraint(equalTo: stack.widthAnchor),
            scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 420),
            buttonStack.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
        return view
    }

    private func emptyConfiguration() -> [String: Any] {
        ["repositories": [], "members": [], "pathFilter": defaultPathFilter]
    }

    private func currentConfigurationObject() throws -> [String: Any] {
        let data = Data(configurationEditor.string.utf8)
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw NSError(domain: applicationName, code: 1, userInfo: [NSLocalizedDescriptionKey: "配置顶层必须是 JSON 对象"])
        }
        guard object["repositories"] is [Any], object["members"] is [Any], object["pathFilter"] is [String: Any] else {
            throw NSError(domain: applicationName, code: 2, userInfo: [NSLocalizedDescriptionKey: "配置必须包含 repositories、members 和 pathFilter"])
        }
        return object
    }

    private func setConfigurationObject(_ object: [String: Any]) throws {
        let data = try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
        configurationEditor.string = String(decoding: data, as: UTF8.self) + "\n"
    }

    private func showConfiguration() {
        stopManagedServer()
        webView.isHidden = true
        loadingView.isHidden = true
        configurationView.isHidden = false
        configurationMessage.stringValue = "配置文件：\(configURL.path)"
        configurationMessage.textColor = .secondaryLabelColor
        do {
            if FileManager.default.fileExists(atPath: configURL.path) {
                configurationEditor.string = try String(contentsOf: configURL, encoding: .utf8)
            } else {
                try setConfigurationObject(emptyConfiguration())
            }
        } catch {
            configurationMessage.stringValue = "读取配置失败：\(error.localizedDescription)"
            configurationMessage.textColor = .systemRed
        }
    }

    private func prompt(title: String, fields: [(String, String)]) -> [String]? {
        let alert = NSAlert()
        alert.messageText = title
        alert.addButton(withTitle: "添加")
        alert.addButton(withTitle: "取消")
        let controls = fields.map { label, value -> NSView in
            let labelField = NSTextField(labelWithString: label)
            labelField.frame = NSRect(x: 0, y: 0, width: 130, height: 24)
            let field = textField(label, value: value)
            field.frame = NSRect(x: 140, y: 0, width: 330, height: 24)
            let row = NSView(frame: NSRect(x: 0, y: 0, width: 470, height: 28))
            row.addSubview(labelField)
            row.addSubview(field)
            return row
        }
        let stack = NSStackView(views: controls)
        stack.orientation = .vertical
        stack.spacing = 7
        stack.frame = NSRect(x: 0, y: 0, width: 470, height: CGFloat(controls.count * 35))
        alert.accessoryView = stack
        guard alert.runModal() == .alertFirstButtonReturn else { return nil }
        return controls.compactMap { view in view.subviews.compactMap { $0 as? NSTextField }.last?.stringValue }
    }

    @objc private func addLocalRepository() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "选择仓库"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        let gitDirectory = url.appendingPathComponent(".git")
        guard FileManager.default.fileExists(atPath: gitDirectory.path) else {
            configurationMessage.stringValue = "所选目录不是 Git 仓库（未找到 .git）"
            configurationMessage.textColor = .systemRed
            return
        }
        let name = url.lastPathComponent
        guard let values = prompt(title: "添加本地仓库", fields: [("显示名称", name), ("仓库 ID", slug(name, fallback: "repository")), ("默认分支", "main")]) else { return }
        appendRepository(["id": values[1], "name": values[0], "path": url.path, "defaultBranch": values[2], "branches": [], "enabled": true])
    }

    @objc private func addRemoteRepository() {
        guard let values = prompt(title: "添加远程 HTTP(S) 仓库", fields: [("远程地址", "https://example.com/team/repository.git"), ("显示名称", "团队仓库"), ("仓库 ID", "team-repository"), ("默认分支", "main")]) else { return }
        guard let url = URL(string: values[0]), ["http", "https"].contains(url.scheme?.lowercased() ?? ""), url.user == nil, url.password == nil else {
            configurationMessage.stringValue = "远程地址必须是无内嵌账号密码的 HTTP(S) URL"
            configurationMessage.textColor = .systemRed
            return
        }
        let repositoryID = slug(values[2], fallback: "repository")
        let managedPath = repositoriesURL.appendingPathComponent(repositoryID, isDirectory: true).path
        appendRepository(["id": repositoryID, "name": values[1], "path": managedPath, "remoteUrl": values[0], "defaultBranch": values[3], "branches": [], "enabled": true])
    }

    private func appendRepository(_ repository: [String: Any]) {
        do {
            var object = try currentConfigurationObject()
            var repositories = object["repositories"] as? [[String: Any]] ?? []
            if repositories.contains(where: { ($0["id"] as? String) == (repository["id"] as? String) }) {
                throw NSError(domain: applicationName, code: 3, userInfo: [NSLocalizedDescriptionKey: "仓库 ID 已存在"])
            }
            repositories.append(repository)
            object["repositories"] = repositories
            try setConfigurationObject(object)
            configurationMessage.stringValue = "已添加仓库，请检查配置后保存"
            configurationMessage.textColor = .systemGreen
        } catch {
            configurationMessage.stringValue = error.localizedDescription
            configurationMessage.textColor = .systemRed
        }
    }

    @objc private func addMemberMapping() {
        guard let values = prompt(title: "添加成员映射", fields: [("姓名", "成员姓名"), ("工号/ID", "member-001"), ("Git 用户名", "Git Author Name"), ("Git 邮箱", "author@example.com")]) else { return }
        do {
            var object = try currentConfigurationObject()
            var members = object["members"] as? [[String: Any]] ?? []
            let memberID = slug(values[1], fallback: "member-\(members.count + 1)")
            if members.contains(where: { ($0["id"] as? String) == memberID }) {
                throw NSError(domain: applicationName, code: 4, userInfo: [NSLocalizedDescriptionKey: "成员 ID 已存在"])
            }
            members.append(["id": memberID, "displayName": values[0], "names": values[2].isEmpty ? [] : [values[2]], "emails": values[3].isEmpty ? [] : [values[3]], "internal": true])
            object["members"] = members
            try setConfigurationObject(object)
            configurationMessage.stringValue = "已添加成员，请检查配置后保存"
            configurationMessage.textColor = .systemGreen
        } catch {
            configurationMessage.stringValue = error.localizedDescription
            configurationMessage.textColor = .systemRed
        }
    }

    @objc private func saveConfiguration() {
        do {
            let object = try currentConfigurationObject()
            guard let repositories = object["repositories"] as? [[String: Any]], !repositories.isEmpty else {
                throw NSError(domain: applicationName, code: 5, userInfo: [NSLocalizedDescriptionKey: "请至少添加一个仓库"])
            }
            var ids = Set<String>()
            for (index, repository) in repositories.enumerated() {
                guard let id = repository["id"] as? String, !id.isEmpty, ids.insert(id).inserted else {
                    throw NSError(domain: applicationName, code: 6, userInfo: [NSLocalizedDescriptionKey: "第 \(index + 1) 个仓库缺少唯一 ID"])
                }
                guard let path = repository["path"] as? String, path.hasPrefix("/") else {
                    throw NSError(domain: applicationName, code: 7, userInfo: [NSLocalizedDescriptionKey: "仓库 \(id) 的 path 必须是绝对路径"])
                }
            }
            let data = try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
            try data.write(to: configURL, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: configURL.path)
            configurationMessage.stringValue = "配置已保存，正在启动…"
            configurationMessage.textColor = .systemGreen
            configurationView.isHidden = true
            stopManagedServer()
            serverProcess = nil
            startedServerReset()
            ensureServerAndLoad()
        } catch {
            configurationMessage.stringValue = "无法保存：\(error.localizedDescription)"
            configurationMessage.textColor = .systemRed
        }
    }

    private func startedServerReset() {
        attempts = 0
        dashboardPort = Int.random(in: 42_000...52_000)
    }

    private func ensureServerAndLoad() {
        guard FileManager.default.fileExists(atPath: configURL.path) else {
            showConfiguration()
            return
        }
        attempts = 0
        retryButton.isHidden = true
        loadingView.isHidden = false
        configurationView.isHidden = true
        loadingLabel.stringValue = "正在启动本地统计服务…"
        webView.isHidden = true
        startServer()
    }

    private func startServer() {
        guard FileManager.default.isExecutableFile(atPath: nodeURL.path) else {
            showFailure("应用包中的 Node.js 运行时不可用。")
            return
        }
        let serverURL = dashboardRootURL.appendingPathComponent("src/server/index.js")
        guard FileManager.default.fileExists(atPath: serverURL.path) else {
            showFailure("应用包中的统计服务文件不完整。")
            return
        }
        let process = Process()
        process.executableURL = nodeURL
        process.arguments = [serverURL.path]
        process.currentDirectoryURL = dashboardRootURL
        var environment = ProcessInfo.processInfo.environment
        environment["PORT"] = String(dashboardPort)
        environment["GIT_STATS_CONFIG"] = configURL.path
        environment["GIT_STATS_CACHE_DIRECTORY"] = cacheURL.path
        environment["GIT_STATS_PUBLIC_DIRECTORY"] = dashboardRootURL.appendingPathComponent("public").path
        environment["PATH"] = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        process.environment = environment

        let stdout = Pipe()
        let stderr = Pipe()
        outputPipe = stdout
        errorPipe = stderr
        process.standardOutput = stdout
        process.standardError = stderr
        drain(stdout, label: "OUT")
        drain(stderr, label: "ERR")
        process.terminationHandler = { [weak self] process in
            DispatchQueue.main.async {
                guard let self, process.terminationStatus != 0, self.webView.isHidden else { return }
                self.showFailure("统计服务启动失败。请检查配置或打开“配置…”修改。")
            }
        }
        do {
            try process.run()
            serverProcess = process
            loadingLabel.stringValue = "正在加载仓库统计数据…"
            waitForServer()
        } catch {
            showFailure("无法启动统计服务：\(error.localizedDescription)")
        }
    }

    private func drain(_ pipe: Pipe, label: String) {
        let logURL = logsURL.appendingPathComponent("server.log")
        pipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            let line = Data("[\(label)] ".utf8) + data
            if !FileManager.default.fileExists(atPath: logURL.path) { FileManager.default.createFile(atPath: logURL.path, contents: nil) }
            guard let writer = try? FileHandle(forWritingTo: logURL) else { return }
            defer { try? writer.close() }
            _ = try? writer.seekToEnd()
            try? writer.write(contentsOf: line)
        }
    }

    private func waitForServer() {
        attempts += 1
        checkHealth { [weak self] available in
            guard let self else { return }
            if available {
                self.loadDashboard()
            } else if self.attempts < self.maximumAttempts, self.serverProcess?.isRunning == true {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { self.waitForServer() }
            } else {
                self.showFailure("等待统计服务超时。请检查配置或重新启动。")
            }
        }
    }

    private func checkHealth(completion: @escaping (Bool) -> Void) {
        var request = URLRequest(url: healthURL)
        request.timeoutInterval = 1
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
        configurationView.isHidden = true
        webView.isHidden = false
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { showFailure("页面加载失败：\(error.localizedDescription)") }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { showFailure("页面加载失败：\(error.localizedDescription)") }

    private func showFailure(_ message: String) {
        loadingView.isHidden = false
        configurationView.isHidden = true
        loadingLabel.stringValue = message
        retryButton.isHidden = false
        webView.isHidden = true
    }

    private func stopManagedServer() {
        outputPipe?.fileHandleForReading.readabilityHandler = nil
        errorPipe?.fileHandleForReading.readabilityHandler = nil
        if let process = serverProcess, process.isRunning { process.terminate() }
    }

    private func showFatalAlert(_ message: String) {
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = applicationName
        alert.informativeText = message
        alert.runModal()
    }

    @objc private func retryStart() {
        stopManagedServer()
        serverProcess = nil
        startedServerReset()
        ensureServerAndLoad()
    }

    @objc private func reloadPage() {
        if webView.isHidden { ensureServerAndLoad() } else { webView.reloadFromOrigin() }
    }

    @objc private func openConfiguration() { showConfiguration() }
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
