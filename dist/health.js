import { readFileSync } from "node:fs";
import JSZip from "jszip";
import { allowedRoots, docFromZip, openXd, resolveArtboard } from "./xd.js";
import { exportArtboard } from "./export.js";
import { findBrowser } from "./render.js";
import path from "node:path";
export const VERSION = (() => {
    try {
        return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
    }
    catch {
        return "unknown";
    }
})();
/** Build a tiny archive in memory and run it through the real parser and exporter. */
async function selfTest() {
    const checks = [];
    const rec = (name, ok, detail) => checks.push({ name, ok, detail });
    try {
        const solid = { type: "solid", color: { mode: "RGB", value: { r: 0, g: 51, b: 160 } } };
        const zip = new JSZip();
        zip.file("manifest", JSON.stringify({ name: "ping", children: [{ name: "artwork", path: "artwork", children: [{ name: "Ping", path: "artboard-ping" }] }] }));
        zip.file("artwork/artboard-ping/graphics/graphicContent.agc", JSON.stringify({
            children: [
                {
                    type: "artboard", id: "ping", artboard: { ref: "r", children: [
                            { id: "a", type: "shape", name: "Box", transform: { a: 1, b: 0, c: 0, d: 1, tx: 10, ty: 20 }, shape: { type: "rect", x: 0, y: 0, width: 30, height: 20 }, style: { fill: solid } },
                            { id: "t", type: "text", name: "Label", transform: { a: 1, b: 0, c: 0, d: 1, tx: 5, ty: 60 }, text: { rawText: "Hi", frame: { type: "positioned" } }, style: { fill: solid, font: { family: "Arial", style: "Regular", size: 12 } } },
                        ] },
                },
            ],
        }));
        zip.file("resources/graphics/graphicContent.agc", JSON.stringify({ artboards: { r: { x: 0, y: 0, width: 100, height: 100 } }, resources: { meta: { ux: { symbols: [] } } } }));
        const doc = await docFromZip(zip, "ping.xd");
        rec("archive parsed", doc.artboards.length === 1 && doc.artboards[0].name === "Ping");
        const r = await exportArtboard(doc, doc.artboards[0], {});
        const kids = r.node.children ?? [];
        rec("export built a frame with its layers", r.node.type === "frame" && kids.length === 2);
        rec("shape and text exported correctly", kids[0]?.fills?.[0]?.color === "#0033a0" && kids[1]?.text?.characters === "Hi" && typeof kids[1]?.text?.baselineY === "number");
    }
    catch (e) {
        rec("self-test threw", false, e instanceof Error ? e.message : String(e));
    }
    return { passed: checks.every((c) => c.ok), checks };
}
export async function ping(file) {
    const browser = await findBrowser();
    let roots;
    try {
        roots = allowedRoots();
    }
    catch (e) {
        roots = `invalid: ${e instanceof Error ? e.message : e}`;
    }
    const out = {
        server: "adobe-xd-mcp",
        version: VERSION,
        node: process.version,
        platform: `${process.platform} ${process.arch}`,
        allowedRoots: roots,
        rootsSource: process.env.XD_MCP_ROOTS ? "XD_MCP_ROOTS" : "default: the folder the server was started in (set XD_MCP_ROOTS)",
        renderBrowser: browser ? path.basename(browser) : null,
        renderHint: browser ? undefined : "xd_render_artboard needs Chrome or Edge. Install one or set XD_MCP_CHROME.",
        selfTest: await selfTest(),
    };
    if (file) {
        try {
            const doc = await openXd(file);
            const ab = doc.artboards[0];
            out.file = { ok: true, name: doc.manifest?.name, artboards: doc.artboards.length, firstArtboardExports: ab ? !!(await exportArtboard(doc, resolveArtboard(doc, ab.id), {})).node : null };
        }
        catch (e) {
            out.file = { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
    }
    return out;
}
