# Official plugin directory submission

Status: the bundle is published as a public repository, installable from a format-1 market index, installed and health-checked in a real Harness profile, and submitted to the community plugin list. It is **not** in the installation-owned official bundle catalog, and it is **not** on npm (no registry credentials in this environment).

## Proposed bundle

- npm package name: `xd-to-html-mcp-harness` (registry lookup returned 404 when checked; not published)
- Current package version: `0.1.1`
- Bundle repository: https://github.com/thelittleshyboy/xd-to-html-mcp
- Source MCP: https://github.com/srayan-uxd/adobe-xd-mcp
- Proposed Harness repository change: `deepseek-ai/deepseek-harness`

## What is already verified

| Step | State | Evidence |
| --- | --- | --- |
| Public repository | done | `api.github.com/repos/thelittleshyboy/xd-to-html-mcp` returns 200 |
| Format-1 market index | done | `market/index.json`, 2637 bytes, passes `parseMarketIndex` |
| Index reachable over HTTPS | done | raw.githubusercontent.com returns 200 with cache-busting query; jsDelivr mirror also 200 |
| `dsh.bundle` manifest | done | `package.json` declares `dsh.bundle.patch: ./cordis.patch.yml` |
| DSH engine range | done | `engines.dsh: ">=0.2.2-0 <0.3.0"` (matches 0.2.2-rc.1; `*` would not) |
| Git install in real Harness | done | `plugin_manager install_bundle` from `#v0.1.1` → `xd-to-html-mcp-harness 0.1.1`, 101 packages |
| MCP handshake from installed package | done | 25 tools, `xd_ping` 0.1.1, selfTest true, 9 artboards |
| Discover index source registered | done | `cordis.patch.yml` entry `id: plugin-market`, applies on restart |
| Community list submission | open PR | https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/14590 |

The community PR's `check` job passed. The `Submission gate` job reports exactly one blocker: `repository is 0.1 days old (needs 1)`. The repository was created `2026-11-12T05:54:49Z`, so that gate clears at `2026-11-13T05:54:49Z`; it re-runs itself on a schedule, and resubmitting, pushing, or reopening the PR does not help.

## Important catalog constraint

Harness's official bundle list is installation-owned, not a user-extensible community index. The current `@deepseek-ai/dsh-official-bundles` documentation says official on-demand bundles are part of the DSH release family, and catalog metadata is generated from package-owned localized metadata and icon (`pnpm gen-official-bundle-catalog`, verified by `pnpm verify-official-bundle-catalog`). A third-party package cannot become Official by publishing to npm or by adding a local bundle.

An upstream maintainer must accept the package into the official release process (or ask for a DSH-owned package/repackaging). This proposal is a maintainer request, not a guaranteed catalog addition.

## Proposed PR checklist, subject to maintainer direction

1. Publish an immutable, reviewed npm version with LICENSE, NOTICE, localized metadata, icon, runtime code, and no install scripts.
2. Add the package to the appropriate official/optional/on-demand list in `packages/util/official-bundles/src/bundles.ts` only if maintainers accept a third-party integration and clarify release ownership.
3. Generate catalog metadata with `pnpm gen-official-bundle-catalog`; do not hand-edit `catalog.generated.ts`.
4. Run `pnpm verify-official-bundle-catalog` and the repository's relevant product-use checks.
5. Update any release-family dependency/version declarations required by the current repository policy.
6. Include the repository, license, privacy boundary, Node/browser requirements, and known fidelity limits in the PR description.

## Installing without npm

The index resolves to a pinned release commit, so no registry account is needed:

```bash
dsh plugin add git+https://github.com/thelittleshyboy/xd-to-html-mcp.git#v0.1.1
```

Or add the index source in Plugins → Discover:

```
https://raw.githubusercontent.com/thelittleshyboy/xd-to-html-mcp/main/market/index.json
```

## References

- Official bundle catalog: https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/util/official-bundles
- Catalog package README: https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/util/official-bundles/README.zh.md
- Bundle publishing guide: https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.zh.md
- Community list contribution rules: https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md
