import UIKit
import React

/// SDK 54's factory is retained by AppDelegate; UIKit's scene owns its window.
class AsideSceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
    guard let windowScene = scene as? UIWindowScene,
          let app = UIApplication.shared.delegate as? AppDelegate else { return }
    let window = UIWindow(windowScene: windowScene)
    self.window = window
    app.window = window
    app.reactNativeFactory?.startReactNative(withModuleName: "main", in: window, launchOptions: app.asideLaunchOptions)
    window.makeKeyAndVisible()
    if !options.urlContexts.isEmpty { self.scene(scene, openURLContexts: options.urlContexts) }
    for activity in options.userActivities { self.scene(scene, continue: activity) }
  }

  func scene(_ scene: UIScene, openURLContexts contexts: Set<UIOpenURLContext>) {
    guard let app = UIApplication.shared.delegate as? AppDelegate else { return }
    for context in contexts {
      var options: [UIApplication.OpenURLOptionsKey: Any] = [.openInPlace: context.options.openInPlace]
      if let source = context.options.sourceApplication { options[.sourceApplication] = source }
      if let annotation = context.options.annotation { options[.annotation] = annotation }
      _ = app.application(UIApplication.shared, open: context.url, options: options)
    }
  }

  func scene(_ scene: UIScene, continue activity: NSUserActivity) {
    guard let app = UIApplication.shared.delegate as? AppDelegate else { return }
    _ = app.application(UIApplication.shared, continue: activity, restorationHandler: { _ in })
  }
}
