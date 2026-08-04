# Vendored icon assets — where each file came from

Fetched **2026-08-03**. These files are checked in on purpose: the build must
never need the network, and a card that draws a brand mark must be able to draw
it on a machine that has been offline since it was cloned.

Every file is loaded as a **template image** (`NSImage.isTemplate = true`), so
only its alpha is used and the app's own tone/colour tokens do the tinting. The
brand `fill="#…"` attribute was therefore stripped from the Simple Icons files —
it is ignored at draw time anyway, and without it the file still renders
correctly (plain black) if template rendering is ever bypassed. Nothing else was
edited: no reshaping, no recolouring, no redrawing.

## Simple Icons — CC0 1.0 (public domain)

<https://github.com/simple-icons/simple-icons> · <https://creativecommons.org/publicdomain/zero/1.0/>

CC0 imposes no notice requirement, so there is no licence file to carry. The
provenance is recorded here anyway, so a future reader knows what these files are
and can re-fetch them.

| file | slug | source |
|---|---|---|
| `stack-next.svg` | `nextdotjs` | `https://cdn.simpleicons.org/nextdotjs` |
| `stack-node.svg` | `nodedotjs` | `https://cdn.simpleicons.org/nodedotjs` |
| `stack-swift.svg` | `swift` | `https://cdn.simpleicons.org/swift` |
| `stack-go.svg` | `go` | `https://cdn.simpleicons.org/go` |
| `stack-rust.svg` | `rust` | `https://cdn.simpleicons.org/rust` |
| `stack-python.svg` | `python` | `https://cdn.simpleicons.org/python` |
| `stack-docker.svg` | `docker` | `https://cdn.simpleicons.org/docker` |
| `host-github.svg` | `github` | `https://cdn.simpleicons.org/github` |
| `host-gitlab.svg` | `gitlab` | `https://cdn.simpleicons.org/gitlab` |
| `host-bitbucket.svg` | `bitbucket` | `https://cdn.simpleicons.org/bitbucket` |

## Octicons — MIT

<https://github.com/primer/octicons> · licence text in `LICENSE-octicons.txt`

MIT requires the notice to travel **with the copies**, which is why that file
sits next to the SVG rather than being linked from here.

| file | source |
|---|---|
| `git-branch.svg` | `https://raw.githubusercontent.com/primer/octicons/main/icons/git-branch-16.svg` |

## Re-fetching

Manual, deliberately — there is no build step that touches the network:

```sh
curl -o stack-go.svg https://cdn.simpleicons.org/go          # then strip fill="#…"
curl -o git-branch.svg https://raw.githubusercontent.com/primer/octicons/main/icons/git-branch-16.svg
```

## Trademark

A host's mark is drawn to say *this remote is hosted there*, which is nominative
use and is what these marks are for. It is never restyled or recoloured beyond
the template tint, and it is never drawn for a remote that was not measured to be
that host — see `BrandMark.swift`.
