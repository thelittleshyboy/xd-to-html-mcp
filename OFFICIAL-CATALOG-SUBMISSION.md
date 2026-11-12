# Official plugin directory submission

Status: bundle is installed in the local Harness profile from a tarball and its `xd_ping` health check passes. It has not been published to npm or submitted to the official catalog.

## Proposed bundle

- npm package: `xd-to-html-mcp-harness` (the registry lookup returned 404 when checked; not published; npm authentication is unavailable in this environment)
- Current package version: `0.1.0`
- Bundle repository: https://github.com/thelittleshyboy/xd-to-html-mcp
- Source MCP: https://github.com/srayan-uxd/adobe-xd-mcp
- Proposed Harness repository change: `deepseek-ai/deepseek-harness`

## Important catalog constraint

Harness's official bundle list is installation-owned, not a user-extensible community index. The current `@deepseek-ai/dsh-official-bundles` documentation says official on-demand bundles are part of the DSH release family and catalog metadata is generated from package-owned localized metadata and icon. A third-party package cannot make itself Official by publishing to npm or by adding a local bundle.

An upstream maintainer must accept the package into the official release process (or ask for a DSH-owned package/repackaging). This proposal should be treated as a maintainer request, not a guaranteed catalog addition.

## Proposed PR checklist, subject to maintainer direction

1. Publish an immutable, reviewed npm version with LICENSE, NOTICE, localized metadata, icon, runtime code, and no install scripts.
2. Add the package to the appropriate official/optional/on-demand list in `packages/util/official-bundles/src/bundles.ts` only if maintainers accept a third-party integration and clarify release ownership.
3. Generate catalog metadata with `pnpm gen-official-bundle-catalog`; do not hand-edit `catalog.generated.ts`.
4. Run `pnpm verify-official-bundle-catalog` and the repository's relevant product-use checks.
5. Update any release-family dependency/version declarations required by the current repository policy.
6. Include the repository, license, privacy boundary, Node/browser requirements, and known fidelity limits in the PR description.

## References

- Official bundle catalog: https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/util/official-bundles
- Catalog package README: https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/util/official-bundles/README.zh.md
- Bundle publishing guide: https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.zh.md
