import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readEntry } from "./xd.js";
import { collectImageRefs, exportWhole } from "./export.js";
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const n = (v, d = 3) => {
    const x = Number(v);
    return Number.isFinite(x) ? String(Math.round(x * 10 ** d) / 10 ** d) : "0";
};
/** Only accept #rrggbb colours in attributes. */
const col = (c) => (typeof c === "string" && /^#[0-9a-fA-F]{6}$/.test(c) ? c : "#000000");
const uid = (c, p) => `${p}${c.seq++}`;
/* ---------- font helpers ---------- */
const WEIGHTS = [
    [/thin|hairline/i, 100],
    [/extra ?light|ultra ?light/i, 200],
    [/light/i, 300],
    [/semi ?bold|demi ?bold/i, 600],
    [/extra ?bold|ultra ?bold|heavy/i, 800],
    [/black/i, 900],
    [/bold/i, 700],
    [/medium/i, 500],
];
export function weightOf(style) {
    for (const [re, w] of WEIGHTS)
        if (re.test(style ?? ""))
            return w;
    return 400;
}
const isItalic = (style) => /italic|oblique/i.test(style ?? "");
/* ---------- paints ---------- */
function paintAttr(c, paint, box) {
    if (!paint)
        return { value: "none" };
    if (paint.type === "solid")
        return { value: col(paint.color), opacity: paint.opacity };
    if (paint.type === "gradient") {
        const id = uid(c, "g");
        const stops = (paint.stops ?? [])
            .map((s) => `<stop offset="${n(s.offset)}" stop-color="${col(s.color)}" stop-opacity="${n(s.opacity ?? 1)}"/>`)
            .join("");
        const units = paint.units === "userSpaceOnUse" ? "userSpaceOnUse" : "objectBoundingBox";
        const gt = paint.transform ? ` gradientTransform="matrix(${[paint.transform.a, paint.transform.b, paint.transform.c, paint.transform.d, paint.transform.tx, paint.transform.ty].map((v) => n(v ?? 0, 5)).join(" ")})"` : "";
        if (paint.kind === "radial")
            c.defs.push(`<radialGradient id="${id}" gradientUnits="${units}" cx="${n(paint.cx ?? 0.5, 5)}" cy="${n(paint.cy ?? 0.5, 5)}" r="${n(paint.r ?? 0.5, 5)}" fx="${n(paint.fx ?? paint.cx ?? 0.5, 5)}" fy="${n(paint.fy ?? paint.cy ?? 0.5, 5)}"${gt}>${stops}</radialGradient>`);
        else {
            // XD handles are normalized positions; colour distances are measured in design pixels.
            // SVG objectBoundingBox additionally scales the perpendicular gradient direction on non-square shapes.
            const linearUnits = units === "objectBoundingBox" ? "userSpaceOnUse" : units;
            const gx = (v) => units === "objectBoundingBox" ? box.x + v * box.width : v;
            const gy = (v) => units === "objectBoundingBox" ? box.y + v * box.height : v;
            c.defs.push(`<linearGradient id="${id}" gradientUnits="${linearUnits}" x1="${n(gx(paint.x1 ?? 0), 5)}" y1="${n(gy(paint.y1 ?? 0), 5)}" x2="${n(gx(paint.x2 ?? 1), 5)}" y2="${n(gy(paint.y2 ?? 0), 5)}"${gt}>${stops}</linearGradient>`);
        }
        return { value: `url(#${id})` };
    }
    if (paint.type === "image") {
        const img = paint.imageRef ? c.images.get(paint.imageRef) : undefined;
        if (!img)
            return { value: "#cccccc" };
        c.usedImages.add(paint.imageRef);
        const id = uid(c, "p");
        const sw = paint.sourceWidth ?? img.width, sh = paint.sourceHeight ?? img.height;
        const { x, y, width: w, height: h } = box;
        let tf;
        let pw = w, ph = h;
        const zoom = typeof paint.scale === "number" && Number.isFinite(paint.scale) && paint.scale > 0 ? paint.scale : 1;
        const ox = typeof paint.offsetX === "number" && Number.isFinite(paint.offsetX) ? paint.offsetX : 0;
        const oy = typeof paint.offsetY === "number" && Number.isFinite(paint.offsetY) ? paint.offsetY : 0;
        // Pattern content is relative to the tile origin; x/y are already on <pattern>.
        if (paint.scaleBehavior === "fill") {
            tf = `translate(${n(w * (1 - zoom) / 2 + ox * w)} ${n(h * (1 - zoom) / 2 + oy * h)}) scale(${n(w / sw * zoom, 5)} ${n(h / sh * zoom, 5)})`;
        }
        else if (paint.scaleBehavior === "tile") {
            tf = `scale(${n(zoom, 5)})`;
            pw = sw * zoom;
            ph = sh * zoom;
        }
        else {
            const base = Math.max(w / sw, h / sh); // cover before custom cropping
            const s = base * zoom;
            // XD offsets are normalized against the cover-fitted image, before zoom.
            tf = `translate(${n((w - sw * s) / 2 + ox * sw * base)} ${n((h - sh * s) / 2 + oy * sh * base)}) scale(${n(s, 5)})`;
        }
        const flip = paint.flipX || paint.flipY ? `<g transform="translate(${paint.flipX ? n(pw) : 0} ${paint.flipY ? n(ph) : 0}) scale(${paint.flipX ? -1 : 1} ${paint.flipY ? -1 : 1})">` : "";
        c.defs.push(`<pattern id="${id}" patternUnits="userSpaceOnUse" x="${n(x)}" y="${n(y)}" width="${n(pw)}" height="${n(ph)}">${flip}<use href="#img-${esc(paint.imageRef)}" transform="${tf}"/>${flip ? "</g>" : ""}</pattern>`);
        return { value: `url(#${id})` };
    }
    return { value: "#cccccc" };
}
/* ---------- geometry ---------- */
function roundedRect(x, y, w, h, r) {
    const rs = (Array.isArray(r) ? r : [r, r, r, r]).map((v) => Math.max(0, Math.min(Number(v) || 0, w / 2, h / 2)));
    const [tl, tr, br, bl] = [rs[0] ?? 0, rs[1] ?? rs[0] ?? 0, rs[2] ?? rs[0] ?? 0, rs[3] ?? rs[0] ?? 0];
    return `M${n(x + tl)} ${n(y)}H${n(x + w - tr)}A${n(tr)} ${n(tr)} 0 0 1 ${n(x + w)} ${n(y + tr)}V${n(y + h - br)}A${n(br)} ${n(br)} 0 0 1 ${n(x + w - br)} ${n(y + h)}H${n(x + bl)}A${n(bl)} ${n(bl)} 0 0 1 ${n(x)} ${n(y + h - bl)}V${n(y + tl)}A${n(tl)} ${n(tl)} 0 0 1 ${n(x + tl)} ${n(y)}Z`;
}
const matrixAttr = (m) => `matrix(${[m.a, m.b, m.c, m.d, m.tx, m.ty].map((v) => n(v ?? 0, 6)).join(" ")})`;
/** Shape element in the node's local space. `attrs` is a ready-made attribute string. */
function geom(node, attrs, tf) {
    const t = tf ? ` transform="${tf}"` : "";
    const b = node.localBox ?? { x: 0, y: 0, width: node.width ?? 0, height: node.height ?? 0 };
    switch (node.type) {
        case "rectangle": {
            const r = node.cornerRadius;
            if (Array.isArray(r))
                return `<path${t} d="${roundedRect(b.x, b.y, b.width, b.height, r)}" ${attrs}/>`;
            const rr = Math.max(0, Math.min(Number(r) || 0, b.width / 2, b.height / 2));
            return `<rect${t} x="${n(b.x)}" y="${n(b.y)}" width="${n(b.width)}" height="${n(b.height)}"${rr ? ` rx="${n(rr)}"` : ""} ${attrs}/>`;
        }
        case "ellipse":
            return `<ellipse${t} cx="${n(b.x + b.width / 2)}" cy="${n(b.y + b.height / 2)}" rx="${n(b.width / 2)}" ry="${n(b.height / 2)}" ${attrs}/>`;
        case "line": {
            const p = node.points ?? [];
            return p.length === 2 ? `<line${t} x1="${n(p[0].x)}" y1="${n(p[0].y)}" x2="${n(p[1].x)}" y2="${n(p[1].y)}" ${attrs}/>` : "";
        }
        case "path":
        case "boolean":
            return node.svgPathLocal ? `<path transform="${tf ? tf + " " : ""}translate(${n(b.x)} ${n(b.y)})" d="${esc(node.svgPathLocal)}"${node.fillRule ? ` fill-rule="${node.fillRule === "evenodd" ? "evenodd" : "nonzero"}"` : ""} ${attrs}/>` : "";
    }
    return "";
}
function objectBlur(effects = []) {
    return Math.max(0, ...effects.filter(e => e.visible !== false && ["blur", "uxdesign#blur"].includes(e.type) && !e.params?.backgroundEffect).map(e => Number(e.params?.blurAmount ?? e.params?.radius ?? 0) || 0));
}
function backgroundFillOpacity(node) {
    const effect = node.effects?.find((e) => e.visible !== false && ["blur", "uxdesign#blur"].includes(e.type) && e.params?.backgroundEffect);
    return effect && Number.isFinite(effect.params?.fillOpacity) ? Math.max(0, Math.min(1, effect.params.fillOpacity)) : 1;
}
function shadowFilter(c, effects, content) {
    const shadows = (effects ?? []).filter((e) => e.type === "dropShadow" && e.visible !== false).flatMap((e) => e.shadows ?? []);
    const blur = objectBlur(effects);
    if (!shadows.length && !blur)
        return undefined;
    const id = uid(c, "f");
    const parts = shadows.map((s, i) => `<feGaussianBlur in="SourceAlpha" stdDeviation="${n((s.blur ?? 0) / 2)}" result="b${i}"/><feOffset in="b${i}" dx="${n(s.x)}" dy="${n(s.y)}" result="o${i}"/><feFlood flood-color="${col(s.color)}" flood-opacity="${n(s.alpha ?? 1)}" result="c${i}"/><feComposite in="c${i}" in2="o${i}" operator="in" result="s${i}"/>`);
    const merge = shadows.map((_, i) => `<feMergeNode in="s${i}"/>`).join("") + `<feMergeNode in="SourceGraphic"/>`;
    const b = content ? effectBounds(content, effects) : { x: -10000, y: -10000, width: 20000, height: 20000 };
    c.defs.push(`<filter id="${id}" filterUnits="userSpaceOnUse" x="${n(b.x)}" y="${n(b.y)}" width="${n(Math.max(1, b.width))}" height="${n(Math.max(1, b.height))}" color-interpolation-filters="sRGB">${parts.join("")}<feMerge result="merged">${merge}</feMerge>${blur ? `<feGaussianBlur in="merged" stdDeviation="${n(blur / 2)}"/>` : ""}</filter>`);
    return id;
}
/* ---------- text ---------- */
function renderText(c, node) {
    const t = node.text;
    const box = node.box ?? { x: node.x ?? 0, y: node.y ?? 0, width: node.width ?? 0, height: node.height ?? 0 };
    const size = t.font?.size ?? 14;
    const lh = t.lineHeight ?? size * 1.17;
    const fill = (node.fills ?? [])[0];
    const baseColor = fill?.type === "solid" ? col(fill.color) : fill?.type === "gradient" ? col(fill.stops?.[0]?.color) : "#000000";
    const baseOpacity = fill?.type === "solid" ? fill.opacity : 1;
    const family = `${esc(t.font?.family ?? "sans-serif")}, ${c.fontFallback}`;
    const weight = weightOf(t.font?.style);
    const characters = String(t.characters ?? "");
    const saved = Array.isArray(t.layoutLines) && t.layoutLines.length > 0;
    let offset = 0;
    const lines = saved ? t.layoutLines.map((line) => ({ ...line, value: characters.slice(line.from, line.to).replace(/[\r\n]+$/, "") })) : characters.split("\n").map((value, li) => {
        const line = { value, from: offset, y: (t.baselineY ?? box.y + size) + li * lh };
        offset += value.length + 1;
        return line;
    });
    const anchor = saved ? "start" : t.alignment === "right" ? "end" : t.alignment === "center" ? "middle" : "start";
    const ax = anchor === "end" ? box.x + box.width : anchor === "middle" ? box.x + box.width / 2 : box.x;
    const spacing = t.letterSpacing?.px ? ` letter-spacing="${n(t.letterSpacing.px)}"` : "";
    const runs = t.styledRuns ?? [];
    const out = [];
    lines.forEach((layout) => {
        const line = layout.value;
        const y = layout.y, lineX = saved ? layout.x : ax;
        const start = layout.from, end = start + line.length;
        // split the line at run boundaries
        const cuts = new Set([start, end]);
        for (const r of runs)
            for (const p of [r.from, r.to])
                if (p > start && p < end)
                    cuts.add(p);
        const pts = [...cuts].sort((a, b) => a - b);
        const spans = [];
        for (let i = 0; i + 1 < pts.length; i++) {
            const a = pts[i], b = pts[i + 1];
            const seg = line.slice(a - start, b - start);
            const r = runs.filter((x) => x.from <= a && x.to >= b).reduce((acc, x) => ({ ...acc, ...x }), {});
            const at = [
                r.color ? `fill="${col(r.color)}"` : "",
                r.size ? `font-size="${n(r.size)}"` : "",
                r.weight ? `font-weight="${weightOf(r.weight)}"${isItalic(r.weight) ? ' font-style="italic"' : ""}` : "",
                r.family ? `font-family="${esc(r.family)}, ${c.fontFallback}"` : "",
                r.underline ? `text-decoration="underline"` : "",
                r.strikethrough ? `text-decoration="line-through"` : "",
            ].filter(Boolean).join(" ");
            spans.push(`<tspan${i === 0 ? ` x="${n(lineX)}" y="${n(y)}"` : ""}${at ? " " + at : ""}>${esc(seg)}</tspan>`);
        }
        if (!spans.length)
            spans.push(`<tspan x="${n(lineX)}" y="${n(y)}"> </tspan>`);
        out.push(...spans);
    });
    const deco = t.underline ? ` text-decoration="underline"` : "";
    return `<text xml:space="preserve" font-family="${family}" font-size="${n(size)}" font-weight="${weight}"${isItalic(t.font?.style) ? ' font-style="italic"' : ""} fill="${baseColor}"${baseOpacity != null && baseOpacity !== 1 ? ` fill-opacity="${n(baseOpacity)}"` : ""} text-anchor="${anchor}"${spacing}${deco}>${out.join("")}</text>`;
}
/* ---------- tree ---------- */
function styleAttrs(node) {
    const parts = [];
    if (node.opacity != null && node.opacity !== 1)
        parts.push(`opacity="${n(node.opacity)}"`);
    if (["multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn", "hard-light", "soft-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity"].includes(node.blendMode))
        parts.push(`style="mix-blend-mode:${node.blendMode}"`);
    return parts.join(" ");
}
function maskClip(c, mask) {
    const shapes = mask.shapes ?? [mask];
    const id = uid(c, "m");
    const els = shapes
        .map((s) => {
        const node = { type: s.shape, localBox: s.localBox, width: s.width, height: s.height, cornerRadius: s.radius, svgPathLocal: s.svgPathLocal, points: s.points };
        const lb = s.localBox ?? { x: 0, y: 0 };
        // clipPath children must be shapes (a <g> would be ignored and clip everything away)
        return geom(node, "", s.transform ? origin(s.transform, s.x, s.y, lb.x, lb.y) : `translate(${n((s.x ?? 0) - lb.x)} ${n((s.y ?? 0) - lb.y)})`);
    })
        .join("");
    c.defs.push(`<clipPath id="${id}">${els}</clipPath>`);
    return id;
}
/** matrix(a b c d ox oy) so that the local box corner (bx,by) lands on the exported (x,y). */
function origin(m, x, y, bx, by) {
    const ox = x - (m.a * bx + m.c * by);
    const oy = y - (m.b * bx + m.d * by);
    return `matrix(${[m.a, m.b, m.c, m.d].map((v) => n(v, 6)).join(" ")} ${n(ox)} ${n(oy)})`;
}
function renderNode(c, node) {
    if (node.visible === false || node.type === "unresolvedRef")
        return "";
    const sa = styleAttrs(node);
    const filter = node.effects?.some((e) => e.visible !== false && (e.type === "dropShadow" || objectBlur([e]) > 0)) ? shadowFilter(c, node.effects, contentBounds(node)) : undefined;
    const wrap = (inner, tf) => {
        const attrs = [tf ? `transform="${tf}"` : "", sa, filter ? `filter="url(#${filter})"` : ""].filter(Boolean).join(" ");
        return attrs ? `<g ${attrs}>${inner}</g>` : inner;
    };
    switch (node.type) {
        case "text":
            return wrap(renderText(c, node));
        case "rectangle":
        case "ellipse":
        case "line":
        case "path":
        case "boolean": {
            const lb = node.localBox ?? { x: 0, y: 0, width: node.width ?? 0, height: node.height ?? 0 };
            const x = node.x ?? 0, y = node.y ?? 0;
            const m = node.transform;
            const tf = m ? origin(m, x, y, lb.x, lb.y) : `translate(${n(x - lb.x)} ${n(y - lb.y)})`;
            const box = { x: lb.x, y: lb.y, width: lb.width, height: lb.height };
            const f = node.fills?.[0];
            const fp = f ? paintAttr(c, f, box) : { value: "none" };
            const fillOpacity = (fp.opacity ?? 1) * backgroundFillOpacity(node);
            const fillAttrs = `fill="${fp.value}"${fillOpacity !== 1 ? ` fill-opacity="${n(fillOpacity)}"` : ""}`;
            const s = node.strokes?.[0];
            let strokeEl = "";
            let underStroke = "";
            let fillOnly = geom(node, `${fillAttrs} stroke="none"`);
            if (node.type === "boolean" && !node.svgPathLocal)
                fillOnly = (node.children ?? []).map((k) => renderNode(c, k)).join("");
            if (s && s.width) {
                const sp = paintAttr(c, s, box);
                const common = `fill="none" stroke="${sp.value}"${sp.opacity != null && sp.opacity !== 1 ? ` stroke-opacity="${n(sp.opacity)}"` : ""}${s.cap ? ` stroke-linecap="${s.cap === "round" ? "round" : s.cap === "square" ? "square" : "butt"}"` : ""}${s.join ? ` stroke-linejoin="${s.join === "round" ? "round" : s.join === "bevel" ? "bevel" : "miter"}"` : ""}${s.miterLimit ? ` stroke-miterlimit="${n(s.miterLimit)}"` : ""}${Array.isArray(s.dash) && s.dash.length ? ` stroke-dasharray="${s.dash.map((d) => n(d)).join(" ")}"` : ""}`;
                if (s.align === "inside" && node.type !== "line") {
                    const cid = uid(c, "c");
                    c.defs.push(`<clipPath id="${cid}">${geom(node, "")}</clipPath>`);
                    strokeEl = `<g clip-path="url(#${cid})">${geom(node, `${common} stroke-width="${n(s.width * 2)}"`)}</g>`;
                }
                else if (s.align === "outside" && node.type !== "line") {
                    underStroke = geom(node, `${common} stroke-width="${n(s.width * 2)}"`); // the fill is drawn over the inner half
                }
                else
                    strokeEl = geom(node, `${common} stroke-width="${n(s.width)}"`);
            }
            return wrap(underStroke + fillOnly + strokeEl, tf);
        }
        default: {
            // frame / group
            const kids = (node.children ?? []).map((k) => renderNode(c, k)).join("");
            const m = node.transform;
            const lin = m && !(m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1) ? ` matrix(${[m.a, m.b, m.c, m.d].map((v) => n(v, 6)).join(" ")} 0 0)` : "";
            const tf = node.type === "frame" ? undefined : `translate(${n(node.x ?? 0)} ${n(node.y ?? 0)})${lin}`;
            let inner = kids;
            if (node.fills?.length) {
                const b = { x: 0, y: 0, width: node.width ?? 0, height: node.height ?? 0 };
                const fp = paintAttr(c, node.fills[0], b);
                if (b.width && b.height)
                    inner = `<rect width="${n(b.width)}" height="${n(b.height)}" fill="${fp.value}"${fp.opacity != null && fp.opacity !== 1 ? ` fill-opacity="${n(fp.opacity)}"` : ""}/>` + inner;
            }
            if (node.mask)
                inner = `<g clip-path="url(#${maskClip(c, node.mask)})">${inner}</g>`;
            return wrap(inner, tf);
        }
    }
}
function unionBounds(boxes) {
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const b of boxes) {
        if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite))
            continue;
        left = Math.min(left, b.x);
        top = Math.min(top, b.y);
        right = Math.max(right, b.x + b.width);
        bottom = Math.max(bottom, b.y + b.height);
    }
    return left === Infinity ? undefined : { x: left, y: top, width: right - left, height: bottom - top };
}
function effectBounds(box, effects = []) {
    const shadows = effects.filter(e => e.type === "dropShadow" && e.visible !== false).flatMap(e => e.shadows ?? []);
    const result = unionBounds([box, ...shadows.map((s) => {
            const pad = Math.max(0, s.blur ?? 0) * 1.5; // Gaussian sigma = blur / 2; retain three sigma.
            return { x: box.x + (s.x ?? 0) - pad, y: box.y + (s.y ?? 0) - pad, width: box.width + 2 * pad, height: box.height + 2 * pad };
        })]);
    const pad = objectBlur(effects) * 1.5;
    return { x: result.x - pad, y: result.y - pad, width: result.width + 2 * pad, height: result.height + 2 * pad };
}
/** Bounds in the coordinate system used by this node's SVG content, before its wrapper transform. */
function contentBounds(node) {
    if (node.type === "text")
        return node.box ?? { x: node.x ?? 0, y: node.y ?? 0, width: node.width ?? 0, height: node.height ?? 0 };
    if (["rectangle", "ellipse", "line", "path", "boolean"].includes(node.type) && !(node.type === "boolean" && !node.svgPathLocal)) {
        const b = node.localBox ?? { x: 0, y: 0, width: node.width ?? 0, height: node.height ?? 0 };
        const s = node.strokes?.[0];
        let pad = s ? Math.max(0, s.width ?? 0) * (s.align === "inside" && node.type !== "line" ? 0 : s.align === "outside" && node.type !== "line" ? 1 : 0.5) : 0;
        if (s && pad) {
            if (node.type === "line" && s.cap === "square")
                pad *= Math.SQRT2;
            if (["path", "boolean"].includes(node.type) && (!s.join || s.join === "miter"))
                pad *= Math.max(1, s.miterLimit ?? 4);
        }
        return { x: b.x - pad, y: b.y - pad, width: b.width + 2 * pad, height: b.height + 2 * pad };
    }
    const children = (node.children ?? []).map((k) => visualBounds(k));
    if (node.fills?.length && node.width && node.height)
        children.push({ x: 0, y: 0, width: node.width, height: node.height });
    return unionBounds(children);
}
/** Parent-space painted bounds, including nested affine transforms, strokes and shadows. */
export function visualBounds(node) {
    if (node.visible === false || node.type === "unresolvedRef")
        return undefined;
    const base = contentBounds(node);
    if (!base)
        return undefined;
    const b = effectBounds(base, node.effects);
    if (node.type === "frame" || node.type === "text")
        return b;
    const m = node.transform ?? { a: 1, b: 0, c: 0, d: 1 };
    const shape = ["rectangle", "ellipse", "line", "path", "boolean"].includes(node.type);
    const lb = shape ? node.localBox ?? { x: 0, y: 0 } : { x: 0, y: 0 };
    const tx = (node.x ?? 0) - m.a * lb.x - m.c * lb.y;
    const ty = (node.y ?? 0) - m.b * lb.x - m.d * lb.y;
    const points = [[b.x, b.y], [b.x + b.width, b.y], [b.x, b.y + b.height], [b.x + b.width, b.y + b.height]].map(([x, y]) => ({ x: m.a * x + m.c * y + tx, y: m.b * x + m.d * y + ty, width: 0, height: 0 }));
    return unionBounds(points);
}
/** Full artboards retain their intended canvas; individual layers use their painted bounds. */
function viewportOf(node) {
    if (node.type === "frame")
        return { x: 0, y: 0, width: node.width ?? 0, height: node.height ?? 0 };
    return visualBounds(node) ?? { x: 0, y: 0, width: node.width ?? 100, height: node.height ?? 100 };
}
function imageSize(b) {
    if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47)
        return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
        for (let i = 2; i + 9 < b.length;) {
            if (b[i] !== 0xff) {
                i++;
                continue;
            }
            const marker = b[i + 1];
            if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
                return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
            i += 2 + b.readUInt16BE(i + 2);
        }
    }
    if (b.length > 10 && b.subarray(0, 3).toString("ascii") === "GIF")
        return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
    return { width: 100, height: 100 };
}
function mimeOf(b) {
    if (b.subarray(0, 4).toString("hex") === "89504e47")
        return "image/png";
    if (b.subarray(0, 3).toString("hex") === "ffd8ff")
        return "image/jpeg";
    if (b.subarray(0, 3).toString("ascii") === "GIF")
        return "image/gif";
    if (b.subarray(0, 4).toString("ascii") === "RIFF")
        return "image/webp";
    if (b.subarray(0, 300).toString("utf8").includes("<svg"))
        return "image/svg+xml";
    return "application/octet-stream";
}
export async function buildSvg(doc, node, imageRefs, viewport) {
    const images = new Map();
    const missing = [];
    let embedded = 0;
    for (const ref of imageRefs) {
        if (!/^[0-9a-f]{16,64}$/i.test(ref) || !doc.zip.file(`resources/${ref}`)) {
            missing.push(ref);
            continue;
        }
        let buf;
        try {
            buf = await readEntry(doc, `resources/${ref}`);
        }
        catch {
            missing.push(ref);
            continue;
        }
        embedded += buf.length;
        if (embedded > MAX_EMBED_BYTES)
            throw new Error(`The images on this screen exceed ${MAX_EMBED_BYTES / 1048576} MB in total; render a smaller part with nodeId.`);
        const { width, height } = imageSize(buf);
        images.set(ref, { uri: `data:${mimeOf(buf)};base64,${buf.toString("base64")}`, width, height });
    }
    const c = { defs: [], images, usedImages: new Set(), seq: 1, fontFallback: "'Segoe UI', Arial, Helvetica, sans-serif" };
    const body = renderNode(c, node);
    const vp = viewport ?? viewportOf(node);
    const defImages = [...c.usedImages].map((r) => `<image id="img-${esc(r)}" width="${images.get(r).width}" height="${images.get(r).height}" href="${images.get(r).uri}"/>`);
    const w = Math.max(1, Math.ceil(vp.width)), h = Math.max(1, Math.ceil(vp.height));
    const bg = node.type === "frame" ? "" : "";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${n(vp.x)} ${n(vp.y)} ${w} ${h}">${bg}<defs>${defImages.join("")}${c.defs.join("")}</defs>${body}</svg>`;
    return { svg, width: w, height: h, missingImages: missing };
}
/* ---------- screenshot ---------- */
const WIN_CANDIDATES = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];
const MAC_CANDIDATES = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
];
const LINUX_CANDIDATES = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge", "/snap/bin/chromium"];
export async function findBrowser() {
    const env = process.env.XD_MCP_CHROME;
    const list = [...(env ? [env] : []), ...(process.platform === "win32" ? WIN_CANDIDATES : process.platform === "darwin" ? MAC_CANDIDATES : LINUX_CANDIDATES)];
    for (const p of list) {
        try {
            await access(p, constants.X_OK);
            return p;
        }
        catch {
            /* try next */
        }
    }
    return undefined;
}
function run(cmd, args, timeoutMs) {
    return new Promise((resolve, reject) => {
        const child = execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (err) => (err ? reject(err) : resolve()));
        child.stdin?.end();
    });
}
const MAX_EMBED_BYTES = 200 * 1024 * 1024; // total image data embedded into one SVG
const MAX_CSS_EDGE = 16384; // px of the unscaled artboard
const MAX_PNG_BYTES = 12 * 1024 * 1024;
export async function renderArtboard(doc, ab, opts = {}) {
    const browser = await findBrowser();
    if (!browser)
        throw new Error("No Chrome or Edge found. Install one, or set XD_MCP_CHROME to the browser executable.");
    const whole = await exportWhole(doc, ab, { nodeId: opts.nodeId });
    const { svg, width, height, missingImages } = await buildSvg(doc, whole.node, [...whole.images]);
    if (width > MAX_CSS_EDGE || height > MAX_CSS_EDGE)
        throw new Error(`This artboard is ${width}x${height}px, too large to render in one go (limit ${MAX_CSS_EDGE}). Render a smaller part with nodeId.`);
    const maxEdge = Math.min(opts.maxEdge ?? 4096, 8192);
    const scale = Math.max(0.05, Math.min(opts.scale ?? 1, maxEdge / Math.max(width, height), 4));
    const dir = await mkdtemp(path.join(tmpdir(), "xd-render-"));
    try {
        const svgPath = path.join(dir, "artboard.svg");
        const outPath = path.join(dir, "out.png");
        await writeFile(svgPath, svg, "utf8");
        await run(browser, [
            "--headless=new",
            "--disable-gpu",
            "--hide-scrollbars",
            "--no-first-run",
            "--disable-extensions",
            "--disable-background-networking",
            "--host-resolver-rules=MAP * ~NOTFOUND", // no network, even if something tried
            `--user-data-dir=${path.join(dir, "profile")}`,
            `--force-device-scale-factor=${scale}`,
            `--window-size=${width},${height}`,
            "--virtual-time-budget=6000",
            `--screenshot=${outPath}`,
            pathToFileURL(svgPath).href,
        ], 90_000);
        const png = await readFile(outPath);
        if (png.length > MAX_PNG_BYTES)
            throw new Error(`The PNG is ${Math.round(png.length / 1048576)} MB; lower scale or maxEdge.`);
        return { png, width: Math.round(width * scale), height: Math.round(height * scale), scale, missingImages, browser: path.basename(browser) };
    }
    finally {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
}
/* ---------- selected layers as one SVG ---------- */
/**
 * Keep only the selected layers (with everything inside them) and the groups above them, so transforms, masks and
 * opacity still apply. The wrappers lose their own paint and shadows, so nothing but the selection is drawn.
 */
function prune(n, ids, found) {
    if (n.id && ids.has(n.id)) {
        found.add(n.id);
        return n;
    }
    const kids = (n.children ?? []).map((k) => prune(k, ids, found)).filter((k) => !!k);
    if (!kids.length)
        return undefined;
    const { fills: _f, strokes: _s, effects: _e, ...rest } = n;
    void _f;
    void _s;
    void _e;
    return { ...rest, children: kids };
}
const MAX_SVG_LAYERS = 500;
/** Export the given layers (ids from xd_export_artboard or the `parts` of xd_infer_layout) as ONE self-contained SVG. */
export async function layersToSvg(doc, ab, ids, padding = 2) {
    const wanted = [...new Set(ids.filter((i) => typeof i === "string" && i.length > 0 && i.length <= 200))].slice(0, MAX_SVG_LAYERS);
    if (!wanted.length)
        throw new Error("Give at least one layer id.");
    const whole = await exportWhole(doc, ab, {});
    const set = new Set(wanted);
    const found = new Set();
    const pruned = prune(whole.node, set, found);
    if (!pruned)
        throw new Error(`None of the ${wanted.length} layer ids exist in this artboard.`);
    const bounds = visualBounds(pruned);
    if (!bounds)
        throw new Error("The selected layers have no visible size.");
    const pad = Math.max(0, Math.min(padding, 50));
    const viewport = { x: bounds.x - pad, y: bounds.y - pad, width: bounds.width + 2 * pad, height: bounds.height + 2 * pad };
    if (viewport.width > 20000 || viewport.height > 20000)
        throw new Error("The selection is too large for one SVG; select fewer layers.");
    const refs = [...collectImageRefs(pruned)];
    const svg = await buildSvg(doc, pruned, refs, viewport);
    return { ...svg, found: [...found], missing: wanted.filter((i) => !found.has(i)) };
}
