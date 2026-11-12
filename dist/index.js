#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { openXd, assertInsideRoots, resolveArtboard, artboardTree, extractTexts, designTokens, interactions, readJson, jsonPath, readEntry, own, } from "./xd.js";
import { renderArtboard, layersToSvg } from "./render.js";
import { exportHtml } from "./html.js";
import { fontReport } from "./fonts.js";
import { inferLayout, addSuggestedNames } from "./layout.js";
import { ping, VERSION } from "./health.js";
import { designSystem, audit, findLayers, copyDeck, flowMap, projectOverview } from "./insights.js";
import { exportArtboard, exportComponent, listComponents, sharedAssets, artboardGeometry } from "./export.js";
const server = new McpServer({ name: "adobe-xd-mcp", version: VERSION });
const file = z.string().describe("Absolute path to a .xd file");
const MAX_OUT = 400_000;
const text = (v, max = MAX_OUT) => {
    const s = typeof v === "string" ? v : JSON.stringify(v, null, 2);
    return {
        content: [
            { type: "text", text: s.length > max ? s.slice(0, max) + `
… output truncated (${s.length} chars)` : s },
        ],
    };
};
const MAX_EXPORT_OUT = 1_500_000; // one export page; pages are cut at 300k chars unless a single layer is bigger
const fail = (e) => ({
    isError: true,
    content: [
        {
            type: "text",
            text: e instanceof TypeError || e instanceof RangeError
                ? `The file contains data this server doesn't understand, so it couldn't be processed (${e.message}).`
                : e instanceof Error
                    ? e.message
                    : String(e),
        },
    ],
});
const guard = (fn) => async (a) => {
    try {
        return await fn(a);
    }
    catch (e) {
        return fail(e);
    }
};
server.registerTool("xd_list_artboards", {
    description: "List the artboards in an Adobe XD file with their ids and names, plus document name. Set includeGeometry to also get each artboard's canvas position and size (slower on big files).",
    inputSchema: { file, includeGeometry: z.boolean().default(false) },
}, guard(async ({ file, includeGeometry }) => {
    const doc = await openXd(file);
    const geo = includeGeometry ? await artboardGeometry(doc) : {};
    const artboards = [];
    for (const { id, name, path: p } of doc.artboards) {
        const g = includeGeometry ? own(geo, (await readJson(doc, p))?.children?.[0]?.artboard?.ref) : undefined;
        artboards.push({ id, name, ...(g && { x: g.x, y: g.y, width: g.width, height: g.height }) });
    }
    return text({ name: doc.manifest?.name, artboardCount: artboards.length, artboards });
}));
server.registerTool("xd_get_artboard", {
    description: "Get the layer tree of one artboard (positions, sizes, fills, strokes, text, fonts). Match by id or name (partial ok).",
    inputSchema: {
        file,
        artboard: z.string().describe("Artboard id or name"),
        depth: z.number().int().min(0).max(20).default(6).describe("Max nesting depth to expand"),
    },
}, guard(async ({ file, artboard, depth }) => {
    const doc = await openXd(file);
    const ab = resolveArtboard(doc, artboard);
    return text({ artboard: { id: ab.id, name: ab.name }, layers: await artboardTree(doc, ab, depth ?? 6) });
}));
server.registerTool("xd_extract_text", {
    description: "Extract all text content from one artboard, or from every artboard if none is given.",
    inputSchema: { file, artboard: z.string().optional().describe("Artboard id or name; omit for all") },
}, guard(async ({ file, artboard }) => {
    const doc = await openXd(file);
    const abs = artboard ? [resolveArtboard(doc, artboard)] : doc.artboards;
    const result = {};
    for (const ab of abs)
        result[ab.name] = await extractTexts(doc, ab);
    return text(result);
}));
server.registerTool("xd_get_design_tokens", {
    description: "Summarize colors and fonts used across the document (by frequency), plus shared styles if present.",
    inputSchema: { file },
}, guard(async ({ file }) => text(await designTokens(await openXd(file)))));
server.registerTool("xd_get_interactions", {
    description: "Return prototype interactions / flows (interactions.json) if the file has any.",
    inputSchema: { file },
}, guard(async ({ file }) => text((await interactions(await openXd(file))) ?? "No interactions found.")));
server.registerTool("xd_list_entries", {
    description: "List every file inside the XD archive (for debugging / finding raw data).",
    inputSchema: { file },
}, guard(async ({ file }) => text((await openXd(file)).entries)));
server.registerTool("xd_read_raw", {
    description: "Read a raw JSON entry from the archive (e.g. manifest, an artboard's graphicContent.agc), optionally drilling in with a dotted path like children.0.artboard.children.2. Output is truncated to maxChars.",
    inputSchema: {
        file,
        entry: z.string().describe("Archive path, e.g. 'manifest' or 'artwork/artboard-xxx/graphics/graphicContent.agc'"),
        path: z.string().default("").describe("Optional dotted path into the JSON"),
        maxChars: z.number().int().min(100).max(200000).default(20000),
    },
}, guard(async ({ file, entry, path: p, maxChars }) => {
    const doc = await openXd(file);
    const v = jsonPath(await readJson(doc, entry), p ?? "");
    const s = JSON.stringify(v, null, 2) ?? "undefined";
    const max = maxChars ?? 20000;
    return text(s.length > max ? s.slice(0, max) + `\n… truncated (${s.length} chars total)` : s);
}));
server.registerTool("xd_get_preview", {
    description: "Return the embedded preview image of the XD file (first artboard render).",
    inputSchema: { file },
}, guard(async ({ file }) => {
    const doc = await openXd(file);
    const name = ["preview.png", "thumbnail.png"].find((n) => doc.zip.file(n));
    if (!name)
        return fail("No preview image in this file.");
    const data = (await readEntry(doc, name, 20 * 1024 * 1024)).toString("base64");
    return { content: [{ type: "image", data, mimeType: "image/png" }] };
}));
server.registerTool("xd_extract_assets", {
    description: "Extract embedded images/resources from the XD file into an output directory.",
    inputSchema: { file, outDir: z.string().describe("Absolute directory to write assets into") },
}, guard(async ({ file, outDir }) => {
    const doc = await openXd(file);
    const safeOut = await assertInsideRoots(outDir);
    await mkdir(safeOut, { recursive: true });
    const written = [];
    for (const e of doc.entries) {
        if (!e.startsWith("resources/") || e.endsWith(".agc") || e.endsWith(".json"))
            continue;
        const buf = await readEntry(doc, e);
        const ext = sniffExt(buf);
        // Fixed prefix + sanitized name: no traversal, no Windows device names (CON, NUL, ...), no ADS (a:b).
        const base = path.basename(e).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
        const dest = path.join(safeOut, `asset-${written.length}-${base}${ext}`);
        await writeFile(dest, buf, { flag: "wx" }); // never overwrite, never follow a planted symlink
        written.push(dest);
    }
    return text({ count: written.length, files: written });
}));
/** Write the embedded images with these uids as <uid>.<ext>; never overwrites or follows symlinks. */
async function saveImages(doc, uids, outDir) {
    const safeOut = await assertInsideRoots(outDir);
    await mkdir(safeOut, { recursive: true });
    const files = {};
    for (const uid of uids) {
        if (!/^[0-9a-f]{16,64}$/i.test(uid))
            continue; // only hash-like ids become file names
        if (!doc.zip.file(`resources/${uid}`))
            continue;
        const buf = await readEntry(doc, `resources/${uid}`);
        const dest = path.join(safeOut, uid + sniffExt(buf));
        try {
            await writeFile(dest, buf, { flag: "wx" });
        }
        catch (e) {
            if (e?.code !== "EEXIST")
                throw e; // already extracted earlier
        }
        files[uid] = dest;
    }
    return files;
}
function sniffExt(b) {
    if (b.subarray(0, 4).toString("hex") === "89504e47")
        return ".png";
    if (b.subarray(0, 3).toString("hex") === "ffd8ff")
        return ".jpg";
    if (b.subarray(0, 3).toString("ascii") === "GIF")
        return ".gif";
    if (b.subarray(0, 4).toString("ascii") === "RIFF")
        return ".webp";
    if (b.subarray(0, 300).toString("utf8").includes("<svg"))
        return ".svg";
    return "";
}
const exportInput = {
    file,
    depth: z.number().int().min(1).max(64).optional().describe("Max nesting depth (default: everything). Layers below the limit are marked truncated:true; nothing is ever cut silently."),
    page: z.number().int().min(0).max(1000).default(0).describe("Page of a large export (see pageCount / hasMore in the result)."),
    semanticNames: z.boolean().default(false).describe("Add suggestedName to every layer (numeric suffixes stripped, text-based names)."),
    assetsDir: z
        .string()
        .optional()
        .describe("Optional absolute folder (inside the allowed roots). Referenced images are saved there as <imageRef>.<ext>."),
};
server.registerTool("xd_export_artboard", {
    description: "Full-fidelity export of one artboard (or a sub-layer via nodeId) as clean JSON for rebuilding the design in another tool such as Figma: frames, rectangles (with corner radius), ellipses, lines, vector paths (SVG path data), boolean shapes, text (font, size, styled runs), fills (solid/gradient/image), strokes, shadows/effects, opacity, rotation, constraints, components, repeat grids and layout grids. Linked components (syncRef) are resolved to their real content. Text is normalised (top-left box, baselineY, line breaks as \n, alignment, autoResize, underline runs). The full transform matrix is given with transformOrigin top-left. Positions are relative to the parent; masks are in the masked group's local space. Images are referenced by imageRef; pass assetsDir to save them. Big screens are split into pages (page / pageCount / hasMore); each page lists whole top-level layers. Use nodeId to drill into one layer.",
    inputSchema: {
        ...exportInput,
        artboard: z.string().describe("Artboard id or name"),
        nodeId: z.string().optional().describe("Export only this layer id (from a previous export)"),
    },
}, guard(async ({ file, artboard, nodeId, depth, assetsDir, page, semanticNames }) => {
    const doc = await openXd(file);
    const ab = resolveArtboard(doc, artboard);
    if (assetsDir)
        await assertInsideRoots(assetsDir); // fail fast before doing any work
    const r = await exportArtboard(doc, ab, { nodeId, depth, page });
    if (semanticNames)
        addSuggestedNames(r.node);
    const images = assetsDir ? await saveImages(doc, r.images, assetsDir) : undefined;
    return text(JSON.stringify({ artboard: { id: ab.id, name: ab.name }, page: r.page, pageCount: r.pageCount, hasMore: r.hasMore, truncated: r.truncated, oversized: r.oversized, syncRefs: r.syncRefs, fonts: r.fonts, imageRefs: r.images, images, node: r.node }), MAX_EXPORT_OUT);
}));
server.registerTool("xd_render_artboard", {
    description: "Render one artboard (or one layer via nodeId) to a PNG so you can SEE the result and verify a rebuild. Renders the full-fidelity export (linked components, masks, gradients, images, shadows, text) as one SVG and screenshots it in a local headless Chrome/Edge. Set XD_MCP_CHROME if the browser isn't found automatically. Nothing is uploaded.",
    inputSchema: {
        file,
        artboard: z.string().describe("Artboard id or name"),
        nodeId: z.string().optional().describe("Render only this layer id"),
        scale: z.number().min(0.05).max(4).default(1).describe("Pixel scale; automatically reduced so the longest edge stays within maxEdge"),
        maxEdge: z.number().int().min(200).max(8192).default(2400).describe("Longest allowed output edge in pixels"),
    },
}, guard(async ({ file, artboard, nodeId, scale, maxEdge }) => {
    const doc = await openXd(file);
    const ab = resolveArtboard(doc, artboard);
    const r = await renderArtboard(doc, ab, { nodeId, scale, maxEdge });
    return {
        content: [
            { type: "image", data: r.png.toString("base64"), mimeType: "image/png" },
            { type: "text", text: JSON.stringify({ artboard: ab.name, width: r.width, height: r.height, scale: r.scale, browser: r.browser, missingImages: r.missingImages }) },
        ],
    };
}));
server.registerTool("xd_infer_layout", {
    description: "Phase 2 of a conversion: from the exact export of a screen, propose frames with AUTO-LAYOUT intent. Clusters layers into cards by containment, detects rows/columns and header-style space-between rows, derives item spacing (median gap) and padding (rounded to a grid), marks equal-width cards and full-width text as FILL, keeps illustrations/photos/masked or rotated groups as fixed leaves, puts overlapping decorations in absoluteChildren, turns centred-label rectangles into buttons, and suggests semantic layer names. Leaves reference the exact layers by ref. Returns a drift report (pixelDeltaEstimate, within3px, within5px, elementsAbsolute, elementsAutoLayout) so you know how far the auto-layout version moves things. A heuristic proposal: rebuild it beside the exact copy and compare with xd_render_artboard.",
    inputSchema: {
        file,
        artboard: z.string().describe("Artboard id or name"),
        nodeId: z.string().optional().describe("Analyse only this layer"),
        grid: z.number().min(1).max(16).default(4).describe("Round spacing and padding to this grid (px)"),
        tolerance: z.number().min(1).max(40).default(8).describe("Pixels within which items count as the same row or column"),
        illustrationMinParts: z.number().int().min(2).max(500).default(20).describe("A group with more vector parts than this is kept as ONE illustration"),
        iconMaxSize: z.number().min(8).max(300).default(64).describe("A small group up to this many px (no text) is kept as ONE icon"),
        mergeLoose: z.boolean().default(true).describe("Merge loose, overlapping vector pieces that were never grouped in XD into one illustration or icon"),
        looseMinParts: z.number().int().min(2).max(100).default(3).describe("Minimum number of pieces for that merge"),
        maxDrift: z.number().min(0).max(200).default(10).describe("Frames whose auto-layout would move something more than this many px keep exact positions instead (0 = never fall back)"),
    },
}, guard(async ({ file, artboard, nodeId, grid, tolerance, maxDrift, illustrationMinParts, iconMaxSize, mergeLoose, looseMinParts }) => {
    const doc = await openXd(file);
    return text(JSON.stringify(await inferLayout(doc, resolveArtboard(doc, artboard), { nodeId, grid, tolerance, maxDrift, illustrationMinParts, iconMaxSize, mergeLoose, looseMinParts })), MAX_EXPORT_OUT);
}));
server.registerTool("xd_export_svg", {
    description: "Export one or more layers as ONE self-contained SVG (vectors, gradients, shadows, masks and images embedded), so an illustration, icon or any drawing can be imported into Figma as a single vector instead of dozens of pieces. Pass the layer ids of a group, or the `parts` of a merged drawing from xd_infer_layout. Only the selected layers are drawn (no page background). Use saveTo to write the SVG to a folder inside the allowed roots; otherwise it is returned inline (up to 600k characters).",
    inputSchema: {
        file,
        artboard: z.string().describe("Artboard id or name"),
        ids: z.array(z.string().min(1).max(200)).min(1).max(500).describe("Layer ids from xd_export_artboard, or the parts list of a merged drawing"),
        padding: z.number().min(0).max(50).default(2).describe("Extra pixels around the drawing"),
        saveTo: z.string().optional().describe("Optional absolute folder (inside the allowed roots); the SVG is saved there and its path returned"),
    },
}, guard(async ({ file, artboard, ids, padding, saveTo }) => {
    const doc = await openXd(file);
    const ab = resolveArtboard(doc, artboard);
    const dir = saveTo ? await assertInsideRoots(saveTo) : undefined; // fail fast, before rendering
    const r = await layersToSvg(doc, ab, ids, padding ?? 2);
    const meta = { width: r.width, height: r.height, layers: r.found.length, missingIds: r.missing, missingImages: r.missingImages, bytes: r.svg.length };
    if (dir) {
        await mkdir(dir, { recursive: true });
        const base = "layers-" + String(r.found[0] ?? "svg").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40);
        for (let n = 0; n < 100; n++) {
            const dest = path.join(dir, `${base}${n ? "-" + n : ""}.svg`);
            try {
                await writeFile(dest, r.svg, { encoding: "utf8", flag: "wx" }); // never overwrite, never follow a planted symlink
                return text(JSON.stringify({ ...meta, savedTo: dest }));
            }
            catch (e) {
                if (e?.code !== "EEXIST")
                    throw e;
            }
        }
        throw new Error("Too many files with this name already exist in that folder.");
    }
    if (r.svg.length > 600_000)
        throw new Error(`The SVG is ${r.svg.length} characters (images are embedded). Use saveTo to write it to a folder instead.`);
    return text(JSON.stringify({ ...meta, svg: r.svg }), MAX_EXPORT_OUT);
}));
server.registerTool("xd_export_html", {
    description: "Export a complete artboard as HTML with ordinary selectable DOM text and separate transparent PNG graphics/background slices. Requires local Chrome/Edge. Reads XD component hover/tap states, duration/easing and artboard links; state changes use opacity transitions (no vector morphing). Returns HTML path, asset paths, dimensions, interaction counts, warnings, fonts and missing images. Keep the assets folder with the HTML and export linked artboards into the same folder.",
    inputSchema: {
        file,
        artboard: z.string().describe("Artboard id or name"),
        saveTo: z.string().describe("Absolute output folder inside the allowed roots; existing exports are preserved"),
    },
}, guard(async ({ file, artboard, saveTo }) => {
    const doc = await openXd(file);
    return text(await exportHtml(doc, resolveArtboard(doc, artboard), saveTo));
}));
server.registerTool("xd_font_report", {
    description: "Fonts used by the file (or one artboard): family, weights/styles, sizes, how often, whether each family is installed on this computer, a substitution table for missing weights (e.g. Medium -> Regular), and a licence note. Run this before rebuilding a design elsewhere and warn the user about missing fonts. Only reads font names; never creates or alters fonts.",
    inputSchema: { file, artboard: z.string().optional().describe("Artboard id or name; omit for the whole file") },
}, guard(async ({ file, artboard }) => {
    const doc = await openXd(file);
    return text(await fontReport(doc, artboard ? resolveArtboard(doc, artboard) : undefined));
}));
server.registerTool("xd_ping", {
    description: "Health check: server version, allowed folders, Node and platform, whether a browser for xd_render_artboard was found, and a built-in self-test of the parser and exporter. Pass a file to also check that it opens.",
    inputSchema: { file: z.string().optional().describe("Optional .xd file to test-open") },
}, guard(async ({ file }) => text(await ping(file))));
server.registerTool("xd_list_components", {
    description: "List the reusable components (symbols) defined in the file: id, name, size.",
    inputSchema: { file },
}, guard(async ({ file }) => text(await listComponents(await openXd(file)))));
server.registerTool("xd_export_component", {
    description: "Export one component master (see xd_list_components) in the same format as xd_export_artboard.",
    inputSchema: { ...exportInput, component: z.string().describe("symbolId or component name") },
}, guard(async ({ file, component, depth, assetsDir }) => {
    const doc = await openXd(file);
    if (assetsDir)
        await assertInsideRoots(assetsDir);
    const r = await exportComponent(doc, component, { depth });
    const images = assetsDir ? await saveImages(doc, r.images, assetsDir) : undefined;
    return text(JSON.stringify({ truncated: r.truncated, syncRefs: r.syncRefs, fonts: r.fonts, imageRefs: r.images, images, node: r.node }), MAX_EXPORT_OUT);
}));
server.registerTool("xd_get_shared_assets", {
    description: "Document-level libraries: saved color swatches, library colors and character (text) styles.",
    inputSchema: { file },
}, guard(async ({ file }) => text(await sharedAssets(await openXd(file)))));
const optionalArtboard = z.string().optional().describe("Artboard id or name; omit for the whole file");
const pick = async (doc, a) => (a ? resolveArtboard(doc, a) : undefined);
server.registerTool("xd_get_design_system", {
    description: "Extract the design system actually used in the file: color palette (ranked, with fill/text/stroke usage), typography styles and size scale, corner radii, stroke widths and shadows. Output as json, css (custom properties), tailwind (theme.extend) or figma-variables (variable collections, text styles named by role and effect styles, ready to create in Figma).",
    inputSchema: { file, format: z.enum(["json", "css", "tailwind", "figma-variables"]).default("json") },
}, guard(async ({ file, format }) => text(await designSystem(await openXd(file), format ?? "json"))));
server.registerTool("xd_audit_design", {
    description: "Design QA. Checks text contrast (WCAG, background estimated), tiny text, small tap targets on interactive layers, placeholder text, near-duplicate colors, too many fonts/sizes and default layer names. Returns findings with artboard and layer ids plus per-check totals.",
    inputSchema: {
        file,
        artboard: optionalArtboard,
        minTapTarget: z.number().min(1).max(200).default(44),
        minFontSize: z.number().min(1).max(100).default(11),
        maxPerCheck: z.number().int().min(1).max(500).default(25),
    },
}, guard(async ({ file, artboard, minTapTarget, minFontSize, maxPerCheck }) => {
    const doc = await openXd(file);
    return text(await audit(doc, await pick(doc, artboard), { minTapTarget, minFontSize, maxPerCheck }));
}));
server.registerTool("xd_find_layers", {
    description: "Search layers across the file by text content, layer name, type (text, rectangle, ellipse, path, group, ...) or color (#rrggbb, matched with a small tolerance).",
    inputSchema: {
        file,
        text: z.string().optional(),
        name: z.string().optional(),
        type: z.string().optional(),
        color: z.string().optional().describe("#rrggbb"),
        artboard: optionalArtboard,
        limit: z.number().int().min(1).max(500).default(50),
    },
}, guard(async ({ file, artboard, ...q }) => {
    const doc = await openXd(file);
    return text(await findLayers(doc, { ...q, artboard: await pick(doc, artboard) }));
}));
server.registerTool("xd_export_copy", {
    description: "Export all text content (a copy deck) for translation or review, as json or csv. CSV cells are protected against spreadsheet formula injection.",
    inputSchema: { file, artboard: optionalArtboard, format: z.enum(["json", "csv"]).default("json") },
}, guard(async ({ file, artboard, format }) => {
    const doc = await openXd(file);
    return text(await copyDeck(doc, await pick(doc, artboard), format ?? "json"));
}));
server.registerTool("xd_get_flow", {
    description: "Prototype flow map: every interaction (tap/hover/time triggers, transitions, destinations) with source screen and layer, the home screen, and a Mermaid flowchart of screen-to-screen links.",
    inputSchema: { file },
}, guard(async ({ file }) => text(await flowMap(await openXd(file)))));
server.registerTool("xd_project_overview", {
    description: "Scan a folder (inside the allowed roots) for .xd files and summarize each: name, size, artboard and component counts, whether it has a prototype. Searches up to 3 levels deep, max 60 files.",
    inputSchema: { folder: z.string().describe("Absolute folder path") },
}, guard(async ({ folder }) => text(await projectOverview(folder))));
/* Ready-made prompts: shown as one-click starters in clients that support MCP prompts. */
const promptArgs = { file: z.string().describe("Absolute path to the .xd file"), artboard: z.string().describe("Artboard name") };
const userPrompt = (t) => ({ messages: [{ role: "user", content: { type: "text", text: t } }] });
server.registerPrompt("xd-to-figma", { title: "Rebuild an XD screen in Figma", description: "Recreate one artboard in Figma (needs the Figma MCP server too).", argsSchema: promptArgs }, ({ file, artboard }) => userPrompt(`Recreate the artboard "${artboard}" from ${file} in Figma as ONE auto-layout frame that looks as close to the original as possible. Do not deliver a second "exact copy" version, and do not answer with grouped vectors only. Steps: (1) xd_font_report and warn about fonts that aren't installed; (2) xd_get_design_system with format figma-variables, and create the variables and text/effect styles; (3) xd_list_components, and make components for repeated items; (4) xd_render_artboard to see the original; (5) xd_export_artboard with assetsDir for exact text, fills, shadows and the source of illustrations and photos; (6) xd_infer_layout, and build the frames from its tree with auto layout (direction, spacing, padding, FILL/HUG/FIXED), real editable text layers, and illustrations and photos cloned or imported from the export by their ref, inline or absolutely positioned inside their card; (7) name layers semantically (suggestedName); (8) xd_render_artboard again, compare with your result, fix differences, remove temporary helper layers, and list anything you could not reproduce. Differences of a few pixels in spacing are fine; looks, colours, fonts, shadows and illustrations must match. Only if I explicitly ask for a pixel-exact non-auto-layout copy, skip xd_infer_layout.`));
server.registerPrompt("xd-to-code", { title: "Turn an XD screen into code", description: "Generate a responsive UI component from one artboard.", argsSchema: { ...promptArgs, stack: z.string().default("React + Tailwind") } }, ({ file, artboard, stack }) => userPrompt(`Build the artboard "${artboard}" from ${file} as ${stack ?? "React + Tailwind"}. Call xd_get_design_system (format tailwind or css) first and use those tokens, then xd_export_artboard for layout, text and images. Use flex layout where the export shows stacks or aligned rows, keep text exact, and note any assumptions.`));
server.registerPrompt("xd-design-review", { title: "Review a design file", description: "Run a design QA pass over a whole file.", argsSchema: { file: z.string().describe("Absolute path to the .xd file") } }, ({ file }) => userPrompt(`Review ${file}. Call xd_audit_design and xd_get_design_system, then summarize the most important accessibility, consistency and system issues with specific screens and layers, ordered by impact. Suggest concrete fixes.`));
await server.connect(new StdioServerTransport());
