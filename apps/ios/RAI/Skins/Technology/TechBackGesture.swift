#if os(iOS)
import SwiftUI
import UIKit

/// Scoped to a technology destination, never a global navigation-controller
/// swizzle. Restore UIKit's delegate on exit / cancellation / skin switches.
struct TechBackGesture: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> Controller { Controller() }
    func updateUIViewController(_ controller: Controller, context: Context) {
        if controller.view.window != nil { controller.install() }
    }
    static func dismantleUIViewController(_ controller: Controller, coordinator: ()) {
        controller.restore()
    }

    final class Controller: UIViewController, UIGestureRecognizerDelegate {
        private weak var recognizer: UIGestureRecognizer?
        private weak var previousDelegate: UIGestureRecognizerDelegate?
        private var wasEnabled = false
        override func loadView() {
            view = UIView()
            view.isUserInteractionEnabled = false
        }
        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            install()
        }
        override func viewWillDisappear(_ animated: Bool) {
            restore()
            super.viewWillDisappear(animated)
        }
        func install() {
            guard let navigationController, navigationController.viewControllers.count > 1,
                  let gesture = navigationController.interactivePopGestureRecognizer,
                  gesture.delegate !== self else { return }
            recognizer = gesture
            previousDelegate = gesture.delegate
            wasEnabled = gesture.isEnabled
            gesture.delegate = self
            gesture.isEnabled = true
        }
        func restore() {
            if let recognizer, recognizer.delegate === self {
                recognizer.delegate = previousDelegate
                recognizer.isEnabled = wasEnabled
            }
            recognizer = nil
            previousDelegate = nil
        }
        func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
            guard let navigationController else { return false }
            return navigationController.viewControllers.count > 1
                && navigationController.transitionCoordinator == nil
        }
    }
}
#endif
