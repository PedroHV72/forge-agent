// ProjectTree — the hierarchy the projects already have, drawn as one shape.
//
// `ProjectOrganiser.groups` buckets projects by their immediate parent
// directory. That is not the structure on disk: `lookchina`, `lookchina/apps`
// and `lookchina/services` come out as three unrelated headers, side by side,
// with nothing saying the last two live inside the first. The relation is
// transitive and the display was not, so a monorepo read as a flat pile of
// coincidentally-similar paths.
//
// This builds the transitive form instead. Two rules carry it:
//
//   - Ownership is *nearest project wins* — the relation `shared/forge-ownership.md`
//     pins and `ProjectOrganiser.container(of:in:)` already answers. A grandchild
//     hangs under its nearest project ancestor, never under the grandparent,
//     and never as its sibling at the top.
//   - Intermediate path components are synthesised as `folder` nodes **only**
//     between a node and a project descendant. A directory with no project
//     below it is not invented: the tree shows what the registry contains, it
//     does not go looking for structure to draw.
//
// Purity is deliberate and load-bearing. `home`, `projects` and `roots` are all
// parameters and nothing here touches the filesystem, because `ForgeKitTests`
// sees the real `$HOME` when launched by hand and an isolated one under
// `scripts/run-tests.js` — logic that read the environment could not be tested
// the same way twice.
//
// Containment itself is not recomputed here. `ProjectMarker.roles` (which
// counts through `ProjectOrganiser.containment`) is the holder of that relation;
// a second count living next to it would be a fourth copy of one rule.

import Foundation

/// One node of the derived hierarchy: a registered project, or a synthesised
/// `folder` standing for a path component between projects.
public struct ProjectTreeNode: Identifiable, Hashable, Sendable {
    /// Absolute path. Also the identity — two nodes for one directory is a bug,
    /// not a case to support.
    public let path: String
    /// Display form: home-relative at the top level, bare directory name below,
    /// where the ancestry is already on screen.
    public let title: String
    public let role: ProjectRole
    public let children: [ProjectTreeNode]
    /// Registrable descendants at **any** depth. The grandparent counts the
    /// grandchild — a count that stopped at the first level would restate the
    /// immediate-parent bug this file exists to remove.
    public let projectCount: Int

    public var id: String { path }

    public init(path: String,
                title: String,
                role: ProjectRole,
                children: [ProjectTreeNode],
                projectCount: Int) {
        self.path = path
        self.title = title
        self.role = role
        self.children = children
        self.projectCount = projectCount
    }
}

public enum ProjectTree {

    /// Build the forest.
    ///
    /// - Parameters:
    ///   - projects: absolute paths already classified as projects — what
    ///     `state.workspaces` holds. Order is irrelevant to the result.
    ///   - roots: declared scan roots. When non-empty, a top-level project that
    ///     sits under one hangs beneath it (nearest root wins); a root with no
    ///     project below it is not emitted. When empty, top-level projects are
    ///     the top of the forest.
    ///   - home: for display abbreviation. Never read from the environment.
    public static func build(projects: [String],
                             roots: [String] = [],
                             home: String) -> [ProjectTreeNode] {
        let all = normalise(projects)
        guard !all.isEmpty else { return [] }

        // The role of every project comes from the existing holder of the
        // containment relation, not from a count written here.
        let roles = ProjectMarker.roles(all)

        var childrenOf: [String: [String]] = [:]
        var tops: [String] = []
        for p in all {
            if let owner = ProjectOrganiser.container(of: p, in: all) {
                childrenOf[owner, default: []].append(p)
            } else {
                tops.append(p)
            }
        }

        // A root that is itself a registered project is already a project node;
        // emitting a folder for it too would double the directory.
        let declared = normalise(roots).filter { !all.contains($0) }

        var out: [ProjectTreeNode] = []
        var claimed = Set<String>()

        for root in declared {
            let mine = tops.filter { !claimed.contains($0) && nearestRoot(of: $0, in: declared) == root }
            guard !mine.isEmpty else { continue }   // no project below → not synthesised
            claimed.formUnion(mine)
            let kids = nodes(under: root,
                             projects: mine,
                             childrenOf: childrenOf,
                             roles: roles,
                             home: home)
            out.append(ProjectTreeNode(path: root,
                                       title: ProjectOrganiser.abbreviate(root, home: home),
                                       role: .folder,
                                       children: kids,
                                       projectCount: descendantCount(kids)))
        }

        for top in tops where !claimed.contains(top) {
            out.append(projectNode(top,
                                   title: ProjectOrganiser.abbreviate(top, home: home),
                                   childrenOf: childrenOf,
                                   roles: roles,
                                   home: home))
        }

        return sorted(out)
    }

    // MARK: - Construction

    /// Nodes for `projects` (all strict descendants of `base` whose nearest
    /// project ancestor is `base`'s owner), materialising the path components
    /// in between as `folder`s.
    private static func nodes(under base: String,
                              projects: [String],
                              childrenOf: [String: [String]],
                              roles: [String: ProjectRole],
                              home: String) -> [ProjectTreeNode] {
        var buckets: [String: [String]] = [:]
        for p in projects {
            let rel = segments(of: p, under: base)
            guard let head = rel.first else { continue }
            buckets[head, default: []].append(p)
        }

        var out: [ProjectTreeNode] = []
        for (segment, group) in buckets {
            let here = join(base, segment)
            if group.contains(here) {
                // The segment is the project itself. Anything deeper has `here`
                // as its nearest ancestor, so it arrives through childrenOf.
                out.append(projectNode(here,
                                       title: segment,
                                       childrenOf: childrenOf,
                                       roles: roles,
                                       home: home))
            } else {
                let kids = nodes(under: here,
                                 projects: group,
                                 childrenOf: childrenOf,
                                 roles: roles,
                                 home: home)
                out.append(ProjectTreeNode(path: here,
                                           title: segment,
                                           role: .folder,
                                           children: kids,
                                           projectCount: descendantCount(kids)))
            }
        }
        return sorted(out)
    }

    private static func projectNode(_ path: String,
                                    title: String,
                                    childrenOf: [String: [String]],
                                    roles: [String: ProjectRole],
                                    home: String) -> ProjectTreeNode {
        let kids = nodes(under: path,
                         projects: childrenOf[path] ?? [],
                         childrenOf: childrenOf,
                         roles: roles,
                         home: home)
        return ProjectTreeNode(path: path,
                               title: title,
                               role: roles[path] ?? .project,
                               children: kids,
                               projectCount: descendantCount(kids))
    }

    /// Registrable nodes below, transitively. Folders contribute their contents
    /// without counting themselves — they are not projects.
    private static func descendantCount(_ nodes: [ProjectTreeNode]) -> Int {
        nodes.reduce(0) { $0 + ($1.role.isRegistrable ? 1 : 0) + $1.projectCount }
    }

    // MARK: - Path helpers

    /// Siblings by name, path as the tiebreak. Deterministic on purpose: the
    /// tree must be a function of the set, never of the order it arrived in.
    private static func sorted(_ nodes: [ProjectTreeNode]) -> [ProjectTreeNode] {
        nodes.sorted {
            let a = ProjectOrganiser.name($0.path), b = ProjectOrganiser.name($1.path)
            return a == b ? $0.path < $1.path : a < b
        }
    }

    private static func normalise(_ paths: [String]) -> [String] {
        var seen = Set<String>()
        var out: [String] = []
        for raw in paths {
            var p = raw
            while p.count > 1 && p.hasSuffix("/") { p.removeLast() }
            guard !p.isEmpty, seen.insert(p).inserted else { continue }
            out.append(p)
        }
        return out.sorted()
    }

    private static func join(_ base: String, _ segment: String) -> String {
        (base.hasSuffix("/") ? base : base + "/") + segment
    }

    private static func segments(of child: String, under base: String) -> [String] {
        let prefix = base.hasSuffix("/") ? base : base + "/"
        guard child.hasPrefix(prefix) else { return [] }
        return child.dropFirst(prefix.count).split(separator: "/").map(String.init)
    }

    /// Longest declared root containing `path` — the same "nearest wins" rule
    /// ownership uses, so a root nested inside another does not steal its
    /// projects.
    private static func nearestRoot(of path: String, in roots: [String]) -> String? {
        roots
            .filter { path != $0 && path.hasPrefix($0.hasSuffix("/") ? $0 : $0 + "/") }
            .max { $0.count < $1.count }
    }
}
