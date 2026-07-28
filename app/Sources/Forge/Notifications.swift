// Notifications — answering a gate without opening the app.
//
// This is the capability the whole idea rested on: a headless run parks on a
// question, macOS shows it with the options AS BUTTONS, you click one, the run
// resumes. No window, no terminal.
//
// Why not the osascript notification the engine already sends: that one is
// posted by whatever process ran the AppleScript, so it carries the wrong icon
// and — decisively — cannot have action buttons. Only a real bundled app can
// register actionable categories, which is precisely what this app is for. The
// engine's own notification stays as the fallback for CLI-only setups.
//
// One category is registered per gate, because the buttons ARE that gate's
// options and no fixed category could describe them ahead of time.

import Foundation
import UserNotifications
import AppKit

@MainActor
final class Notifier: NSObject, ObservableObject {
    static let shared = Notifier()

    @Published private(set) var authorized = false
    @Published private(set) var denied = false

    /// Gates already announced. Without this the 2s poll would re-notify the
    /// same question every tick.
    private var announced: Set<String> = []

    private let center = UNUserNotificationCenter.current()

    func start() {
        center.delegate = self
        center.getNotificationSettings { [weak self] settings in
            Task { @MainActor in
                guard let self else { return }
                switch settings.authorizationStatus {
                case .authorized, .provisional:
                    self.authorized = true
                case .denied:
                    self.denied = true
                default:
                    self.request()
                }
            }
        }
    }

    func request() {
        center.requestAuthorization(options: [.alert, .sound]) { [weak self] granted, _ in
            Task { @MainActor in
                self?.authorized = granted
                self?.denied = !granted
            }
        }
    }

    /// Announce any gate not yet announced, and withdraw the ones that are gone.
    func sync(pending: [Gate]) {
        guard authorized else { return }

        let ids = Set(pending.map(\.id))
        let stale = announced.subtracting(ids)
        if !stale.isEmpty {
            // Answered elsewhere (window, CLI, another machine) or expired —
            // a notification for a question that no longer exists is a lie.
            center.removeDeliveredNotifications(withIdentifiers: Array(stale))
            announced.subtract(stale)
        }

        for gate in pending where !announced.contains(gate.id) {
            announced.insert(gate.id)
            post(gate)
        }
    }

    private func post(_ gate: Gate) {
        // macOS shows the first two actions inline and folds the rest into a
        // menu, so the order matters: keep the gate's own order, which puts the
        // conservative default last by convention.
        let actions = gate.options.prefix(4).map { opt in
            UNNotificationAction(identifier: opt.key, title: opt.label, options: [])
        }
        let categoryID = "gate.\(gate.id)"
        let category = UNNotificationCategory(
            identifier: categoryID,
            actions: Array(actions),
            intentIdentifiers: [],
            options: [])

        // Replace the whole set each time: categories are global, and leaving
        // dead ones registered grows without bound across a long session.
        var categories: Set<UNNotificationCategory> = [category]
        center.getNotificationCategories { existing in
            categories.formUnion(existing.filter { $0.identifier != categoryID })
            self.center.setNotificationCategories(categories)

            let content = UNMutableNotificationContent()
            content.title = "Forge precisa de você"
            content.subtitle = [gate.projectName, gate.subtitle]
                .filter { !$0.isEmpty }.joined(separator: " · ")
            content.body = gate.question
            content.sound = .default
            content.categoryIdentifier = categoryID
            content.userInfo = ["gate": gate.id, "cwd": gate.cwd ?? ""]

            let request = UNNotificationRequest(
                identifier: gate.id, content: content, trigger: nil)
            self.center.add(request)
        }
    }

    /// Forget a gate so a later one with the same id could be announced again.
    func forget(_ id: String) {
        announced.remove(id)
        center.removeDeliveredNotifications(withIdentifiers: [id])
    }
}

extension Notifier: UNUserNotificationCenterDelegate {
    /// Show the banner even when the app is frontmost. The point is answering
    /// without switching windows, and suppressing it while focused would make
    /// the feature look broken exactly when someone is testing it.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound, .list])
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let info = response.notification.request.content.userInfo
        let gateID = info["gate"] as? String ?? ""
        let cwd = info["cwd"] as? String ?? ""
        let action = response.actionIdentifier

        Task { @MainActor in
            defer { completionHandler() }
            guard !gateID.isEmpty else { return }

            switch action {
            case UNNotificationDefaultActionIdentifier:
                // Tapping the body opens the app rather than guessing a choice.
                NSApp.activate(ignoringOtherApps: true)
                for w in NSApp.windows where w.canBecomeMain {
                    w.makeKeyAndOrderFront(nil); break
                }
            case UNNotificationDismissActionIdentifier:
                // Dismissing is not answering — the gate stays pending and will
                // still take its default if nobody acts.
                break
            default:
                guard !cwd.isEmpty else { return }
                AppState.shared.answer(gateID: gateID, cwd: cwd, choice: action)
            }
        }
    }
}
