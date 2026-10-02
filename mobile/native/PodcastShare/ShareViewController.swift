import UIKit
import UniformTypeIdentifiers

final class ShareViewController: UIViewController {
  private let message = UILabel()
  private var started = false
  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground
    message.text = "正在保存播客… / Saving podcast…"
    message.numberOfLines = 0
    message.textAlignment = .center
    let button = UIButton(type: .system)
    button.setTitle("完成 / Done", for: .normal)
    button.addTarget(self, action: #selector(done), for: .touchUpInside)
    let stack = UIStackView(arrangedSubviews: [message, button])
    stack.axis = .vertical
    stack.spacing = 24
    stack.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(stack)
    NSLayoutConstraint.activate([stack.centerYAnchor.constraint(equalTo: view.centerYAnchor), stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 28), stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -28)])
  }
  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    guard !started else { return }
    started = true
    let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
    guard let provider = providers.first(where: { $0.hasItemConformingToTypeIdentifier(UTType.url.identifier) || $0.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) }) else { show("请分享单集链接 / Please share an episode link"); return }
    let type = provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) ? UTType.url.identifier : UTType.plainText.identifier
    provider.loadItem(forTypeIdentifier: type, options: nil) { [weak self] item, error in
      guard let self else { return }
      let raw = (item as? URL)?.absoluteString ?? (item as? String) ?? ""
      let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)
      let url = detector?.firstMatch(in: raw, range: NSRange(raw.startIndex..., in: raw))?.url
      guard error == nil, let url, url.scheme == "https", url.host == "podcasts.apple.com",
            URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.contains(where: { $0.name == "i" }) == true else {
        self.show("请分享 Apple Podcasts 单集链接 / Share an Apple Podcasts episode link")
        return
      }
      do {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "AsideAppGroup") as? String,
              let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else { throw NSError(domain: "AsideShare", code: 1) }
        let folder = root.appendingPathComponent("PodcastInbox", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let id = UUID().uuidString
        let bytes = try JSONSerialization.data(withJSONObject: ["id": id, "url": url.absoluteString])
        try bytes.write(to: folder.appendingPathComponent(id + ".json"), options: .atomic)
        self.show("已保存。打开 Aside 即可收听和提问。\nSaved. Open Aside to listen and ask.")
      } catch { self.show("保存失败，请重试 / Could not save. Please try again.") }
    }
  }
  private func show(_ text: String) { DispatchQueue.main.async { self.message.text = text } }
  @objc private func done() { extensionContext?.completeRequest(returningItems: nil) }
}
