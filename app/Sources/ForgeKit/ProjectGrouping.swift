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
    /// Containment alone is *not* a defect — it is the definition of a
    /// workspace (`ProjectRole.workspace`). Which of these counts is worth
    /// flagging is `containmentHazards`' question, not this one's; this
    /// function reports the relation and takes no view of it.
    public static func containment(_ paths: [String]) -> [String: Int] {
        var counts: [String: Int] = [:]
        for parent in paths {
            let prefix = parent.hasSuffix("/") ? parent : parent + "/"
            let inside = paths.filter { $0 != parent && $0.hasPrefix(prefix) }
            if !inside.isEmpty { counts[parent] = inside.count }
        }
        return counts
    }

    /// A containment count worth putting in front of the operator.
    public struct ContainmentHazard: Equatable, Sendable {
        public let path: String
        public let count: Int
        public init(path: String, count: Int) {
            self.path = path
            self.count = count
        }
    }

    /// Registered directories that swallow much of the list *without having been
    /// declared a workspace*.
    ///
    /// The original hazard is real and still fires: a `.gsd/` created by
    /// accident at the top of a code folder (there was one at `~/Development`,
    /// above every real project) enrols everything beneath it, and from a flat
    /// list that is invisible.
    ///
    /// What changed is that containment stopped being sufficient evidence of an
    /// accident. A workspace *is* a project that contains other projects — that
    /// is `ProjectRole.workspace`, and promoting one is a thing the operator
    /// does on purpose. So the derived role cannot discriminate here (it calls
    /// every container a workspace, which would silence the hazard entirely);
    /// the *declared* `kind` in the registry can, because it is written only by
    /// a deliberate promotion, while anything the app enrols on its own is
    /// written `kind: project`. Passing `declaredWorkspaces: []` therefore
    /// restores the pre-workspace behaviour exactly, which is what a legacy
    /// registry — having no `kind` field to declare — gets.
    ///
    /// Advisory only. Nothing is removed automatically: a monorepo legitimately
    /// contains its own services, and a wrong call here must cost a glance, not
    /// a project.
    public static func containmentHazards(
        _ paths: [String],
        declaredWorkspaces: Set<String> = []
    ) -> [ContainmentHazard] {
        let threshold = max(3, paths.count / 2)
        return containment(paths)
            .filter { $0.value >= threshold && !declaredWorkspaces.contains($0.key) }
            .map { ContainmentHazard(path: $0.key, count: $0.value) }
            // Path breaks ties so the notice does not reshuffle between reloads
            // over a dictionary's ordering.
            .sorted { $0.count != $1.count ? $0.count > $1.count : $0.path < $1.path }
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

/// Type-to-search over the registered project paths.
public enum ProjectFilter {
    /// Paths whose display name **or** full path contains `query`, case- and
    /// diacritic-insensitively, preserving the input order.
    ///
    /// Both fields on purpose: the operator sees the short name in the picker
    /// but often remembers where a project lives (`~/work/…`), and a filter
    /// that only matched the visible label would fail exactly the person who
    /// typed the thing they were looking at in Finder.
    ///
    /// An empty or whitespace-only query returns everything rather than
    /// nothing — an empty search box means "no filter", never "no results".
    public static func matches(_ paths: [String], query: String) -> [String] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return paths }
        return paths.filter { path in
            fold(ProjectOrganiser.name(path)).contains(fold(q)) || fold(path).contains(fold(q))
        }
    }

    /// Case- and diacritic-insensitive comparison key. `Métricas` has to match
    /// `metricas`: this UI is in Portuguese and nobody types the accents into a
    /// search box.
    private static func fold(_ s: String) -> String {
        s.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
    }
}
