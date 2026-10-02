import Foundation
import React

@objc(AsidePodcastInbox)
class AsidePodcastInbox: NSObject {
  @objc static func requiresMainQueueSetup() -> Bool { false }
  private func folder() throws -> URL {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "AsideAppGroup") as? String,
          let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else {
      throw NSError(domain: "AsidePodcastInbox", code: 1, userInfo: [NSLocalizedDescriptionKey: "Shared inbox unavailable"])
    }
    let folder = root.appendingPathComponent("PodcastInbox", isDirectory: true)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    return folder
  }
  @objc func list(_ resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock) {
    do {
      let urls = try FileManager.default.contentsOfDirectory(at: folder(), includingPropertiesForKeys: nil).filter { $0.pathExtension == "json" }.sorted { $0.lastPathComponent < $1.lastPathComponent }
      resolve(try urls.map { try JSONSerialization.jsonObject(with: Data(contentsOf: $0)) })
    } catch { reject("inbox", error.localizedDescription, error) }
  }
  @objc func remove(_ id: String, resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock) {
    guard UUID(uuidString: id) != nil else { reject("inbox", "Invalid inbox entry", nil); return }
    do {
      let file = try folder().appendingPathComponent(id + ".json")
      if FileManager.default.fileExists(atPath: file.path) { try FileManager.default.removeItem(at: file) }
      resolve(nil)
    } catch { reject("inbox", error.localizedDescription, error) }
  }
}
