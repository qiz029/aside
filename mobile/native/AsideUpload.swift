import Foundation
import Security
import React

private struct UploadJob: Codable {
  var id: String
  var base: String
  var size: Int
  var partSize: Int
  var parts: [[String: String]] = []
  var state = "uploading"
  var error: String?
}

@objc class AsideUploadManager: NSObject, URLSessionDataDelegate, URLSessionTaskDelegate {
  static let shared = AsideUploadManager()
  private var jobs: [String: UploadJob] = [:]
  private var bodies: [Int: Data] = [:]
  private var active: Set<String> = []
  private var backgroundCompletion: (() -> Void)?
  private let root: URL
  private var session: URLSession!
  private override init() {
    root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("AsideUploads", isDirectory: true)
    super.init()
    try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    var values = URLResourceValues(); values.isExcludedFromBackup = true
    var directory = root; try? directory.setResourceValues(values)
    for folder in (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? [] {
      if let data = try? Data(contentsOf: folder.appendingPathComponent("job.json")), let job = try? JSONDecoder().decode(UploadJob.self, from: data) { jobs[job.id] = job }
    }
    let config = URLSessionConfiguration.background(withIdentifier: Self.identifier)
    config.isDiscretionary = false
    config.sessionSendsLaunchEvents = true
    config.waitsForConnectivity = true
    config.timeoutIntervalForResource = 24 * 60 * 60
    config.httpMaximumConnectionsPerHost = 1
    session = URLSession(configuration: config, delegate: self, delegateQueue: OperationQueue.main)
    session.getAllTasks { tasks in
      DispatchQueue.main.async {
        for task in tasks { if let id = task.taskDescription { self.active.insert(id) } }
        for job in self.jobs.values where job.state == "uploading" || job.state == "processing" {
          if !self.active.contains(job.id) { self.schedule(job.id) }
        }
      }
    }
  }
  static var identifier: String { (Bundle.main.bundleIdentifier ?? "aside") + ".background-upload" }
  func handleEvents(_ identifier: String, completion: @escaping () -> Void) -> Bool {
    guard identifier == Self.identifier else { return false }
    backgroundCompletion = completion
    return true
  }
  private func folder(_ id: String) -> URL { root.appendingPathComponent(id, isDirectory: true) }
  private func save(_ job: UploadJob) throws {
    jobs[job.id] = job
    try JSONEncoder().encode(job).write(to: folder(job.id).appendingPathComponent("job.json"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
  }
  private func keyQuery(_ id: String) -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: Self.identifier, kSecAttrAccount as String: id]
  }
  private func token(_ id: String) -> String? {
    var query = keyQuery(id); query[kSecReturnData as String] = true
    var result: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
    return String(data: data, encoding: .utf8)
  }
  func start(_ id: String, base: String, token: String, uri: String, size: Int, partSize: Int) throws {
    guard UUID(uuidString: id) != nil, let url = URL(string: base), ["https", "http"].contains(url.scheme ?? ""), size > 0, partSize > 0 else { throw NSError(domain: "AsideUpload", code: 1) }
    var query = keyQuery(id); SecItemDelete(query as CFDictionary)
    query[kSecValueData as String] = token.data(using: .utf8)!
    query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    guard SecItemAdd(query as CFDictionary, nil) == errSecSuccess else { throw NSError(domain: "AsideUploadKeychain", code: 1) }
    if var job = jobs[id] {
      if job.state == "done" || active.contains(id) { return }
      job.error = nil; job.state = "uploading"; try save(job)
    } else {
      try FileManager.default.createDirectory(at: folder(id), withIntermediateDirectories: true)
      let source = folder(id).appendingPathComponent("source")
      if FileManager.default.fileExists(atPath: source.path) { try FileManager.default.removeItem(at: source) }
      try FileManager.default.copyItem(at: URL(string: uri)!, to: source)
      try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: source.path)
      try save(UploadJob(id: id, base: base, size: size, partSize: partSize))
    }
    schedule(id)
  }
  private func fail(_ id: String, _ message: String) {
    guard var job = jobs[id] else { return }
    job.state = "paused"; job.error = message; try? save(job)
  }
  private func schedule(_ id: String) {
    guard let job = jobs[id], !active.contains(id), job.state != "done", job.state != "paused" else { return }
    guard let credential = token(id) else { fail(id, "Sign in again to resume upload."); return }
    do {
      let offset = job.parts.count * job.partSize
      let complete = offset >= job.size
      let bodyFile = folder(id).appendingPathComponent("body")
      var request = URLRequest(url: URL(string: job.base + "/api/uploads/" + id + (complete ? "/complete" : "/part?number=\(job.parts.count + 1)"))!)
      request.httpMethod = complete ? "POST" : "PUT"
      request.setValue("Bearer " + credential, forHTTPHeaderField: "Authorization")
      request.setValue(complete ? "application/json" : "application/octet-stream", forHTTPHeaderField: "Content-Type")
      if complete {
        let parts: [[String: Any]] = job.parts.enumerated().map { ["partNumber": $0.offset + 1, "etag": $0.element["etag"]!] }
        try JSONSerialization.data(withJSONObject: ["parts": parts]).write(to: bodyFile, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        var updated = job; updated.state = "processing"; try save(updated)
      } else {
        let source = try FileHandle(forReadingFrom: folder(id).appendingPathComponent("source"))
        defer { try? source.close() }
        try source.seek(toOffset: UInt64(offset))
        let expected = min(job.partSize, job.size - offset)
        guard let bytes = try source.read(upToCount: expected), bytes.count == expected else { throw NSError(domain: "AsideUploadFile", code: 1) }
        try bytes.write(to: bodyFile, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
      }
      let task = session.uploadTask(with: request, fromFile: bodyFile)
      task.taskDescription = id; active.insert(id); task.resume()
    } catch { fail(id, "Upload paused. Retry to continue from the saved part.") }
  }
  func status(_ id: String) -> [String: Any] {
    guard let job = jobs[id] else { return ["state": "missing", "progress": 0] }
    return ["state": job.state, "progress": min(1, Double(job.parts.count * job.partSize) / Double(job.size)), "error": job.error ?? ""]
  }
  func cancel(_ id: String, completion: @escaping () -> Void) {
    jobs.removeValue(forKey: id)
    session.getAllTasks { tasks in
      DispatchQueue.main.async {
        for task in tasks where task.taskDescription == id { task.cancel() }
        self.active.remove(id)
        SecItemDelete(self.keyQuery(id) as CFDictionary)
        try? FileManager.default.removeItem(at: self.folder(id))
        completion()
      }
    }
  }
  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    if (bodies[dataTask.taskIdentifier]?.count ?? 0) < 262144 { bodies[dataTask.taskIdentifier, default: Data()].append(data) }
  }
  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    let body = bodies.removeValue(forKey: task.taskIdentifier) ?? Data()
    guard let id = task.taskDescription else { return }
    active.remove(id)
    guard var job = jobs[id] else { return }
    let status = (task.response as? HTTPURLResponse)?.statusCode ?? 0
    guard error == nil, (200..<300).contains(status) else {
      fail(id, status == 401 ? "Sign in again to resume upload." : "Upload paused. Retry to continue from the saved part.")
      return
    }
    do {
      if task.originalRequest?.url?.path.hasSuffix("/complete") == true {
        job.state = "done"; try save(job)
        SecItemDelete(keyQuery(id) as CFDictionary)
        try? FileManager.default.removeItem(at: folder(id).appendingPathComponent("source"))
        try? FileManager.default.removeItem(at: folder(id).appendingPathComponent("body"))
      } else {
        guard let json = try JSONSerialization.jsonObject(with: body) as? [String: Any], let etag = json["etag"] as? String else { throw NSError(domain: "AsideUploadResponse", code: 1) }
        job.parts.append(["etag": etag]); try save(job); schedule(id)
      }
    } catch { fail(id, "Upload paused. Retry to continue from the saved part.") }
  }
  func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
    let done = backgroundCompletion; backgroundCompletion = nil; done?()
  }
}

@objc(AsideUpload)
class AsideUpload: NSObject {
  @objc static func requiresMainQueueSetup() -> Bool { true }
  @objc func start(_ id: String, base: String, token: String, uri: String, size: NSNumber, partSize: NSNumber, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      do { try AsideUploadManager.shared.start(id, base: base, token: token, uri: uri, size: size.intValue, partSize: partSize.intValue); resolve(nil) }
      catch { reject("upload_start", "Unable to prepare background upload", error) }
    }
  }
  @objc func status(_ id: String, resolve: @escaping RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock) {
    DispatchQueue.main.async { resolve(AsideUploadManager.shared.status(id)) }
  }
  @objc func cancel(_ id: String, resolve: @escaping RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock) {
    DispatchQueue.main.async { AsideUploadManager.shared.cancel(id) { resolve(nil) } }
  }
}
