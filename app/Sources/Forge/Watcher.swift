// Watcher — react to .gsd/ changing instead of asking every two seconds.
//
// The poll it replaces listed two directories per workspace every 2s. With the
// 21 projects on this machine that is ~1260 directory listings a minute, nearly
// all of them discovering that nothing changed. FSEvents inverts it: the kernel
// says when something happened, and idle costs nothing.
//
// A slow timer stays as a safety net, because FSEvents is not a hard guarantee:
// a stream can miss events under load, a volume can be remounted, and gate
// expiry is a clock event that no filesystem will ever report. Watching alone
// would silently stop updating; the two together degrade to the old behaviour
// at worst.

import Foundation
import CoreServices

final class Watcher {
    private var stream: FSEventStreamRef?
    private var paths: [String] = []
    private let onChange: () -> Void

    /// Coalesce bursts: writing a gate touches the directory several times in a
    /// row, and the UI only needs the final state.
    private let latency: CFTimeInterval = 0.25

    init(onChange: @escaping () -> Void) {
        self.onChange = onChange
    }

    deinit { stopStream() }

    /// Point the watcher at a new set of workspaces. No-op when unchanged, so
    /// callers can invoke it freely.
    func watch(_ workspaces: [String]) {
        let wanted = workspaces
            .map { "\($0)/.gsd" }
            .filter { FileManager.default.fileExists(atPath: $0) }
            .sorted()
        guard wanted != paths else { return }
        paths = wanted
        restart()
    }

    private func restart() {
        stopStream()
        guard !paths.isEmpty else { return }

        var context = FSEventStreamContext(
            version: 0,
            info: Unmanaged.passUnretained(self).toOpaque(),
            retain: nil, release: nil, copyDescription: nil)

        let callback: FSEventStreamCallback = { _, info, _, _, _, _ in
            guard let info else { return }
            let watcher = Unmanaged<Watcher>.fromOpaque(info).takeUnretainedValue()
            watcher.onChange()
        }

        guard let s = FSEventStreamCreate(
            kCFAllocatorDefault,
            callback,
            &context,
            paths as CFArray,
            FSEventStreamEventId(kFSEventStreamEventIdSinceNow),
            latency,
            // FileEvents reports individual files rather than just directories,
            // and NoDefer fires on the leading edge so the first change of a
            // burst is not delayed by the coalescing window.
            UInt32(kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagNoDefer)
        ) else { return }

        FSEventStreamSetDispatchQueue(s, DispatchQueue.main)
        FSEventStreamStart(s)
        stream = s
    }

    private func stopStream() {
        guard let s = stream else { return }
        FSEventStreamStop(s)
        FSEventStreamInvalidate(s)
        FSEventStreamRelease(s)
        stream = nil
    }
}
