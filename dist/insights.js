import { readdir, lstat } from "node:fs/promises";
import path from "node:path";
import { arr, childrenOf, openXd, own, readJson, assertInsideRoots } from "./xd.js";
import { artboardGeometry, listComponents, sharedAssets } from "./export.js";
const hex2 = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
const rgbHex = (c) => {
    const v = c?.value;
    if (!v || typeof v.r !== "number")
        return undefined;
    return { hex: `#${hex2(v.r)}${hex2(v.g)}${hex2(v.b)}`, alpha: c.alpha ?? 1 };
};
const solid = (p) => (p?.type === "solid" ? rgbHex(p.color) : undefined);
const MAX_LAYER_DEPTH = 256;
const LINE_BREAKS = new RegExp("[" + String.fromCharCode(10, 11, 8232) + "]"); // newline, vertical tab, line separator
const MAX_LAYERS_PER_ARTBOARD = 100_000;
const MAX_CONTRAST_PAIRS = 50_000_000; // texts x backgrounds; keeps the audit from hanging on hostile files
const layerCache = new WeakMap();
export async function collectLayers(doc, ab) {
    let perDoc = layerCache.get(doc);
    if (!perDoc)
        layerCache.set(doc, (perDoc = new Map()));
    const hit = perDoc.get(ab.id);
    if (hit)
        return hit;
    const agc = await readJson(doc, ab.path);
    const geoMap = await artboardGeometry(doc);
    const out = [];
    let order = 0;
    const visit = (n, origin, parentId, depth = 0) => {
        if (depth > MAX_LAYER_DEPTH)
            return undefined;
        if (out.length >= MAX_LAYERS_PER_ARTBOARD)
            throw new Error(`Artboard "${ab.name}" has too many layers (over ${MAX_LAYERS_PER_ARTBOARD}).`);
        if (n.visible === false && n.type !== "artboard")
            return undefined; // hidden layers (and their children) are skipped
        const ux = n.meta?.ux ?? {};
        const t = n.transform ?? {};
        const a = t.a ?? 1, b = t.b ?? 0, c = t.c ?? 0, d = t.d ?? 1, tx = t.tx ?? 0, ty = t.ty ?? 0;
        const style = n.style ?? {};
        const layer = {
            id: n.id,
            name: n.name,
            type: n.type,
            artboardId: ab.id,
            artboardName: ab.name,
            parentId,
            x: origin.x + tx,
            y: origin.y + ty,
            w: 0,
            h: 0,
            order: order++,
            interactive: !!(ux.interactions && ux.interactions.length),
        };
        const f = solid(style.fill);
        if (f)
            layer.fill = f;
        if (style.fill?.type === "pattern")
            layer.imageFill = true;
        const sc = solid(style.stroke);
        if (sc)
            layer.stroke = { hex: sc.hex, width: style.stroke?.width };
        const shadows = arr(style.filters)
            .filter((x) => x?.type === "dropShadow" && x.visible !== false)
            .flatMap((x) => arr(x.params?.dropShadows))
            .map((s) => ({ x: s.dx, y: s.dy, blur: s.r, ...(rgbHex(s.color) ?? { hex: "#000000", alpha: 1 }) }));
        if (shadows.length)
            layer.shadows = shadows;
        out.push(layer);
        const s = n.shape;
        if (n.type === "shape" && s) {
            layer.type = { rect: "rectangle", circle: "ellipse", ellipse: "ellipse", line: "line", path: "path", compound: "boolean" }[s.type] ?? s.type;
            let bx = s.x ?? 0, by = s.y ?? 0, bw = s.width ?? 0, bh = s.height ?? 0;
            if (s.type === "circle")
                ({ bx, by, bw, bh } = { bx: s.cx - s.r, by: s.cy - s.r, bw: s.r * 2, bh: s.r * 2 });
            if (s.type === "ellipse")
                ({ bx, by, bw, bh } = { bx: s.cx - s.rx, by: s.cy - s.ry, bw: s.rx * 2, bh: s.ry * 2 });
            if (s.type === "line")
                ({ bx, by, bw, bh } = { bx: Math.min(s.x1, s.x2), by: Math.min(s.y1, s.y2), bw: Math.abs(s.x2 - s.x1), bh: Math.abs(s.y2 - s.y1) });
            if (s.type === "path" || s.type === "compound") {
                const nums = typeof s.path === "string" ? s.path.match(/-?\d*\.?\d+(?:e-?\d+)?/gi)?.map(Number) : undefined;
                if (nums && nums.length >= 2) {
                    const xs = nums.filter((_, i) => i % 2 === 0), ys = nums.filter((_, i) => i % 2 === 1);
                    bx = Math.min(...xs);
                    by = Math.min(...ys);
                    bw = Math.max(...xs) - bx;
                    bh = Math.max(...ys) - by;
                }
            }
            layer.x = origin.x + a * bx + c * by + tx;
            layer.y = origin.y + b * bx + d * by + ty;
            layer.w = Math.abs(bw * a);
            layer.h = Math.abs(bh * d);
            if (s.type === "rect" && s.r != null) {
                const r = Array.isArray(s.r) ? Math.max(...s.r.filter(num)) : s.r;
                if (num(r))
                    layer.radius = r;
            }
            return { x: layer.x, y: layer.y, w: layer.w, h: layer.h };
        }
        if (n.type === "text") {
            const content = String(n.text?.rawText ?? "");
            layer.text = content;
            const font = style.font;
            if (font) {
                layer.font = { family: font.family, style: font.style, size: font.size };
                layer.fontSize = font.size;
            }
            const runs = new Set();
            for (const p of arr(n.text?.paragraphs))
                for (const line of arr(p.lines))
                    for (const r of arr(line)) {
                        const rc = solid(r.style?.fill);
                        if (rc)
                            runs.add(rc.hex);
                    }
            if (runs.size)
                layer.runFills = [...runs];
            const size = font?.size ?? 14;
            const attrs = style.textAttributes ?? {};
            if (num(attrs.lineHeight))
                layer.lineHeight = attrs.lineHeight;
            if (num(attrs.charSpacing))
                layer.charSpacing = attrs.charSpacing;
            const lh = layer.lineHeight ?? size * 1.17;
            // XD stores the baseline origin; line x offsets are negative for right/centre aligned point text
            let minX = 0;
            for (const p of arr(n.text?.paragraphs))
                for (const line of arr(p.lines))
                    if (num(line?.[0]?.x))
                        minX = Math.min(minX, line[0].x);
            layer.y = layer.y - ((lh - 1.17 * size) / 2 + 0.92 * size);
            layer.x = layer.x + minX;
            const lines = content.split(LINE_BREAKS).length;
            const isArea = n.text?.frame?.type === "area";
            layer.w = isArea ? n.text.frame.width : minX < 0 ? (attrs.paragraphAlign === "center" ? -2 * minX : -minX) : Math.min(content.length, 60) * size * 0.53;
            layer.h = isArea && num(n.text.frame.height) ? n.text.frame.height : lines * lh;
            return { x: layer.x, y: layer.y, w: layer.w, h: layer.h };
        }
        // group / artboard: children live in this node's local space
        const childOrigin = { x: origin.x + tx, y: origin.y + ty };
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const k of childrenOf(n)) {
            const bb = visit(k, childOrigin, n.id, depth + 1);
            if (!bb)
                continue;
            x0 = Math.min(x0, bb.x);
            y0 = Math.min(y0, bb.y);
            x1 = Math.max(x1, bb.x + bb.w);
            y1 = Math.max(y1, bb.y + bb.h);
        }
        if (ux.width != null && ux.height != null) {
            layer.w = ux.width;
            layer.h = ux.height;
        }
        else if (x1 > x0) {
            layer.x = x0;
            layer.y = y0;
            layer.w = x1 - x0;
            layer.h = y1 - y0;
        }
        return { x: layer.x, y: layer.y, w: layer.w, h: layer.h };
    };
    for (const root of arr(agc?.children)) {
        const g = own(geoMap, root.artboard?.ref);
        // top-level layers hold canvas coordinates: shift so (0,0) is the artboard's corner
        const start = { x: -(g?.x ?? 0), y: -(g?.y ?? 0) };
        const idx = out.length;
        visit({ ...root, transform: undefined }, start, undefined);
        const rootLayer = out[idx];
        rootLayer.x = 0;
        rootLayer.y = 0;
        if (g) {
            rootLayer.w = g.width;
            rootLayer.h = g.height;
        }
    }
    perDoc.set(ab.id, out);
    return out;
}
async function allLayers(doc, artboard) {
    const abs = artboard ? [artboard] : doc.artboards;
    const out = [];
    for (const ab of abs)
        out.push(...(await collectLayers(doc, ab)));
    return out;
}
/* ---------- design system ---------- */
const num = (v) => typeof v === "number" && Number.isFinite(v);
const round2 = (n) => Math.round(n * 100) / 100;
const bump = (m, k, n = 1) => m.set(k, (m.get(k) ?? 0) + n);
const ranked = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]);
export async function designSystem(doc, format) {
    const layers = await allLayers(doc);
    const colors = new Map();
    const addColor = (hex, role) => {
        if (!hex)
            return;
        const e = colors.get(hex) ?? { fill: 0, text: 0, stroke: 0 };
        e[role]++;
        colors.set(hex, e);
    };
    const type = new Map();
    const radii = new Map();
    const strokeWidths = new Map();
    const shadows = new Map();
    const textStyles = new Map();
    for (const l of layers) {
        if (l.type === "artboard") {
            addColor(l.fill?.hex, "fill");
            continue;
        }
        addColor(l.fill?.hex, l.type === "text" ? "text" : "fill");
        addColor(l.stroke?.hex, "stroke");
        if (l.font) {
            const family = String(l.font.family ?? "?").replaceAll("|", " ");
            const style = String(l.font.style ?? "").replaceAll("|", " ");
            const size = num(l.font.size) ? l.font.size : 0;
            bump(type, `${family}|${style}|${size}`);
            const key = `${family}|${style}|${size}|${l.lineHeight ?? ""}|${l.charSpacing ?? ""}`;
            const e = textStyles.get(key) ?? { family, style, size, lineHeight: l.lineHeight, charSpacing: l.charSpacing, uses: 0 };
            e.uses++;
            textStyles.set(key, e);
        }
        if (num(l.radius) && l.radius > 0)
            bump(radii, round2(l.radius));
        if (num(l.stroke?.width) && l.stroke.width > 0)
            bump(strokeWidths, round2(l.stroke.width));
        for (const s of l.shadows ?? [])
            if (num(s.x) && num(s.y) && num(s.blur) && num(s.alpha))
                bump(shadows, `${s.x}|${s.y}|${s.blur}|${s.hex}|${Math.round(s.alpha * 100) / 100}`);
    }
    const shared = await sharedAssets(doc);
    const libNames = new Map();
    for (const c of shared.libraryColors ?? [])
        if (c.name)
            libNames.set(c.color, c.name);
    const colorList = [...colors.entries()]
        .map(([hex, r]) => ({ hex, uses: r.fill + r.text + r.stroke, ...r }))
        .sort((a, b) => b.uses - a.uses)
        .map((c, i) => ({ token: libNames.get(c.hex) ?? `color-${i + 1}`, ...c }));
    const typography = ranked(type).map(([k, uses], i) => {
        const [family, style, size] = k.split("|");
        return { token: `text-${i + 1}`, family, style, size: Number(size), uses };
    });
    const sizes = [...new Set(typography.map((t) => t.size).filter((s) => s > 0))].sort((a, b) => a - b);
    const radiusList = ranked(radii).map(([v, uses]) => ({ value: v, uses }));
    const shadowList = ranked(shadows).map(([k, uses], i) => {
        const [x, y, blur, hex, alpha] = k.split("|");
        return { token: `shadow-${i + 1}`, x: Number(x), y: Number(y), blur: Number(blur), color: hex, alpha: Number(alpha), uses };
    });
    const system = {
        colors: colorList,
        typography: { styles: typography, sizeScale: sizes, families: [...new Set(typography.map((t) => t.family))] },
        radii: radiusList,
        strokeWidths: ranked(strokeWidths).map(([value, uses]) => ({ value, uses })),
        shadows: shadowList,
        savedSwatches: shared.colorSwatches ?? [],
    };
    if (format === "json")
        return system;
    if (format === "figma-variables")
        return figmaVariables(colorList, textStyles, radiusList, shadowList, system.strokeWidths);
    const rgba = (hex, a) => {
        const n = parseInt(hex.slice(1), 16);
        return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
    };
    const shadowCss = (s) => `${s.x}px ${s.y}px ${s.blur}px ${rgba(s.color, s.alpha)}`;
    if (format === "css") {
        const lines = [":root {"];
        for (const c of colorList)
            lines.push(`  --${safeToken(c.token)}: ${c.hex};`);
        for (const s of sizes)
            lines.push(`  --font-size-${s}: ${s}px;`);
        for (const r of radiusList)
            lines.push(`  --radius-${r.value}: ${r.value}px;`);
        for (const s of shadowList)
            lines.push(`  --${s.token}: ${shadowCss(s)};`);
        lines.push("}");
        return lines.join("\n");
    }
    // tailwind: theme.extend
    return {
        theme: {
            extend: {
                colors: Object.fromEntries(colorList.map((c) => [safeToken(c.token), c.hex])),
                fontSize: Object.fromEntries(sizes.map((s) => [String(s), `${s}px`])),
                fontFamily: Object.fromEntries(system.typography.families.map((f, i) => [`family-${i + 1}`, [f]])),
                borderRadius: Object.fromEntries(radiusList.map((r) => [String(r.value), `${r.value}px`])),
                boxShadow: Object.fromEntries(shadowList.map((s) => [s.token, shadowCss(s)])),
            },
        },
    };
}
/** Token names come from file content: keep them to safe identifier characters. */
const safeToken = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "token";
/* ---------- audit ---------- */
function luminance(hex) {
    const n = parseInt(hex.slice(1), 16);
    const f = (v) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f((n >> 16) & 255) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255);
}
export const contrastRatio = (a, b) => {
    const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (l1 + 0.05) / (l2 + 0.05);
};
const dist = (a, b) => {
    const x = parseInt(a.slice(1), 16), y = parseInt(b.slice(1), 16);
    return Math.hypot(((x >> 16) & 255) - ((y >> 16) & 255), ((x >> 8) & 255) - ((y >> 8) & 255), (x & 255) - (y & 255));
};
export async function audit(doc, artboard, opts = {}) {
    const minTap = opts.minTapTarget ?? 44;
    const minFont = opts.minFontSize ?? 11;
    const cap = opts.maxPerCheck ?? 25;
    const findings = [];
    const counts = {};
    const push = (f) => {
        counts[f.check] = (counts[f.check] ?? 0) + 1;
        if (counts[f.check] <= cap)
            findings.push(f);
    };
    const abs = artboard ? [artboard] : doc.artboards;
    const everything = [];
    for (const ab of abs) {
        const layers = await collectLayers(doc, ab);
        everything.push(...layers);
        const base = layers.find((l) => l.type === "artboard")?.fill?.hex ?? "#ffffff";
        const textCount = layers.filter((l) => l.type === "text").length;
        const painted = layers.filter((l) => ((l.fill && l.fill.alpha >= 0.95) || l.imageFill) && l.type !== "text" && l.type !== "group" && l.w > 0 && l.h > 0);
        for (const l of layers) {
            const where = { artboard: ab.name, layerId: l.id, layer: l.name };
            if (l.type === "text" && l.text?.trim()) {
                if (l.fontSize && l.fontSize < minFont)
                    push({ check: "small-text", severity: "warning", ...where, message: `Text is ${l.fontSize}px (minimum ${minFont}px).` });
                if (/lorem ipsum|dolor sit amet/i.test(l.text))
                    push({ check: "placeholder-text", severity: "warning", ...where, message: "Placeholder (lorem ipsum) text." });
                const textColors = l.runFills ?? (l.fill ? [l.fill.hex] : []);
                if (textColors.length && textCount * painted.length <= MAX_CONTRAST_PAIRS) {
                    const cx = l.x + Math.min(l.w, 40) / 2, cy = l.y + l.h / 2;
                    let bg = base;
                    for (const p of painted)
                        if (p.order < l.order && p.type !== "artboard" && cx >= p.x && cx <= p.x + p.w && cy >= p.y && cy <= p.y + p.h)
                            bg = p.fill ? p.fill.hex : undefined; // last one wins = topmost; a picture means unknown
                    if (bg === undefined)
                        continue;
                    const worst = textColors.reduce((a, c) => (contrastRatio(c, bg) < contrastRatio(a, bg) ? c : a));
                    const ratio = contrastRatio(worst, bg);
                    const large = (l.fontSize ?? 0) >= 18 || ((l.fontSize ?? 0) >= 14 && /bold|black|heavy/i.test(l.font?.style ?? ""));
                    const need = large ? 3 : 4.5;
                    if (ratio < need)
                        push({ check: "low-contrast", severity: ratio < 3 ? "error" : "warning", ...where, message: `Contrast ${ratio.toFixed(2)}:1 for ${worst} on ${bg} (needs ${need}:1). Background is estimated.` });
                }
            }
            if (l.interactive && l.type !== "artboard" && (l.w < minTap || l.h < minTap) && l.w > 0)
                push({ check: "small-tap-target", severity: "info", ...where, message: `Interactive layer is ${Math.round(l.w)}x${Math.round(l.h)}px (recommended at least ${minTap}x${minTap}px on touch screens).` });
            if (l.name && /^(Rectangle|Ellipse|Group|Path|Line|Polygon|Compound Shape|Component)\s?\d+$/i.test(l.name) && l.type !== "artboard")
                counts["default-layer-name"] = (counts["default-layer-name"] ?? 0) + 1;
        }
    }
    // document-level checks
    const colorUses = new Map();
    const fontFamilies = new Map();
    const sizes = new Set();
    for (const l of everything) {
        if (l.type === "artboard")
            continue;
        if (l.fill)
            bump(colorUses, l.fill.hex);
        if (l.stroke)
            bump(colorUses, l.stroke.hex);
        if (l.font?.family)
            bump(fontFamilies, l.font.family);
        if (l.fontSize)
            sizes.add(l.fontSize);
    }
    const byUse = ranked(colorUses);
    const near = new Set();
    for (const [hex, uses] of byUse) {
        if (near.has(hex))
            continue;
        for (const [other, ou] of byUse) {
            if (other === hex || near.has(other) || ou >= uses)
                continue;
            const d = dist(hex, other);
            if (d > 0 && d <= 10) {
                near.add(other);
                push({ check: "near-duplicate-color", severity: "info", message: `${other} (${ou} uses) is almost identical to ${hex} (${uses} uses). Consider merging.` });
            }
        }
    }
    if (fontFamilies.size > 3)
        push({ check: "too-many-fonts", severity: "warning", message: `${fontFamilies.size} font families used: ${[...fontFamilies.keys()].join(", ")}.` });
    if (sizes.size > 10)
        push({ check: "too-many-font-sizes", severity: "info", message: `${sizes.size} different font sizes used. A type scale usually needs 6-8.` });
    if (counts["default-layer-name"])
        findings.push({ check: "default-layer-names", severity: "info", message: `${counts["default-layer-name"]} layers still have default names like "Rectangle 12" or "Group 3".` });
    const summary = Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v]));
    return { artboardsChecked: abs.length, layersChecked: everything.length, summary, shown: findings.length, findings, note: `At most ${cap} findings per check are listed; see summary for totals. Contrast uses an estimated background.` };
}
/* ---------- search ---------- */
export async function findLayers(doc, q) {
    const limit = q.limit ?? 50;
    const text = q.text?.toLowerCase(), name = q.name?.toLowerCase(), type = q.type?.toLowerCase();
    const color = q.color && /^#[0-9a-f]{6}$/i.test(q.color) ? q.color.toLowerCase() : undefined;
    if (q.color && !color)
        throw new Error("color must look like #rrggbb");
    const hits = [];
    let total = 0;
    for (const l of await allLayers(doc, q.artboard)) {
        if (l.type === "artboard")
            continue;
        if (type && l.type !== type)
            continue;
        if (text && !l.text?.toLowerCase().includes(text))
            continue;
        if (name && !l.name?.toLowerCase().includes(name))
            continue;
        if (color && !(l.fill && dist(l.fill.hex, color) <= 6) && !(l.stroke && dist(l.stroke.hex, color) <= 6))
            continue;
        total++;
        if (hits.length < limit)
            hits.push({ artboard: l.artboardName, id: l.id, name: l.name, type: l.type, text: l.text, fill: l.fill?.hex, x: Math.round(l.x), y: Math.round(l.y), width: Math.round(l.w), height: Math.round(l.h) });
    }
    return { total, shown: hits.length, results: hits };
}
/* ---------- copy deck ---------- */
const csvCell = (v) => {
    let s = String(v).replace(/\r?\n/g, "\n");
    if (/^[=+\-@\t\r]/.test(s))
        s = "'" + s; // neutralize spreadsheet formula injection
    return `"${s.replace(/"/g, '""')}"`;
};
export async function copyDeck(doc, artboard, format) {
    const rows = [];
    for (const l of await allLayers(doc, artboard))
        if (l.type === "text" && l.text?.trim())
            rows.push({ artboard: l.artboardName, layer: l.name ?? "", id: l.id, text: l.text });
    if (format === "json")
        return { count: rows.length, rows };
    return ["artboard,layer,id,text", ...rows.map((r) => [r.artboard, r.layer, r.id, r.text].map(csvCell).join(","))].join("\n");
}
/* ---------- prototype flow ---------- */
const mermaidLabel = (s) => s.replace(/[^\p{L}\p{N} _.,&/()-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 40) || "screen";
export async function flowMap(doc) {
    const entry = doc.entries.find((e) => e === "interactions/interactions.json");
    if (!entry)
        return { home: null, edges: [], note: "No prototype interactions in this file." };
    const ij = await readJson(doc, entry);
    const names = new Map(doc.artboards.map((a) => [a.id.replace(/^artboard-/, ""), a.name]));
    const owner = new Map();
    for (const ab of doc.artboards)
        for (const l of await collectLayers(doc, ab))
            owner.set(l.id, l);
    const edges = [];
    for (const [layerId, list] of Object.entries(ij.interactions ?? {})) {
        const src = owner.get(layerId);
        for (const i of list) {
            const p = i.properties ?? {};
            edges.push({
                fromArtboard: src?.artboardName ?? "(unknown)",
                fromLayer: src?.name,
                fromLayerId: layerId,
                trigger: i.triggerEvent,
                action: i.action,
                toArtboard: names.get(p.destination) ?? undefined,
                destinationId: p.destination,
                transition: p.transition ?? undefined,
                duration: p.duration,
                easing: p.easing,
                delay: p.delay,
            });
        }
    }
    // artboard-to-artboard graph (state changes inside a screen are not drawn)
    const ids = new Map();
    const idOf = (n) => ids.get(n) ?? (ids.set(n, "s" + ids.size), ids.get(n));
    const seen = new Set();
    const lines = ["flowchart LR"];
    for (const e of edges) {
        if (!e.toArtboard || e.fromArtboard === "(unknown)" || e.fromArtboard === e.toArtboard)
            continue;
        const key = `${e.fromArtboard}>${e.toArtboard}>${e.trigger}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        lines.push(`  ${idOf(e.fromArtboard)}["${mermaidLabel(e.fromArtboard)}"] -->|${mermaidLabel(String(e.trigger ?? ""))}| ${idOf(e.toArtboard)}["${mermaidLabel(e.toArtboard)}"]`);
    }
    const home = typeof ij.homeArtboard === "string" ? names.get(ij.homeArtboard) ?? ij.homeArtboard : null;
    return { home, edgeCount: edges.length, edges: edges.slice(0, 500), truncated: edges.length > 500, mermaid: lines.join("\n") };
}
/* ---------- project overview ---------- */
export async function projectOverview(dir, maxFiles = 60) {
    const root = await assertInsideRoots(dir);
    const found = [];
    const scan = async (d, depth) => {
        if (found.length >= maxFiles || depth > 3)
            return;
        for (const e of await readdir(d, { withFileTypes: true })) {
            const full = path.join(d, e.name);
            if (e.isSymbolicLink())
                continue; // never follow links out of the allowed roots
            if (e.isDirectory() && e.name !== "node_modules" && !e.name.startsWith(".")) {
                try {
                    await assertInsideRoots(full); // a junction pointing outside the roots is skipped
                }
                catch {
                    continue;
                }
                await scan(full, depth + 1);
            }
            else if (e.isFile() && e.name.toLowerCase().endsWith(".xd") && found.length < maxFiles)
                found.push(full);
        }
    };
    await scan(root, 0);
    const files = [];
    for (const f of found) {
        try {
            const doc = await openXd(f);
            const st = await lstat(f);
            files.push({
                file: path.relative(root, f) || path.basename(f),
                name: doc.manifest?.name,
                sizeMB: Math.round((st.size / 1048576) * 10) / 10,
                artboards: doc.artboards.length,
                components: (await listComponents(doc)).length,
                hasInteractions: doc.entries.includes("interactions/interactions.json"),
            });
        }
        catch (e) {
            files.push({ file: path.relative(root, f), error: e instanceof Error ? e.message : String(e) });
        }
    }
    return { folder: root, count: files.length, files, truncated: found.length >= maxFiles };
}
/* ---------- Figma variables / styles ---------- */
function hslOf(hex) {
    const n = parseInt(hex.slice(1), 16);
    const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    return { h: 0, s, l };
}
const sizeRole = (size) => size < 12 ? "Caption/S" : size < 14 ? "Body/S" : size < 16 ? "Body/M" : size < 18 ? "Body/L" : size < 21 ? "Title/S" : size < 25 ? "Title/M" : size < 33 ? "Title/L" : "Display";
/**
 * The design system shaped for Figma: variable collections (colors, radii, typography numbers), text styles named by
 * role, and effect styles, so an agent can create them in a few calls before building screens.
 */
function figmaVariables(colorList, textStyles, radiusList, shadowList, strokeWidths) {
    const counters = new Map();
    const colors = colorList.map((c) => {
        const named = !/^color-\d+$/.test(c.token);
        const { s } = hslOf(c.hex);
        const group = c.text >= c.fill && c.text >= c.stroke && c.text > 0 ? "text" : c.stroke > c.fill && c.stroke > c.text ? "border" : s < 0.15 ? "surface" : "brand";
        const n = (counters.get(group) ?? 0) + 1;
        counters.set(group, n);
        return {
            name: named ? `library/${safeToken(c.token)}` : `${group}/${n}`,
            resolvedType: "COLOR",
            values: { Default: c.hex },
            scopes: group === "text" ? ["TEXT_FILL"] : group === "border" ? ["STROKE_COLOR"] : group === "brand" ? ["ALL_FILLS"] : ["FRAME_FILL", "SHAPE_FILL"],
            uses: c.uses,
        };
    });
    const sizes = [...new Set([...textStyles.values()].map((t) => t.size).filter((v) => v > 0))].sort((a, b) => a - b);
    const families = [...new Set([...textStyles.values()].map((t) => t.family))];
    const typography = [
        ...sizes.map((v) => ({ name: `font-size/${v}`, resolvedType: "FLOAT", values: { Default: v }, scopes: ["FONT_SIZE"] })),
        ...families.map((f, i) => ({ name: `font-family/${i + 1}`, resolvedType: "STRING", values: { Default: f }, scopes: ["FONT_FAMILY"] })),
        ...strokeWidths.map((w) => ({ name: `stroke/${w.value}`, resolvedType: "FLOAT", values: { Default: w.value }, scopes: ["STROKE_FLOAT"], uses: w.uses })),
    ];
    // text styles named by role; duplicates get the weight, then the size
    const sorted = [...textStyles.values()].filter((t) => t.size > 0).sort((a, b) => b.uses - a.uses);
    const used = new Set();
    const styles = sorted.map((t) => {
        let name = sizeRole(t.size);
        if (used.has(name))
            name = `${name} ${t.style || "Regular"}`;
        if (used.has(name))
            name = `${name} ${t.size}px`;
        used.add(name);
        return {
            name,
            fontFamily: t.family,
            fontStyle: t.style || "Regular",
            fontSize: t.size,
            lineHeight: t.lineHeight ? { unit: "PIXELS", value: t.lineHeight } : { unit: "AUTO" },
            letterSpacing: t.charSpacing ? { unit: "PERCENT", value: Math.round(t.charSpacing / 10 * 100) / 100 } : undefined,
            uses: t.uses,
        };
    });
    return {
        collections: [
            { name: "Color", modes: ["Default"], variables: colors },
            { name: "Radius", modes: ["Default"], variables: radiusList.map((r) => ({ name: `radius/${r.value}`, resolvedType: "FLOAT", values: { Default: r.value }, scopes: ["CORNER_RADIUS"], uses: r.uses })) },
            { name: "Typography", modes: ["Default"], variables: typography },
        ],
        textStyles: styles,
        effectStyles: shadowList.map((s, i) => ({
            name: `Shadow/${i + 1}`,
            effects: [{ type: "DROP_SHADOW", color: { hex: s.color, alpha: s.alpha }, offset: { x: s.x, y: s.y }, radius: s.blur, spread: 0 }],
            uses: s.uses,
        })),
        howToApply: [
            "1. Create the three variable collections with these variables (names with / become groups).",
            "2. Create the text styles, then the effect styles.",
            "3. Bind fills, text and corner radii to the variables and styles when building screens.",
            "Colors are named by how they are used (text, border, surface, brand); rename them to match the brand.",
        ],
    };
}
