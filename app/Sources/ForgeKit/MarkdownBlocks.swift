import Foundation

/// Block-level structure of a markdown document.
///
/// SwiftUI's `Text(AttributedString(markdown:))` handles **inline** markup
/// (`*bold*`, `` `code` ``, links) and nothing else: headings, lists, fences
/// and quotes come out as literal `##`, `-` and ``` characters. Item bodies in
/// this repo are multi-paragraph markdown with exactly those constructs, so the
/// detail sheet was showing raw source and calling it a body.
///
/// This splits the document into blocks; the view styles each one and uses
/// `AttributedString(markdown:)` for the inline layer inside them. Parsing lives
/// here, in ForgeKit, for the same reason every other rule in this milestone
/// does: the `Forge` target is not importable from a test target on this
/// machine, so anything decided in the view is verifiable only by looking at a
/// screen.
///
/// Deliberately **not** a full CommonMark implementation. It covers what item
/// bodies actually contain; anything it does not recognise degrades to a
/// paragraph, which renders as readable text rather than as an error.
public enum MarkdownBlock: Hashable {
    case heading(level: Int, text: String)
    case paragraph(String)
    /// Kept as one block rather than N paragraphs so the view can control the
    /// spacing between items and the indent of the whole list at once.
    case bullets([String])
    case numbered([String])
    case code(language: String?, text: String)
    case quote(String)
    case rule
}

public enum MarkdownDoc {
    /// Splits `source` into blocks, in document order.
    ///
    /// Fenced code is consumed first and verbatim — a `#` or `-` inside a fence
    /// is code, not a heading or a bullet, and treating it otherwise is the
    /// classic way a renderer mangles a diff pasted into an item body.
    public static func blocks(_ source: String) -> [MarkdownBlock] {
        var out: [MarkdownBlock] = []
        let lines = source.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        var i = 0
        var paragraph: [String] = []

        func flushParagraph() {
            let joined = paragraph.joined(separator: " ").trimmingCharacters(in: .whitespaces)
            if !joined.isEmpty { out.append(.paragraph(joined)) }
            paragraph = []
        }

        while i < lines.count {
            let raw = lines[i]
            let line = raw.trimmingCharacters(in: .whitespaces)

            // Fenced code — verbatim until the closing fence or end of input.
            if line.hasPrefix("```") {
                flushParagraph()
                let lang = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                var body: [String] = []
                i += 1
                while i < lines.count,
                      !lines[i].trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                    body.append(lines[i])
                    i += 1
                }
                i += 1  // consume the closing fence (no-op at end of input)
                out.append(.code(language: lang.isEmpty ? nil : lang,
                                 text: body.joined(separator: "\n")))
                continue
            }

            if line.isEmpty {
                flushParagraph()
                i += 1
                continue
            }

            // Thematic break, before the bullet check: `---` also starts with
            // a bullet marker character.
            if line == "---" || line == "***" || line == "___" {
                flushParagraph()
                out.append(.rule)
                i += 1
                continue
            }

            if line.hasPrefix("#") {
                let hashes = line.prefix { $0 == "#" }.count
                let rest = String(line.dropFirst(hashes)).trimmingCharacters(in: .whitespaces)
                // `#hashtag` is not a heading — ATX requires the space.
                if hashes <= 6, !rest.isEmpty, line.dropFirst(hashes).first == " " {
                    flushParagraph()
                    out.append(.heading(level: hashes, text: rest))
                    i += 1
                    continue
                }
            }

            if line.hasPrefix("> ") || line == ">" {
                flushParagraph()
                var body: [String] = []
                while i < lines.count {
                    let l = lines[i].trimmingCharacters(in: .whitespaces)
                    guard l.hasPrefix(">") else { break }
                    body.append(String(l.dropFirst()).trimmingCharacters(in: .whitespaces))
                    i += 1
                }
                out.append(.quote(body.joined(separator: " ").trimmingCharacters(in: .whitespaces)))
                continue
            }

            if let marker = bulletMarker(line) {
                flushParagraph()
                var items: [String] = []
                while i < lines.count {
                    let l = lines[i].trimmingCharacters(in: .whitespaces)
                    guard bulletMarker(l) != nil else { break }
                    items.append(String(l.dropFirst(marker.count)).trimmingCharacters(in: .whitespaces))
                    i += 1
                }
                out.append(.bullets(items))
                continue
            }

            if numberedPrefix(line) != nil {
                flushParagraph()
                var items: [String] = []
                while i < lines.count {
                    let l = lines[i].trimmingCharacters(in: .whitespaces)
                    guard let p = numberedPrefix(l) else { break }
                    items.append(String(l.dropFirst(p.count)).trimmingCharacters(in: .whitespaces))
                    i += 1
                }
                out.append(.numbered(items))
                continue
            }

            paragraph.append(line)
            i += 1
        }
        flushParagraph()
        return out
    }

    /// `- `, `* ` or `+ ` — the trailing space is required, so `*emphasis*` at
    /// the start of a line stays a paragraph instead of becoming a bullet.
    private static func bulletMarker(_ line: String) -> String? {
        for m in ["- ", "* ", "+ "] where line.hasPrefix(m) { return m }
        return nil
    }

    /// `12. ` — digits, a dot, a space.
    private static func numberedPrefix(_ line: String) -> String? {
        let digits = line.prefix { $0.isNumber }
        guard !digits.isEmpty else { return nil }
        let rest = line.dropFirst(digits.count)
        guard rest.hasPrefix(". ") else { return nil }
        return digits + ". "
    }
}
