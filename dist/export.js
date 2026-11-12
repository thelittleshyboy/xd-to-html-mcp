import { arr, childrenOf, own, readJson, rootNodes } from "./xd.js";
import { pathBox, translatePath } from "./pathgeom.js";
import { prefetchSources, MAX_SYNC } from "./refs.js";
/**
 * Full-fidelity, tool-friendly export of an XD scene graph.
 * Output uses design-tool vocabulary (frame, rectangle, ellipse, path, text, fills, strokes, effects)
 * so an AI can rebuild it in Figma or similar.
 *
 * Coordinate rules (what the numbers mean):
 *  - `x`,`y` are in the PARENT's space. For groups they are the group's origin; for shapes and text they
 *    are the top-left of the shape's box after the node's own transform.
 *  - Top-level layers of an artboard are made artboard-relative (the artboard's canvas position is removed).
 *  - `transform` is the full matrix {a,b,c,d,tx,ty} with `transformOrigin: "top-left"`: rotation and flips
 *    pivot about the node's origin, not its centre.
 *  - Masks are in the masked group's local space (the same space as its children).
 */
const RES_PATH = "resources/graphics/graphicContent.agc";
const MAX_DEPTH_CAP = 64;
/** A linked component can reference others, so a hostile file could expand into billions of layers. */
const MAX_EXPORT_NODES = 400_000;
/* ---------- colors / paints ---------- */
const round = (n, p = 100) => (typeof n === "number" ? Math.round(n * p) / p : n);
const hex2 = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
function isColor(c) {
    return c && typeof c === "object" && c.mode === "RGB" && c.value && typeof c.value.r === "number";
}
export function colorOf(c) {
    if (!isColor(c))
        return undefined;
    const v = c.value;
    return { color: `#${hex2(v.r)}${hex2(v.g)}${hex2(v.b)}`, alpha: round(c.alpha ?? 1, 1000) };
}
/** Deep-copy `o`, replacing XD color objects by {color, alpha}. */
function convertColors(o) {
    if (Array.isArray(o))
        return o.map(convertColors);
    if (isColor(o))
        return colorOf(o);
    if (o && typeof o === "object") {
        const out = {};
        for (const [k, v] of Object.entries(o))
            out[k] = convertColors(v);
        return out;
    }
    return o;
}
function gradientOf(p) {
    const g = p.gradient ?? {};
    const res = g.meta?.ux?.gradientResources ?? g;
    const kind = res.type === "radial" ? "radial" : "linear";
    const stops = arr(res.stops).map((s) => {
        const c = colorOf(s.color);
        return { offset: round(s.offset, 1000), color: c?.color, opacity: c?.alpha };
    });
    return clean({
        type: "gradient",
        kind,
        stops,
        units: g.units ?? "objectBoundingBox",
        x1: g.x1, y1: g.y1, x2: g.x2, y2: g.y2, // linear
        cx: g.cx, cy: g.cy, r: g.r, fx: g.fx, fy: g.fy, // radial
        transform: g.transform,
        opacity: undefined,
    });
}
function paintOf(p, images) {
    if (!p || p.type === "none")
        return undefined;
    if (p.type === "solid") {
        const c = colorOf(p.color);
        return c && { type: "solid", color: c.color, opacity: c.alpha };
    }
    if (p.type === "pattern") {
        const pat = p.pattern ?? {};
        const uid = pat.meta?.ux?.uid;
        if (uid)
            images.add(uid);
        return {
            type: "image",
            imageRef: uid,
            scaleBehavior: pat.meta?.ux?.scaleBehavior, // "cover" (slice) | "fill" (stretch) | "tile"
            flipX: pat.meta?.ux?.flipX,
            flipY: pat.meta?.ux?.flipY,
            scale: pat.meta?.ux?.scale,
            offsetX: pat.meta?.ux?.offsetX,
            offsetY: pat.meta?.ux?.offsetY,
            sourceWidth: pat.width,
            sourceHeight: pat.height,
        };
    }
    if (p.type === "gradient")
        return gradientOf(p);
    return convertColors(p);
}
function strokeOf(s, images) {
    const paint = paintOf(s, images);
    if (!paint)
        return undefined;
    return clean({
        ...paint,
        width: s.width,
        align: s.align, // inside | center | outside
        cap: s.cap,
        join: s.join,
        miterLimit: s.miterLimit,
        dash: s.dash,
        dashOffset: s.dashOffset,
    });
}
function effectsOf(style) {
    const out = [];
    for (const f of arr(style?.filters)) {
        if (f?.type === "dropShadow") {
            out.push({
                type: "dropShadow",
                visible: f.visible !== false,
                // XD's blur radius is 2x the Gaussian standard deviation
                shadows: arr(f.params?.dropShadows).map((s) => ({ x: s.dx, y: s.dy, blur: s.r, ...colorOf(s.color) })),
            });
        }
        else {
            out.push({ type: f?.type ?? "unknown", visible: f?.visible !== false, params: convertColors(f?.params) });
        }
    }
    if (style?.blur)
        out.push({ type: "blur", params: convertColors(style.blur) });
    return out;
}
const ident = (t) => t.a === 1 && t.b === 0 && t.c === 0 && t.d === 1;
function matrixOf(n) {
    const t = n.transform ?? {};
    return { a: t.a ?? 1, b: t.b ?? 0, c: t.c ?? 0, d: t.d ?? 1, tx: t.tx ?? 0, ty: t.ty ?? 0 };
}
const apply = (m, x, y) => ({ x: m.a * x + m.c * y + m.tx, y: m.b * x + m.d * y + m.ty });
/** Local (untransformed) bounding box of a shape, in the node's own coordinate space. */
function localBox(shape) {
    switch (shape?.type) {
        case "rect":
            return { x: shape.x ?? 0, y: shape.y ?? 0, width: shape.width, height: shape.height };
        case "circle":
            return { x: shape.cx - shape.r, y: shape.cy - shape.r, width: shape.r * 2, height: shape.r * 2 };
        case "ellipse":
            return { x: shape.cx - shape.rx, y: shape.cy - shape.ry, width: shape.rx * 2, height: shape.ry * 2 };
        case "line":
            return { x: Math.min(shape.x1, shape.x2), y: Math.min(shape.y1, shape.y2), width: Math.abs(shape.x2 - shape.x1), height: Math.abs(shape.y2 - shape.y1) };
        case "path":
        case "compound": {
            const b = typeof shape.path === "string" ? pathBox(shape.path) : undefined;
            return b && { x: b.x, y: b.y, width: b.width, height: b.height, approx: b.approx };
        }
    }
    return undefined;
}
/* ---------- text ---------- */
const SOFT_BREAKS = new RegExp("[" + String.fromCharCode(11, 8232, 8233) + "]", "g"); // vertical tab, line sep, paragraph sep
/** Approximate average glyph advance, in em, used only when XD stores no width (single-line "point" text). */
const AVG_EM = 0.53;
function solidHex(p) {
    return p?.type === "solid" ? colorOf(p.color)?.color : undefined;
}
function normalizeText(n, m, ctx) {
    const t = n.text;
    const style = n.style ?? {};
    const font = style.font;
    const attrs = style.textAttributes ?? {};
    const size = font?.size ?? 14;
    const characters = String(t.rawText ?? "").replace(SOFT_BREAKS, "\n").replace(/\r\n?/g, "\n");
    const lines = characters.split("\n");
    const lineHeight = typeof attrs.lineHeight === "number" ? attrs.lineHeight : undefined;
    const lh = lineHeight ?? size * 1.17;
    const alignment = attrs.paragraphAlign ?? "left";
    const frame = t.frame ?? {};
    const isArea = frame.type === "area";
    // per-line x offsets stored by XD: negative for right/centre aligned point text
    const lineXs = [];
    const layoutLines = [];
    let firstLineY = 0;
    let gotFirst = false;
    for (const p of arr(t.paragraphs))
        for (const line of arr(p.lines)) {
            const first = line?.[0];
            if (typeof first?.x === "number")
                lineXs.push(first.x);
            if (!gotFirst && typeof first?.y === "number") {
                firstLineY = first.y;
                gotFirst = true;
            }
            const spans = arr(line).filter(r => Number.isInteger(r.from) && Number.isInteger(r.to));
            if (spans.length && Number.isFinite(first?.x) && Number.isFinite(first?.y)) {
                const from = Math.min(...spans.map(r => r.from)), to = Math.max(...spans.map(r => r.to));
                if (from >= 0 && to >= from && to <= characters.length)
                    layoutLines.push({ from, to, x: first.x, y: first.y });
            }
        }
    const minX = lineXs.length ? Math.min(...lineXs) : 0;
    const origin = apply(m, 0, 0);
    const baselineY = origin.y + firstLineY;
    const top = baselineY - ((lh - 1.17 * size) / 2 + 0.92 * size);
    let width = isArea ? frame.width : undefined;
    let widthApprox = false;
    if (width === undefined) {
        if (minX < 0)
            width = alignment === "center" ? -2 * minX : -minX;
        else {
            width = Math.max(...lines.map((l) => l.length), 1) * size * AVG_EM;
            widthApprox = true;
        }
    }
    const left = isArea ? origin.x : origin.x + Math.min(minX, 0);
    const lineCount = Math.max(lines.length, 1);
    const height = isArea && typeof frame.height === "number" ? frame.height : lineCount * lh;
    const runs = [];
    const seen = new Set();
    for (const p of arr(t.paragraphs))
        for (const line of arr(p.lines))
            for (const r of arr(line)) {
                const s = r.style;
                if (!s || typeof r.from !== "number")
                    continue;
                const deco = arr(s.textAttributes?.decoration);
                const run = clean({
                    from: r.from,
                    to: r.to,
                    color: solidHex(s.fill),
                    size: s.fontSize ?? s.font?.size,
                    weight: s.fontStyle ?? s.font?.style,
                    family: s.fontFamily ?? s.font?.family,
                    underline: deco.includes("underline") || undefined,
                    strikethrough: deco.includes("strikethrough") || undefined,
                });
                const key = `${run.from}-${run.to}-${JSON.stringify(run)}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    runs.push(run);
                }
            }
    const nodeDeco = arr(attrs.decoration);
    if (font) {
        const key = `${font.postscriptName ?? font.family}|${font.style ?? ""}`;
        const e = ctx.fonts.get(key) ?? { family: font.family, postscriptName: font.postscriptName, style: font.style, sizes: new Set(), uses: 0 };
        e.sizes.add(size);
        e.uses++;
        ctx.fonts.set(key, e);
    }
    for (const r of runs)
        if (r.family || r.weight) {
            const key = `${r.family ?? font?.family}|${r.weight ?? font?.style ?? ""}`;
            if (!ctx.fonts.has(key))
                ctx.fonts.set(key, { family: r.family ?? font?.family, postscriptName: undefined, style: r.weight ?? font?.style, sizes: new Set([r.size ?? size]), uses: 1 });
        }
    return {
        text: clean({
            characters,
            font: font && { family: font.family, postscriptName: font.postscriptName, style: font.style, size },
            lineHeight,
            alignment,
            autoResize: isArea ? (typeof frame.height === "number" ? "NONE" : "HEIGHT") : "WIDTH_AND_HEIGHT",
            maxWidth: isArea ? frame.width : undefined,
            letterSpacing: typeof attrs.charSpacing === "number" ? { em: round(attrs.charSpacing / 1000, 1000), px: round((attrs.charSpacing / 1000) * size, 100) } : undefined,
            underline: nodeDeco.includes("underline") || undefined,
            // offsets index into `characters` (soft breaks were replaced one-for-one by "\n")
            styledRuns: runs.length ? runs : undefined,
            baselineY: round(baselineY),
            layoutLines: layoutLines.length ? layoutLines.map(line => ({ ...line, x: round(origin.x + line.x), y: round(origin.y + line.y) })) : undefined,
            widthApprox: widthApprox || undefined,
        }),
        box: { x: round(left), y: round(top), width: round(width), height: round(height) },
    };
}
function interactionOut(i, ctx) {
    const p = i.properties ?? {};
    return clean({
        trigger: i.triggerEvent, // tap | hover | time | ...
        action: i.action, // artboard-transition | state-transition | auto-animate | scroll-transition
        destinationId: p.destination,
        destinationName: ctx.artboardNames?.get(p.destination),
        transition: p.transition,
        duration: p.duration,
        easing: p.easing,
        delay: p.delay,
    });
}
function constraintsOf(ux) {
    if (!ux || ux.constraintsDisabled)
        return undefined;
    const keys = ["Left", "Right", "Top", "Bottom", "Width", "Height"];
    if (!keys.some((k) => ux["constraint" + k] !== undefined))
        return undefined;
    return {
        left: !!ux.constraintLeft,
        right: !!ux.constraintRight,
        top: !!ux.constraintTop,
        bottom: !!ux.constraintBottom,
        fixedWidth: !!ux.constraintWidth,
        fixedHeight: !!ux.constraintHeight,
    };
}
export function clean(o) {
    for (const k of Object.keys(o)) {
        const v = o[k];
        if (v === undefined || (Array.isArray(v) && v.length === 0))
            delete o[k];
    }
    return o;
}
const STATE_NAME = /hover|pressed|active|disabled|focus|selected|state|error|empty/i;
/**
 * Top-level layers of an artboard store canvas coordinates; `offset` (the artboard's canvas
 * position) turns them into artboard-relative ones. Deeper layers are already parent-relative.
 */
function convert(n, ctx, depth, geometry, offset) {
    if (++ctx.nodes > MAX_EXPORT_NODES)
        throw new Error(`Export exceeds ${MAX_EXPORT_NODES} layers. The file probably has recursive or hugely nested linked components; export a smaller part with nodeId.`);
    // Linked component: the real content lives in another layer, referenced by id.
    if (n.type === "syncRef") {
        const src = ctx.sources.get(n.syncSourceGuid);
        if (!src || ctx.syncDepth >= MAX_SYNC || ctx.chain.has(n.syncSourceGuid)) {
            return clean({ id: n.guid ?? n.id, type: "unresolvedRef", name: n.name, sourceId: n.syncSourceGuid, depthLimit: src && ctx.syncDepth >= MAX_SYNC ? true : undefined, cyclic: ctx.chain.has(n.syncSourceGuid) || undefined });
        }
        const inst = {
            ...src,
            id: n.guid ?? src.id,
            name: n.name ?? src.name,
            transform: n.transform ?? src.transform,
            visible: n.visible ?? src.visible,
        };
        ctx.syncDepth++;
        ctx.chain.add(n.syncSourceGuid);
        let out;
        try {
            out = convert(inst, ctx, depth, geometry, offset);
        }
        finally {
            ctx.chain.delete(n.syncSourceGuid);
            ctx.syncDepth--;
        }
        out.linkedFrom = n.syncSourceGuid;
        return out;
    }
    const ux = n.meta?.ux ?? {};
    const style = n.style ?? {};
    const m = matrixOf(n);
    const out = { id: n.id, type: n.type, name: n.name };
    if (n.visible === false) {
        out.visible = false;
        out.hiddenReason = STATE_NAME.test(n.name ?? "") ? `state: ${n.name}` : "hidden in XD";
    }
    if (style.opacity != null && style.opacity !== 1)
        out.opacity = style.opacity; // group opacity multiplies children
    if (style.blendMode && style.blendMode !== "pass-through" && style.blendMode !== "normal")
        out.blendMode = style.blendMode;
    const fill = paintOf(style.fill, ctx.images);
    const stroke = style.stroke ? strokeOf(style.stroke, ctx.images) : undefined;
    if (fill)
        out.fills = [fill];
    if (stroke)
        out.strokes = [stroke];
    out.effects = effectsOf(style);
    const constraints = constraintsOf(ux);
    if (constraints)
        out.constraints = constraints;
    if (ux.markedForExport)
        out.markedForExport = true;
    if (ux.symbolId)
        out.component = { symbolId: ux.symbolId, stateId: ux.stateId, role: ux.isMaster ? "master" : "instance", kind: ux.componentType };
    if (ux.repeatGrid)
        out.repeatGrid = ux.repeatGrid;
    // XD "stacks": a group that lays its children out in a row/column. Each child carries the gap after it.
    if (ux.contentStackType)
        out.stack = { direction: ux.contentStackType };
    if (ux.contentStackMarginAfter !== undefined)
        out.stackMarginAfter = ux.contentStackMarginAfter;
    if (ux.scrollingType)
        out.scrolling = ux.scrollingType;
    const direct = own(ctx.interactions, n.id);
    const inherited = arr(ux.interactions).filter((w) => w.enabled !== false && w.valid !== false);
    const allWires = ctx.interactions ? Object.values(ctx.interactions).flat() : [];
    const wired = [...(Array.isArray(direct) ? direct : []), ...inherited.flatMap((w) => allWires.filter((i) => i.id === w.guid))];
    if (wired.length)
        out.interactions = [...new Map(wired.map((i) => [i.id ?? JSON.stringify(i), i])).values()].map((i) => interactionOut(i, ctx));
    // Masks live in the masked group's local space (the same space as its children).
    const maskShapes = arr(ux.clipPathResources?.children);
    if (maskShapes.length) {
        const shapes = maskShapes.map((s) => {
            const c = convert(s, ctx, depth + 1);
            return clean({
                shape: c.type,
                x: c.x, y: c.y, width: c.width, height: c.height,
                radius: c.cornerRadius,
                svgPathLocal: c.svgPathLocal,
                localBox: c.localBox,
                transform: c.transform,
                transformOrigin: c.transform ? "top-left" : undefined,
            });
        });
        out.mask = shapes.length === 1 ? shapes[0] : { shapes };
    }
    // The full matrix is always emitted when it isn't the identity; rotation is only a convenience.
    const rot = typeof ux.rotation === "number" ? ux.rotation : round((Math.atan2(m.b, m.a) * 180) / Math.PI);
    if (rot)
        out.rotation = rot;
    if (!ident(m)) {
        out.transform = m;
        out.transformOrigin = "top-left";
    }
    const kids = childrenOf(n);
    switch (n.type) {
        case "artboard": {
            out.type = "frame";
            if (geometry)
                Object.assign(out, { x: round(geometry.x), y: round(geometry.y), width: geometry.width, height: geometry.height });
            if (ux.gridStyle)
                out.layoutGrid = convertColors(ux.gridStyle);
            if (ux.guidesModel)
                out.guides = ux.guidesModel;
            if (geometry?.viewportHeight)
                out.viewportHeight = geometry.viewportHeight;
            break;
        }
        case "shape": {
            let s = n.shape ?? {};
            if (s.type === "polygon" && Array.isArray(s.points) && s.points.length >= 3 && s.points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) {
                s = { ...s, type: "path", path: s.points.map((p, i) => `${i ? "L" : "M"} ${p.x} ${p.y}`).join(" ") + " Z" };
            }
            const box = localBox(s);
            const kind = s.type;
            out.type = kind === "rect" ? "rectangle" : kind === "circle" || kind === "ellipse" ? "ellipse" : kind === "compound" ? "boolean" : kind === "line" ? "line" : kind === "path" ? "path" : (kind ?? "shape");
            if (box) {
                const tl = apply(m, box.x, box.y);
                out.x = round(tl.x);
                out.y = round(tl.y);
                out.width = round(box.width);
                out.height = round(box.height);
                out.localBox = { x: round(box.x, 1000), y: round(box.y, 1000), width: round(box.width, 1000), height: round(box.height, 1000) };
                if (box.approx)
                    out.boundsApprox = true;
            }
            if (kind === "rect" && s.r != null)
                out.cornerRadius = s.r;
            if (kind === "line")
                out.points = [{ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 }];
            if (typeof s.path === "string" && box) {
                // path data translated so its bounding box starts at (0,0); localBox.x/y is where it sits in node space
                out.svgPathLocal = translatePath(s.path, -box.x, -box.y);
            }
            if (kind === "compound") {
                out.operation = s.operation; // add | subtract | intersect | exclude
                out.children = arr(s.children).map((c) => convert({ ...c }, ctx, depth + 1));
            }
            if (s.fillRule)
                out.fillRule = s.fillRule;
            break;
        }
        case "text": {
            out.type = "text";
            const { text, box } = normalizeText(n, m, ctx);
            out.text = text;
            out.x = box.x;
            out.y = box.y;
            out.width = box.width;
            out.height = box.height;
            out.box = box;
            break;
        }
        default: {
            // group (includes components, repeat grids, masks)
            out.x = round(m.tx);
            out.y = round(m.ty);
            if (ux.width != null)
                out.width = ux.width;
            if (ux.height != null)
                out.height = ux.height;
        }
    }
    if (offset && n.type !== "artboard" && typeof out.x === "number" && typeof out.y === "number") {
        out.x = round(out.x - offset.x);
        out.y = round(out.y - offset.y);
        if (out.box)
            out.box = { ...out.box, x: round(out.box.x - offset.x), y: round(out.box.y - offset.y) };
        if (out.text?.baselineY !== undefined)
            out.text.baselineY = round(out.text.baselineY - offset.y);
        if (out.text?.layoutLines)
            out.text.layoutLines = out.text.layoutLines.map((line) => ({ ...line, x: round(line.x - offset.x), y: round(line.y - offset.y) }));
    }
    // XD component states (hover, pressed, ...) become variants
    const states = [...arr(ux.states)];
    for (const wire of out.interactions ?? []) {
        if (wire.action !== "state-transition" || states.some(s => (s.meta?.ux?.stateId ?? s.id) === wire.destinationId) || wire.destinationId === ux.stateId || ctx.chain.has(wire.destinationId))
            continue;
        const shared = ctx.sources.get(wire.destinationId);
        if (shared?.meta?.ux?.symbolId === ux.symbolId)
            states.push({ ...shared, transform: n.transform });
    }
    if (states.length && depth < ctx.maxDepth) {
        out.variants = states.filter(s => !ctx.chain.has(s.meta?.ux?.stateId ?? s.id)).map((s) => {
            const stateId = s.meta?.ux?.stateId ?? s.id;
            ctx.chain.add(stateId);
            try {
                return { name: s.name, stateId, node: convert(s, ctx, depth + 1, undefined, offset) };
            }
            finally {
                ctx.chain.delete(stateId);
            }
        });
    }
    if (n.type !== "shape" || n.shape?.type !== "compound") {
        if (kids.length) {
            if (depth >= ctx.maxDepth) {
                out.childCount = kids.length;
                out.truncated = true;
            }
            else {
                const childOffset = n.type === "artboard" && geometry ? { x: geometry.x ?? 0, y: geometry.y ?? 0 } : undefined;
                out.children = kids.map((k) => convert(k, ctx, depth + 1, undefined, childOffset));
            }
        }
    }
    return clean(out);
}
function findById(n, id) {
    if (n.id === id)
        return n;
    for (const c of childrenOf(n)) {
        const r = findById(c, id);
        if (r)
            return r;
    }
    return undefined;
}
/** Prototype wiring (interactions.json), keyed by source layer id, plus artboard names for destinations. */
export async function protoCtx(doc) {
    const entry = doc.entries.find((e) => e === "interactions/interactions.json");
    const interactions = entry ? (await readJson(doc, entry))?.interactions : undefined;
    const artboardNames = new Map(doc.artboards.map((a) => [a.id.replace(/^artboard-/, ""), a.name]));
    return { interactions, artboardNames };
}
export async function artboardGeometry(doc) {
    return doc.entries.includes(RES_PATH) ? (await readJson(doc, RES_PATH))?.artboards ?? {} : {};
}
function countRefs(n, acc = { resolved: 0, unresolved: 0 }) {
    if (n.linkedFrom)
        acc.resolved++;
    if (n.type === "unresolvedRef")
        acc.unresolved++;
    for (const c of n.children ?? [])
        countRefs(c, acc);
    for (const v of n.variants ?? [])
        countRefs(v.node, acc);
    return acc;
}
export function collectImageRefs(n, acc = new Set()) {
    for (const f of [...(n.fills ?? []), ...(n.strokes ?? [])])
        if (f.imageRef)
            acc.add(f.imageRef);
    for (const c of n.children ?? [])
        collectImageRefs(c, acc);
    for (const v of n.variants ?? [])
        collectImageRefs(v.node, acc);
    return acc;
}
const buildCache = new WeakMap();
async function build(doc, key, make) {
    let perDoc = buildCache.get(doc);
    if (!perDoc)
        buildCache.set(doc, (perDoc = new Map()));
    const hit = perDoc.get(key);
    if (hit)
        return hit;
    const built = await make();
    perDoc.set(key, built);
    while (perDoc.size > 3)
        perDoc.delete(perDoc.keys().next().value); // keep a few big exports for paging
    return built;
}
const fontList = (fonts) => [...fonts.values()].map((f) => ({ family: f.family, postscriptName: f.postscriptName, style: f.style, sizes: [...f.sizes].sort((a, b) => a - b), uses: f.uses }));
/** Convert a whole artboard (or one layer of it) with every linked component resolved. Never paginated. */
export async function exportWhole(doc, ab, opts = {}) {
    const depth = Math.min(opts.depth ?? MAX_DEPTH_CAP, MAX_DEPTH_CAP);
    return build(doc, `${ab.id}|${opts.nodeId ?? ""}|${depth}`, async () => {
        const agc = await readJson(doc, ab.path);
        const geometry = await artboardGeometry(doc);
        const root = rootNodes(agc)[0];
        if (!root)
            throw new Error("Artboard has no content.");
        const target = opts.nodeId ? findById(root, opts.nodeId) : root;
        if (!target)
            throw new Error(`No layer with id "${opts.nodeId}" in artboard "${ab.name}".`);
        const rootGeo = own(geometry, root.artboard?.ref);
        const topLevel = target !== root && childrenOf(root).includes(target);
        const offset = topLevel && rootGeo ? { x: rootGeo.x ?? 0, y: rootGeo.y ?? 0 } : undefined;
        const ctx = {
            images: new Set(),
            maxDepth: depth,
            fonts: new Map(),
            sources: await prefetchSources(doc, target),
            syncDepth: 0,
            nodes: 0,
            chain: new Set(),
            ...(await protoCtx(doc)),
        };
        const node = convert(target, ctx, 0, target === root ? rootGeo : undefined, offset);
        return { node, images: ctx.images, fonts: fontList(ctx.fonts) };
    });
}
const PAGE_CHARS = 300_000;
/**
 * Export one artboard or layer. If the JSON is bigger than `maxChars` it is split into pages by top-level
 * child (never by cutting depth); every page repeats the parent shell and says whether more pages follow.
 */
export async function exportArtboard(doc, ab, opts) {
    const whole = await exportWhole(doc, ab, opts);
    const limit = opts.maxChars ?? PAGE_CHARS;
    const node = whole.node;
    const kids = node.children ?? [];
    const wholeSize = JSON.stringify(node).length;
    const syncRefs = countRefs(node);
    const asked = opts.depth !== undefined && opts.depth < MAX_DEPTH_CAP;
    const truncated = asked && JSON.stringify(node).includes('"truncated":true');
    if (wholeSize <= limit || kids.length <= 1) {
        return { node, images: [...whole.images], fonts: whole.fonts, page: 0, pageCount: 1, hasMore: false, truncated, oversized: wholeSize > limit || undefined, syncRefs };
    }
    // greedy packing of top-level children into pages
    const pages = [];
    let cur = [];
    let size = 0;
    for (const k of kids) {
        const s = JSON.stringify(k).length;
        if (cur.length && size + s > limit) {
            pages.push(cur);
            cur = [];
            size = 0;
        }
        cur.push(k);
        size += s;
    }
    if (cur.length)
        pages.push(cur);
    const page = Math.min(Math.max(opts.page ?? 0, 0), pages.length - 1);
    const shell = { ...node, children: pages[page] };
    const images = new Set();
    for (const k of pages[page])
        collectImageRefs(k, images);
    return {
        node: shell,
        images: [...images],
        fonts: whole.fonts,
        page,
        pageCount: pages.length,
        hasMore: page < pages.length - 1,
        truncated,
        oversized: pages[page].length === 1 && JSON.stringify(pages[page][0]).length > limit ? true : undefined,
        syncRefs,
    };
}
/** Component masters (symbols) defined in the document, with how often they are used. */
export async function listComponents(doc) {
    if (!doc.entries.includes(RES_PATH))
        return [];
    const res = await readJson(doc, RES_PATH);
    const symbols = arr(res?.resources?.meta?.ux?.symbols);
    const usage = await componentUsage(doc);
    return symbols.map((s) => {
        const id = s.meta?.ux?.symbolId;
        const u = usage.get(id);
        return {
            symbolId: id,
            name: s.name,
            width: s.meta?.ux?.width,
            height: s.meta?.ux?.height,
            nodeId: s.id,
            usageCount: u?.count ?? 0,
            artboards: u ? [...u.artboards].slice(0, 25) : [],
            artboardCount: u?.artboards.size ?? 0,
            variantCount: arr(s.meta?.ux?.states).length || undefined,
            description: describeComponent(s, u?.count ?? 0),
        };
    });
}
function describeComponent(s, uses) {
    const ux = s.meta?.ux ?? {};
    const texts = [];
    const walk = (n, d) => {
        if (n?.text?.rawText && texts.length < 2)
            texts.push(String(n.text.rawText).replace(/\s+/g, " ").slice(0, 24));
        if (d < 6)
            for (const c of childrenOf(n))
                walk(c, d + 1);
    };
    walk(s, 0);
    const size = ux.width && ux.height ? `${Math.round(ux.width)}x${Math.round(ux.height)}` : "";
    const label = texts.length ? ` with text "${texts.join('", "')}"` : "";
    return `Reusable component${size ? " " + size : ""}${label}; used ${uses} time${uses === 1 ? "" : "s"}.`.replace(/\s+/g, " ");
}
const usageCache = new WeakMap();
function componentUsage(doc) {
    let p = usageCache.get(doc);
    if (!p) {
        p = (async () => {
            const out = new Map();
            for (const ab of doc.artboards) {
                const agc = await readJson(doc, ab.path);
                const walk = (n) => {
                    const id = n?.meta?.ux?.symbolId;
                    if (id) {
                        const e = out.get(id) ?? { count: 0, artboards: new Set() };
                        e.count++;
                        e.artboards.add(ab.name);
                        out.set(id, e);
                    }
                    for (const c of childrenOf(n))
                        walk(c);
                };
                rootNodes(agc).forEach(walk);
            }
            return out;
        })();
        usageCache.set(doc, p);
    }
    return p;
}
export async function exportComponent(doc, symbolId, opts) {
    const res = await readJson(doc, RES_PATH);
    const symbols = arr(res?.resources?.meta?.ux?.symbols);
    const s = symbols.find((x) => x.meta?.ux?.symbolId === symbolId || x.id === symbolId || x.name === symbolId);
    if (!s)
        throw new Error(`Component "${symbolId}" not found. Use xd_list_components.`);
    const depth = Math.min(opts.depth ?? MAX_DEPTH_CAP, MAX_DEPTH_CAP);
    const ctx = {
        images: new Set(),
        maxDepth: depth,
        fonts: new Map(),
        sources: await prefetchSources(doc, s),
        syncDepth: 0,
        nodes: 0,
        chain: new Set(),
    };
    const node = convert({ ...s, meta: { ux: { ...s.meta?.ux, isMaster: true } } }, ctx, 0);
    delete node.x; // a master has no meaningful canvas position
    delete node.y;
    const images = [...collectImageRefs(node, new Set(ctx.images))];
    return { node, images, fonts: fontList(ctx.fonts), page: 0, pageCount: 1, hasMore: false, truncated: false, syncRefs: countRefs(node) };
}
/** Document-wide design tokens from XD's own libraries (color swatches, etc.). */
export async function sharedAssets(doc) {
    if (!doc.entries.includes(RES_PATH))
        return {};
    const ux = (await readJson(doc, RES_PATH))?.resources?.meta?.ux ?? {};
    const swatches = arr(ux.colorSwatches).map((c) => colorOf(c)?.color).filter(Boolean);
    const lib = arr(ux.documentLibrary?.elements);
    const colors = lib
        .filter((e) => e.type?.includes("element.color"))
        .map((e) => ({ name: e.name || undefined, ...colorOf(e.representations?.[0]?.content) }));
    const characterStyles = lib
        .filter((e) => e.type?.includes("characterstyle"))
        .map((e) => ({ name: e.name || undefined, content: convertColors(e.representations?.[0]?.content) }));
    return { colorSwatches: swatches, libraryColors: colors, characterStyles };
}
