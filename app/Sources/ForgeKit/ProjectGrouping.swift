// ProjectGrouping — organising a flat list of workspaces into something that
// reflects how they actually sit on disk.
//
// A flat grid stops working around a dozen projects, and these nest: a monorepo
// holds services/ and apps/, each with its own .gsd/. Grouping by parent
// directory recovers that structure without the app inventing one.
//
// It also surfaces a real hazard. A .gsd/ created by accident at the top of a
// code folder swallows every project beneath it, and from a flat list that is
// invisible — it looks like one more project. Detecting containment is what
// makes it visible.

import Foundation

public enum ProjectGrouping: String, CaseIterable, Sendable {
    case flat = "Todos"
    case byFolder = "Por pasta"
}

public struct ProjectGroup: Identifiable, Hashable {
    /// Absolute parent directory.
    public let path: String
    /// Display form, home-relative.
    public let title: String
    public let projects: [String]

    public var id: String { path }

    public init(path: String, title: String, projects: [String]) {
        self.path = path
        self.title = title
        self.projects = projects
    }
}

public enum ProjectOrganiser {

    /// Group by immediate parent directory, parents sorted by path so nested
    /// folders read in a stable, hierarchy-like order.
    public static func groups(_ paths: [String], home: String? = nil) -> [ProjectGroup] {
        let base = home ?? FileManager.default.homeDirectoryForCurrentUser.path
        var buckets: [String: [String]] = [:]
        for p in paths {
            buckets[(p as NSString).deletingLastPathComponent, default: []].append(p)
        }
        return buckets
            .map { parent, kids in
                ProjectGroup(path: parent,
                             title: abbreviate(parent, home: base),
                             projects: kids.sorted { name($0) < name($1) })
            }
            .sorted { $0.path < $1.path }
    }

    /// Projects that contain other registered projects, mapped to how many.
    ///
    /// One containing nearly everything is almost always a stray .gsd/ at the
    /// top of a code directory rather than a real project — worth flagging,
    /// never worth removing automatically: a monorepo legitimately contains its
    /// own services.
    public static func containment(_ paths: [String]) -> [String: Int] {
        var counts: [String: Int] = [:]
        for parent in paths {
            let prefix = parent.hasSuffix("/") ? parent : parent + "/"
            let inside = paths.filter { $0 != parent && $0.hasPrefix(prefix) }
            if !inside.isEmpty { counts[parent] = inside.count }
        }
        return counts
    }

    /// The nearest registered project that contains `path`, if any.
    public static func container(of path: String, in paths: [String]) -> String? {
        paths
            .filter { $0 != path && path.hasPrefix($0.hasSuffix("/") ? $0 : $0 + "/") }
            // Nearest = longest matching prefix.
            .max { $0.count < $1.count }
    }

    public static func name(_ path: String) -> String {
        (path as NSString).lastPathComponent
    }

    public static func abbreviate(_ path: String, home: String) -> String {
        path.hasPrefix(home) ? "~" + String(path.dropFirst(home.count)) : path
    }
}
