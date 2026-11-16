# XD to HTML MCP for DeepSeek Harness

A self-contained DeepSeek Harness bundle for the repaired `adobe-xd-mcp` server. Package name: `xd-to-html-mcp-harness`; current version: `0.1.4`. The bundle includes the compiled server and declares its runtime dependencies; it does not require a separate global `npm install`.

## Install

Not published to npm yet, so install from the tagged release (no registry account needed):

```bash
dsh plugin add git+https://github.com/thelittleshyboy/xd-to-html-mcp.git#v0.1.4
```

Tag `v0.1.4` is the install target; the market index below pins the same release commit.

Or add this format-1 index source under Plugins → Discover and install from there:

```
https://raw.githubusercontent.com/thelittleshyboy/xd-to-html-mcp/main/market/index.json
```

To build a local archive instead, run `npm pack` in this package directory; the resulting `xd-to-html-mcp-harness-0.1.4.tgz` can be selected in the Harness bundle installer. The bundle adds the `xd-to-html-harness` MCP server to the current profile, so no separate global `npm install` is required.

## Plugin directory status

The bundle is listed through the community list `awesome-dsh-plugin/awesome-dsh-plugin` (PR #14590). Harness's **official** bundle catalog is installation-owned and generated at release time, so third-party packages cannot self-publish into it; see `OFFICIAL-CATALOG-SUBMISSION.md` for the maintainer-facing proposal.

Requires DeepSeek Harness with the MCP client package and Node.js 18+ available as `node` on `PATH`. Chrome or Edge is needed for PNG rendering and rasterized HTML slices. The bundle has no install/build scripts. The service is included in this package; its dependencies are installed by the normal package manager.

## Choose allowed XD folders

For safety, the MCP only reads files inside `XD_MCP_ROOTS`. The default is the profile directory. To allow your XD documents, set `ADOBE_XD_MCP_ROOTS` in the environment before launching Harness, or edit the `XD_MCP_ROOTS` value in the Adobe XD MCP server config to one or more absolute directories separated by the platform path separator. Do not point it at a broader location than needed.

The service is local-only and read-only. Design file text is returned to the connected AI, so only open trusted designs.

## Included capabilities

- Read `.xd` artboards, layers, text, styles, images, components, and prototype links.
- Render artboards and individual layers through a local Chrome/Edge browser.
- Export full-height HTML with DOM text, transparent PNG graphics, component state transitions, hover/tap interactions, and artboard navigation.

The HTML exporter keeps the required `assets/` directory beside its HTML pages. Before exporting each artboard, the tool returns a one-use destination request; provide an absolute parent directory and one folder name before files are written. Requests expire after 10 minutes and cannot be reused for another file or artboard. Component state changes use opacity crossfades and animate component size and state padding offsets; individual layer geometry and vector path morphs are not reproduced. Auto-height centered text uses its XD alignment offset. Text is emitted as DOM but ignores pointer events, so it is not mouse-selectable. Missing local design fonts fall back to installed system fonts. Some less common XD effects may not be represented exactly.

## Source and license

This bundle is maintained at [`thelittleshyboy/xd-to-html-mcp`](https://github.com/thelittleshyboy/xd-to-html-mcp) and contains modifications to the upstream [`srayan-uxd/adobe-xd-mcp`](https://github.com/srayan-uxd/adobe-xd-mcp), distributed under MIT. See `LICENSE` and `NOTICE.md` for attribution and terms. Harness integration and package metadata are maintained in this bundle.

[![M8ven Score](https://m8ven.ai/badge/mcp/thelittleshyboy-xd-to-html-mcp-tynhs2?v=a000461db77ddf3f4c0fccdf0a4adcb7)](https://m8ven.ai/mcp/thelittleshyboy-xd-to-html-mcp-tynhs2?s=readme)