# XD to HTML MCP for DeepSeek Harness

A self-contained DeepSeek Harness bundle for the repaired `adobe-xd-mcp` server. Package name: `xd-to-html-mcp-harness`; current version: `0.1.0`. The bundle includes the compiled server and declares its runtime dependencies; it does not require a separate global `npm install`.

## Install

Not published to npm yet, so install from the tagged release (no registry account needed):

```bash
dsh plugin add git+https://github.com/thelittleshyboy/xd-to-html-mcp.git#v0.1.0
```

Tag `v0.1.0` is the install target; the market index below pins the same release commit.

Or add this format-1 index source under Plugins → Discover and install from there:

```
https://raw.githubusercontent.com/thelittleshyboy/xd-to-html-mcp/main/market/index.json
```

To build a local archive instead, run `npm pack` in this package directory; the resulting `xd-to-html-mcp-harness-0.1.0.tgz` can be selected in the Harness bundle installer. The bundle adds the `adobe-xd-harness` MCP server to the current profile, so no separate global `npm install` is required.

## Plugin directory status

The bundle is listed through the community list `awesome-dsh-plugin/awesome-dsh-plugin` (PR #14590). Harness's **official** bundle catalog is installation-owned and generated at release time, so third-party packages cannot self-publish into it; see `OFFICIAL-CATALOG-SUBMISSION.md` for the maintainer-facing proposal.

Requires DeepSeek Harness with the MCP client package and Node.js 18+ available as `node` on `PATH`. Chrome or Edge is needed for PNG rendering and rasterized HTML slices. The bundle has no install/build scripts. The service is included in this package; its dependencies are installed by the normal package manager.

## Choose allowed XD folders

For safety, the MCP only reads files inside `XD_MCP_ROOTS`. The default is the profile directory. To allow your XD documents, set `ADOBE_XD_MCP_ROOTS` in the environment before launching Harness, or edit the `XD_MCP_ROOTS` value in the Adobe XD MCP server config to one or more absolute directories separated by the platform path separator. Do not point it at a broader location than needed.

The service is local-only and read-only. Design file text is returned to the connected AI, so only open trusted designs.

## Included capabilities

- Read `.xd` artboards, layers, text, styles, images, components, and prototype links.
- Render artboards and individual layers through a local Chrome/Edge browser.
- Export full-height HTML with selectable DOM text, transparent PNG graphics, component state transitions, hover/tap interactions, and artboard navigation.

The HTML exporter keeps the required `assets/` directory beside its HTML pages. Component state changes are opacity crossfades, not vector path morphs. Missing local design fonts fall back to installed system fonts. Some less common XD effects may not be represented exactly.

## Source and license

This bundle is maintained at [`thelittleshyboy/xd-to-html-mcp`](https://github.com/thelittleshyboy/xd-to-html-mcp) and contains modifications to the upstream [`srayan-uxd/adobe-xd-mcp`](https://github.com/srayan-uxd/adobe-xd-mcp), distributed under MIT. See `LICENSE` and `NOTICE.md` for attribution and terms. Harness integration and package metadata are maintained in this bundle.
