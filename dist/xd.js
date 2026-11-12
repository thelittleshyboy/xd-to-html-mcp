import JSZip from "jszip";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
const cache = new Map();
/** Allowed roots: XD_MCP_ROOTS (path-delimited) or the server's working directory. */
export function allowedRoots() {
    const env = process.env.XD_MCP_ROOTS;
    return (env ? env.split(path.delimiter).filter(Boolean) : [process.cwd()]).map((r) => path.resolve(r)).filter((r) => {
        if (path.parse(r).root === r)
            throw new Error(`Refusing filesystem root as allowed root: ${r}`);
        return true;
    });
}
/**
 * Resolve `p` (following symlinks) and require it to sit inside an allowed root.
 * For paths that don't exist yet (output dirs) the nearest existing ancestor is checked.
 */
export async function assertInsideRoots(p) {
    if (typeof p !== "string" || p.includes("\0"))
        throw new Error("Invalid path.");
    // Reject UNC / device namespaces before touching the filesystem: resolving
    // \\host\share would make Windows send NTLM credentials to a remote host.
    if (/^[\\/]{2}/.test(p))
        throw new Error("UNC and device paths are not allowed.");
    let probe = path.resolve(p);
    if (!allowedRoots().some((r) => isInside(r, probe)))
        throw denied(p);
    const tail = [];
    for (;;) {
        try {
            probe = await realpath(probe);
            break;
        }
        catch {
            const parent = path.dirname(probe);
            if (parent === probe)
                throw new Error(`Cannot resolve path: ${p}`);
            tail.unshift(path.basename(probe));
            probe = parent;
        }
    }
    const real = path.join(probe, ...tail);
    for (const root of allowedRoots()) {
        const rootReal = await realpath(root).catch(() => root);
        if (isInside(rootReal, real))
            return real;
    }
    throw denied(p);
}
function isInside(root, target) {
    const rel = path.relative(root, target);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
const denied = (p) => new Error(`Access denied: ${p} is outside the allowed roots. Set XD_MCP_ROOTS to permit other directories.`);
/* Resource limits against zip bombs and oversized inputs. */
const MAX_FILE_BYTES = 200 * 1024 * 1024;
const MAX_ENTRIES = 20_000;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAX_CACHED_DOCS = 4;
const MAX_CACHE_BYTES = 128 * 1024 * 1024; // raw JSON text kept parsed per document
const MAX_WALK_DEPTH = 256;
/**
 * Inflate one entry with a hard cap on the *actual* output size. The sizes written in a zip's headers
 * are attacker-controlled, so they can't be trusted to stop a decompression bomb.
 */
export function readEntry(doc, name, max = MAX_ENTRY_BYTES) {
    const f = doc.zip.file(name);
    if (!f)
        return Promise.reject(new Error(`No such entry in archive: ${name}`));
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        let done = false;
        // internalStream is public JSZip API but missing from its type definitions
        const stream = f.internalStream("nodebuffer");
        stream.on("data", (chunk) => {
            if (done)
                return;
            size += chunk.length;
            if (size > max) {
                done = true;
                stream.pause(); // stop inflating
                reject(new Error(`Entry too large (over ${Math.round(max / 1048576)} MB): ${name}`));
                return;
            }
            chunks.push(chunk);
        });
        stream.on("error", (e) => !done && ((done = true), reject(e)));
        stream.on("end", () => !done && ((done = true), resolve(Buffer.concat(chunks))));
        stream.resume();
    });
}
/** Own-property lookup: keys come from untrusted files, so never walk the prototype chain. */
export function own(obj, key) {
    return obj && typeof key === "string" && Object.hasOwn(obj, key) ? obj[key] : undefined;
}
function declaredSize(zip, name) {
    return zip.files[name]?._data?.uncompressedSize ?? 0;
}
export async function openXd(input) {
    if (path.extname(input).toLowerCase() !== ".xd")
        throw new Error("Only .xd files can be opened.");
    const file = await assertInsideRoots(input);
    const st = await stat(file);
    if (!st.isFile())
        throw new Error("Not a regular file.");
    if (st.size > MAX_FILE_BYTES)
        throw new Error("File too large.");
    const hit = cache.get(file);
    if (hit && hit.mtime === st.mtimeMs) {
        cache.delete(file);
        cache.set(file, hit); // refresh LRU position
        return hit.doc;
    }
    const doc = await docFromZip(await JSZip.loadAsync(await readFile(file)), file);
    cache.set(file, { mtime: st.mtimeMs, doc });
    while (cache.size > MAX_CACHED_DOCS)
        cache.delete(cache.keys().next().value);
    return doc;
}
/** Validate an already-loaded archive (size limits) and index it. Shared by openXd and the self-test. */
export async function docFromZip(zip, file) {
    const entries = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
    if (entries.length > MAX_ENTRIES)
        throw new Error("Archive has too many entries.");
    let total = 0;
    for (const n of entries) {
        const s = declaredSize(zip, n);
        if (s > MAX_ENTRY_BYTES)
            throw new Error(`Archive entry too large: ${n}`);
        total += s;
    }
    if (total > MAX_TOTAL_BYTES)
        throw new Error("Archive expands to too much data.");
    let manifest = {};
    const mf = zip.file("manifest");
    if (mf) {
        try {
            manifest = JSON.parse((await readEntry({ zip }, "manifest", 4 * 1024 * 1024)).toString("utf8"));
        }
        catch {
            /* leave empty */
        }
    }
    const doc = { zip, file, manifest, entries, artboards: [], agcCache: new Map() };
    doc.artboards = findArtboards(doc);
    return doc;
}
function findArtboards(doc) {
    // Names come from the manifest tree: any node with a `path` like "artboard-xxxx".
    const names = new Map();
    const walk = (n) => {
        if (!n || typeof n !== "object")
            return;
        if (typeof n.path === "string" && typeof n.name === "string")
            names.set(n.path, n.name);
        for (const k of ["children", "components"])
            if (Array.isArray(n[k]))
                n[k].forEach(walk);
    };
    walk(doc.manifest);
    const out = [];
    for (const e of doc.entries) {
        const m = e.match(/^artwork\/(artboard-[^/]+)\/graphics\/graphicContent\.agc$/);
        if (!m)
            continue;
        out.push({ id: m[1], name: names.get(m[1]) ?? names.get(`artwork/${m[1]}`) ?? m[1], path: e });
    }
    return out;
}
export async function readJson(doc, entry) {
    if (doc.agcCache.has(entry))
        return doc.agcCache.get(entry);
    const raw = await readEntry(doc, entry);
    const json = JSON.parse(raw.toString("utf8"));
    // Parsed JSON is much bigger than its text, so keep the per-document cache bounded (oldest out first).
    const sizes = (doc.agcSizes ??= new Map());
    doc.agcCache.set(entry, json);
    sizes.set(entry, raw.length);
    let total = 0;
    for (const v of sizes.values())
        total += v;
    for (const key of [...doc.agcCache.keys()]) {
        if (total <= MAX_CACHE_BYTES || doc.agcCache.size <= 1)
            break;
        total -= sizes.get(key) ?? 0;
        doc.agcCache.delete(key);
        sizes.delete(key);
    }
    return json;
}
export function resolveArtboard(doc, query) {
    const q = query.toLowerCase();
    const a = doc.artboards.find((x) => x.id.toLowerCase() === q) ??
        doc.artboards.find((x) => x.name.toLowerCase() === q) ??
        doc.artboards.find((x) => x.name.toLowerCase().includes(q));
    if (!a) {
        throw new Error(`Artboard "${query}" not found. Available: ${doc.artboards.map((x) => x.name).join(", ") || "(none)"}`);
    }
    return a;
}
/* ---------- scene graph helpers ---------- */
/** File data is untrusted: only real arrays count as lists. */
export const arr = (x) => (Array.isArray(x) ? x : []);
export function childrenOf(node) {
    if (!node || typeof node !== "object")
        return [];
    return arr(node.artboard?.children ?? node.group?.children ?? node.children);
}
/** The AGC root holds a list of top-level nodes (the artboard itself, usually). */
export function rootNodes(agc) {
    return arr(agc?.children);
}
function rgb(c) {
    const v = c?.value ?? c;
    if (!v || typeof v.r !== "number")
        return undefined;
    const h = (n) => Math.round(n).toString(16).padStart(2, "0");
    return `#${h(v.r)}${h(v.g)}${h(v.b)}`;
}
function fillOf(style) {
    const f = style?.fill;
    if (!f)
        return undefined;
    if (f.type === "solid")
        return rgb(f.color);
    if (f.type === "gradient")
        return `gradient(${f.gradient?.stops?.map((s) => rgb(s.color)).join(", ") ?? ""})`;
    if (f.type === "pattern")
        return "image";
    if (f.type === "none")
        return undefined;
    return typeof f.type === "string" ? f.type : undefined;
}
export function simplify(node, depth) {
    depth = Math.min(depth, MAX_WALK_DEPTH);
    const style = node.style;
    const shape = node.shape;
    const out = { id: node.id, type: node.type ?? "unknown", name: node.name };
    const t = node.transform;
    if (t) {
        out.x = round(t.tx);
        out.y = round(t.ty);
    }
    const w = shape?.width ?? node.text?.frame?.width;
    const h = shape?.height ?? node.text?.frame?.height;
    if (w != null)
        out.width = round(w);
    if (h != null)
        out.height = round(h);
    const fill = fillOf(style);
    if (fill)
        out.fill = fill;
    if (style?.stroke?.type === "solid")
        out.stroke = rgb(style.stroke.color);
    if (shape?.r != null)
        out.radius = shape.r;
    if (style?.opacity != null && style.opacity !== 1)
        out.opacity = style.opacity;
    if (node.text) {
        out.text = node.text.rawText;
        const font = style?.font ?? node.text.paragraphs?.[0]?.lines?.[0]?.[0]?.style;
        if (font)
            out.font = { family: font.postscriptName ?? font.family, style: font.style, size: font.size };
    }
    const kids = childrenOf(node);
    if (kids.length) {
        if (depth > 0)
            out.children = kids.map((k) => simplify(k, depth - 1));
        else
            out.childCount = kids.length;
    }
    return out;
}
function round(n) {
    return typeof n === "number" ? Math.round(n * 100) / 100 : n;
}
export function* walk(node, depth = 0) {
    yield node;
    if (depth >= MAX_WALK_DEPTH)
        return;
    for (const k of childrenOf(node))
        yield* walk(k, depth + 1);
}
export async function artboardTree(doc, ab, depth) {
    const agc = await readJson(doc, ab.path);
    // Artboard geometry lives in the shared resources file, keyed by the node's artboard.ref.
    const resPath = "resources/graphics/graphicContent.agc";
    const geometry = doc.entries.includes(resPath) ? (await readJson(doc, resPath))?.artboards : undefined;
    return rootNodes(agc).map((n) => {
        const s = simplify(n, depth);
        const g = geometry?.[n.artboard?.ref];
        if (g && typeof g === "object") {
            s.x = round(g.x);
            s.y = round(g.y);
            s.width = round(g.width);
            s.height = round(g.height);
        }
        return s;
    });
}
export async function extractTexts(doc, ab) {
    const agc = await readJson(doc, ab.path);
    const out = [];
    for (const root of rootNodes(agc))
        for (const n of walk(root))
            if (n.text?.rawText)
                out.push({ name: n.name, text: n.text.rawText });
    return out;
}
export async function designTokens(doc) {
    const colors = new Map();
    const fonts = new Map();
    const bump = (m, k) => k && m.set(k, (m.get(k) ?? 0) + 1);
    const files = [
        ...doc.artboards.map((a) => a.path),
        ...doc.entries.filter((e) => e.endsWith("graphicContent.agc") && !/artboard-/.test(e)),
    ];
    for (const f of files) {
        const agc = await readJson(doc, f);
        for (const root of rootNodes(agc))
            for (const n of walk(root)) {
                const fill = fillOf(n.style);
                if (fill && fill.startsWith("#"))
                    bump(colors, fill);
                if (n.style?.stroke?.type === "solid")
                    bump(colors, rgb(n.style.stroke.color));
                const font = n.style?.font;
                if (font)
                    bump(fonts, `${font.postscriptName ?? font.family} ${font.size ?? ""}`.trim());
            }
    }
    // Document-level shared styles (colors / character styles) live in resources.
    let shared;
    const res = doc.entries.find((e) => e === "resources/graphics/graphicContent.agc");
    if (res) {
        const r = await readJson(doc, res);
        shared = r?.resources?.meta?.ux ?? r?.resources;
    }
    const sort = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([value, uses]) => ({ value, uses }));
    return { colors: sort(colors), fonts: sort(fonts), sharedStyles: shared };
}
export async function interactions(doc) {
    const e = doc.entries.find((x) => x.endsWith("interactions/interactions.json"));
    return e ? readJson(doc, e) : null;
}
export function jsonPath(obj, path) {
    if (!path)
        return obj;
    let cur = obj;
    for (const part of path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean)) {
        if (cur == null || typeof cur !== "object")
            return undefined;
        if (part === "__proto__" || part === "constructor" || part === "prototype")
            return undefined;
        cur = Object.hasOwn(cur, part) ? cur[part] : undefined;
    }
    return cur;
}
