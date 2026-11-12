import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { assertInsideRoots } from "./xd.js";
import { exportWhole, collectImageRefs } from "./export.js";
import { buildSvg, visualBounds, weightOf } from "./render.js";
import { rasterize } from "./raster.js";
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const num = (v) => Number.isFinite(Number(v)) ? Math.round(Number(v) * 1000) / 1000 : 0;
const color = (v) => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v : "#000000";
const js = (v) => JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
const basename = (id) => "artboard-" + id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
const hasDom = (n) => n.type === "text" || !!n.interactions?.length || !!n.variants?.length || (n.children ?? []).some(hasDom);
const cssFamily = (v) => `'${String(v ?? "sans-serif").replace(/[\\'\r\n<>]/g, "")}', 'Segoe UI', Arial, sans-serif`;
/** HTML uses ordinary text/state elements plus independent transparent PNG graphic slices. */
export async function exportHtml(doc, ab, saveTo) {
    const dir = await assertInsideRoots(saveTo);
    const tree = await exportWhole(doc, ab);
    const width = tree.node.width ?? 1, height = tree.node.height ?? 1;
    const assets = [], hashes = new Map(), missing = new Set(), warnings = new Set();
    const components = [];
    let textCount = 0, graphics = 0, seq = 0;
    async function graphic(node) {
        const box = visualBounds(node);
        if (!box || box.width <= 0 || box.height <= 0)
            return "";
        const vp = { x: Math.floor(box.x - 1), y: Math.floor(box.y - 1), width: Math.ceil(box.x + box.width + 1) - Math.floor(box.x - 1), height: Math.ceil(box.y + box.height + 1) - Math.floor(box.y - 1) };
        const result = await buildSvg(doc, node, [...collectImageRefs(node)], vp);
        result.missingImages.forEach(x => missing.add(x));
        const hash = createHash("sha256").update(result.svg).digest("hex").slice(0, 24);
        let name = hashes.get(hash);
        if (!name) {
            name = `slice-${hash}.png`;
            hashes.set(hash, name);
            assets.push({ svg: result.svg, name });
        }
        graphics++;
        return `<img class="xd-graphic" data-layer="${esc(node.id)}" alt="" draggable="false" src="assets/${name}" style="left:${vp.x}px;top:${vp.y}px;width:${result.width}px;height:${result.height}px">`;
    }
    function text(node) {
        textCount++;
        const t = node.text ?? {}, font = t.font ?? {}, size = font.size ?? 14;
        const chars = String(t.characters ?? "");
        const box = node.box ?? { x: node.x ?? 0, y: node.y ?? 0, width: node.width ?? 0, height: node.height ?? size };
        let offset = 0;
        const saved = t.layoutLines?.length;
        const lines = saved ? t.layoutLines : chars.split("\n").map((value, i) => {
            const line = { from: offset, to: offset + value.length, x: box.x, y: (t.baselineY ?? box.y + size) + i * (t.lineHeight ?? size * 1.17) };
            offset += value.length + 1;
            return line;
        });
        const spans = lines.map((line) => {
            const value = chars.slice(line.from, line.to).replace(/[\r\n]+$/, "");
            const end = line.from + value.length;
            const cuts = [...new Set([line.from, end, ...(t.styledRuns ?? []).flatMap((r) => [r.from, r.to]).filter((p) => p > line.from && p < end)])].sort((a, b) => a - b);
            const content = [];
            for (let i = 0; i + 1 < cuts.length; i++) {
                const a = cuts[i], b = cuts[i + 1];
                const r = (t.styledRuns ?? []).filter((r) => r.from <= a && r.to >= b).reduce((acc, r) => ({ ...acc, ...r }), {});
                const style = `${r.color ? `color:${color(r.color)};` : ""}${r.size ? `font-size:${num(r.size)}px;` : ""}${r.weight ? `font-weight:${weightOf(r.weight)};` : ""}${r.family ? `font-family:${cssFamily(r.family)};` : ""}${r.underline ? "text-decoration:underline;" : r.strikethrough ? "text-decoration:line-through;" : ""}`;
                content.push(`<span${style ? ` style="${esc(style)}"` : ""}>${esc(chars.slice(a, b))}</span>`);
            }
            const anchor = !saved && t.alignment === "center" ? "translateX(-50%)" : !saved && t.alignment === "right" ? "translateX(-100%)" : "none";
            const x = !saved && t.alignment === "center" ? line.x + box.width / 2 : !saved && t.alignment === "right" ? line.x + box.width : line.x;
            return `<span class="xd-line" data-baseline="${num(line.y)}" style="left:${num(x)}px;top:${num(line.y - size)}px;transform:${anchor}">${content.join("") || "&#8203;"}</span>`;
        }).join("");
        const fill = node.fills?.[0];
        const gradient = fill?.type === "gradient" && fill.stops?.length ? `background-image:linear-gradient(90deg,${fill.stops.map((s) => `${color(s.color)} ${num(s.offset * 100)}%`).join(",")});background-clip:text;-webkit-background-clip:text;color:transparent;` : "";
        if (gradient)
            warnings.add("Gradient text uses a CSS gradient; gradient geometry may differ for transformed text.");
        const style = `font-family:${cssFamily(font.family)};font-size:${num(size)}px;font-weight:${weightOf(font.style)};font-style:${/italic|oblique/i.test(font.style ?? "") ? "italic" : "normal"};color:${color(fill?.color)};opacity:${num((node.opacity ?? 1) * (fill?.opacity ?? 1))};letter-spacing:${num(t.letterSpacing?.px ?? 0)}px;${t.underline ? "text-decoration:underline;" : ""}${gradient}`;
        return `<div class="xd-text" data-layer="${esc(node.id)}" style="${esc(style)}">${spans}</div>`;
    }
    function groupStyle(node) {
        const m = node.transform;
        const matrix = m ? ` matrix(${[m.a, m.b, m.c, m.d, 0, 0].map(num).join(",")})` : "";
        const b = visualBounds({ ...node, x: 0, y: 0, transform: undefined });
        const w = node.width ?? (b ? b.x + b.width : 0), h = node.height ?? (b ? b.y + b.height : 0);
        let style = `width:${num(w)}px;height:${num(h)}px;transform:translate(${num(node.x ?? 0)}px,${num(node.y ?? 0)}px)${matrix};opacity:${num(node.opacity ?? 1)};`;
        if (node.blendMode && /^[a-z-]+$/.test(node.blendMode))
            style += `mix-blend-mode:${node.blendMode};`;
        if (node.mask) {
            const mask = node.mask;
            if (mask.shape === "rectangle" && !mask.transform)
                style += `clip-path:inset(${num(mask.y)}px ${num(w - mask.x - mask.width)}px ${num(h - mask.y - mask.height)}px ${num(mask.x)}px round ${num(Array.isArray(mask.radius) ? mask.radius[0] : mask.radius)}px);`;
            else
                warnings.add(`DOM group ${node.id ?? node.name} has a non-rectangular text mask requiring visual review.`);
        }
        return style;
    }
    async function children(node) {
        const out = [];
        if (node.fills?.length && node.width && node.height) {
            out.push(await graphic({ ...node, id: `${node.id}-background`, type: "frame", x: 0, y: 0, transform: undefined, opacity: 1, mask: undefined, children: [], variants: undefined, interactions: undefined }));
        }
        let batch = [];
        const flush = async () => { if (batch.length) {
            out.push(await graphic({ type: "group", children: batch }));
            batch = [];
        } };
        for (const child of node.children ?? []) {
            if (child.visible === false || child.type === "unresolvedRef")
                continue;
            if (!hasDom(child))
                batch.push(child);
            else {
                await flush();
                out.push(await render(child));
            }
        }
        await flush();
        return out.join("");
    }
    async function render(node, stateContent = false) {
        if (node.visible === false || node.type === "unresolvedRef")
            return "";
        if (node.type === "text")
            return text(node);
        if (!hasDom(node))
            return graphic(node);
        if (!stateContent && (node.variants?.length || node.interactions?.some((i) => i.action === "state-transition"))) {
            const key = `c${seq++}`, base = node.component?.stateId ?? node.id ?? "default";
            const variants = [{ id: base, node }];
            for (let i = 0; i < variants.length; i++) {
                for (const v of variants[i].node.variants ?? []) {
                    const id = v.stateId ?? v.node.component?.stateId ?? v.node.id;
                    if (!variants.some(s => s.id === id))
                        variants.push({ id, node: v.node });
                }
            }
            const ids = new Set(variants.map(v => v.id));
            const states = [];
            const wires = [];
            for (const variant of variants) {
                const local = { ...variant.node, x: 0, y: 0, transform: undefined, opacity: 1, variants: undefined, interactions: undefined };
                states.push(`<div class="xd-state" data-state="${esc(variant.id)}" aria-hidden="${variant.id !== base}" style="opacity:${variant.id === base ? 1 : 0}">${await children(local)}</div>`);
                for (const wire of variant.node.interactions ?? []) {
                    if (wire.action === "state-transition" && ids.has(wire.destinationId) && ["tap", "hover"].includes(wire.trigger))
                        wires.push({ ...wire, from: variant.id });
                    else if (wire.action === "state-transition")
                        warnings.add(`Unresolved state destination ${wire.destinationId} on ${node.id}.`);
                }
            }
            components.push({ key, base, wires });
            const label = (node.children ?? []).find((n) => n.type === "text")?.text?.characters ?? node.name ?? "XD component";
            return `<div class="xd-group xd-component" data-layer="${esc(node.id)}" data-component="${key}" data-wires="${esc(JSON.stringify(wires))}" data-current="${esc(base)}" role="button" tabindex="0" aria-label="${esc(label)}" style="${esc(groupStyle(node))}">${states.join("")}</div>`;
        }
        return `<div class="xd-group" data-layer="${esc(node.id)}" style="${esc(groupStyle(node))}">${await children(node)}</div>`;
    }
    const body = await children(tree.node);
    const links = Object.fromEntries(doc.artboards.flatMap(a => [[a.id.replace(/^artboard-/, ""), `xd-page-${basename(a.id)}.html`], [a.id, `xd-page-${basename(a.id)}.html`]]));
    const pageWires = (tree.node.interactions ?? []).filter((i) => i.trigger === "tap" && i.action === "artboard-transition" && Object.hasOwn(links, i.destinationId));
    const runtime = `(()=>{const config=${js(components)},links=${js(links)},pageWires=${js(pageWires)};const root=document.querySelector('.xd-canvas'),frame=document.querySelector('main');function fit(){const scale=Math.min(1,frame.clientWidth/${num(width)});root.style.transform='scale('+scale+')';frame.style.height=(${num(height)}*scale)+'px'}new ResizeObserver(fit).observe(frame);fit();const nodes=new Map();for(const c of config){const el=root.querySelector('[data-component="'+c.key+'"]');if(!el)continue;const item={el,resting:c.base,wires:c.wires,set(id,w){const duration=matchMedia('(prefers-reduced-motion:reduce)').matches?0:Math.max(0,Math.min(10,Number(w?.duration)||0));const easing=['ease','ease-in','ease-out','ease-in-out','linear'].includes(w?.easing)?w.easing:'ease-out';for(const state of el.querySelectorAll(':scope > .xd-state')){const active=state.dataset.state===id;state.style.transition='opacity '+duration+'s '+easing;state.style.opacity=active?'1':'0';state.setAttribute('aria-hidden',String(!active));state.inert=!active}el.dataset.current=id},wire(trigger){return this.wires.find(w=>w.from===el.dataset.current&&w.trigger===trigger)||this.wires.find(w=>w.from===this.resting&&w.trigger===trigger)}};nodes.set(c.key,item);el.addEventListener('click',e=>{if(e.target.closest('[data-component]')!==el)return;const w=item.wire('tap');if(w){item.resting=w.destinationId;item.set(item.resting,w);e.stopPropagation()}});el.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();el.click()}})}function enter(item){const w=item.wire('hover');if(w)item.set(w.destinationId,w)}function leave(item){const w=item.wires.find(x=>x.from===item.resting&&x.trigger==='hover');if(w)item.set(item.resting,w)}let hovered=null;root.addEventListener('pointerover',e=>{const owner=e.target&&e.target.closest?e.target.closest('[data-component]'):null;const item=owner?nodes.get(owner.dataset.component):null;if(item===hovered)return;if(hovered)leave(hovered);hovered=item;if(item)enter(item)});root.addEventListener('pointerleave',()=>{if(hovered)leave(hovered);hovered=null});root.addEventListener('click',e=>{const w=pageWires[0];if(w)location.href=links[w.destinationId]});for(const line of root.querySelectorAll('.xd-line')){const font=getComputedStyle(line);const canvas=document.createElement('canvas');const ctx=canvas.getContext('2d');ctx.font=font.font;const size=parseFloat(font.fontSize)||14;const m=ctx.measureText('Hg');const ascent=m.fontBoundingBoxAscent??size*.92,descent=m.fontBoundingBoxDescent??size*.25;const baseline=(size-ascent-descent)/2+ascent;line.style.marginTop=(size-baseline)+'px'}document.documentElement.dataset.xdReady='true'})();`;
    const title = esc(ab.name || ab.id);
    const html = `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><link rel="icon" href="data:,"><style>html,body{margin:0;padding:0;background:#fff}main{position:relative;width:100%;max-width:${num(width)}px;height:${num(height)}px;margin-inline:auto;overflow:hidden}.xd-canvas{position:relative;width:${num(width)}px;height:${num(height)}px;transform-origin:0 0;overflow:hidden}.xd-group,.xd-state{position:absolute;left:0;top:0;transform-origin:0 0}.xd-group{pointer-events:none}.xd-component{pointer-events:auto}.xd-state{width:100%;height:100%;pointer-events:auto}.xd-state[aria-hidden="true"],.xd-state[aria-hidden="true"] *{pointer-events:none}.xd-graphic{position:absolute;pointer-events:none;user-select:none}.xd-text{position:absolute;left:0;top:0;pointer-events:none}.xd-line{position:absolute;display:block;white-space:pre;line-height:1}.xd-component{cursor:pointer}.xd-component:focus-visible{outline:2px solid #0471ff;outline-offset:3px}@media(prefers-reduced-motion:reduce){.xd-state{transition:none!important}}</style></head><body><main aria-label="${title}"><div class="xd-canvas" data-artboard="${esc(ab.id)}">${body}</div></main><script>${runtime}</script></body></html>\n`;
    await mkdir(dir, { recursive: true });
    const assetDir = await assertInsideRoots(path.join(dir, "assets"));
    await mkdir(assetDir, { recursive: true });
    const pngs = await rasterize(assets.map(a => a.svg));
    for (let i = 0; i < assets.length; i++) {
        const dest = await assertInsideRoots(path.join(assetDir, assets[i].name));
        try {
            await writeFile(dest, pngs[i], { flag: "wx" });
        }
        catch (e) {
            if (e?.code !== "EEXIST")
                throw e;
            if (!(await readFile(dest)).equals(pngs[i]))
                throw new Error("Existing image asset does not match the exported content.");
        }
    }
    for (let n = 0; n < 100; n++) {
        const dest = path.join(dir, `${basename(ab.id)}${n ? "-" + n : ""}.html`);
        try {
            await writeFile(dest, html, { encoding: "utf8", flag: "wx" });
            const navigationPath = await assertInsideRoots(path.join(dir, `xd-page-${basename(ab.id)}.html`));
            const marker = `<!-- adobe-xd-mcp navigation ${basename(ab.id)} -->`;
            const navigation = `${marker}<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${esc(path.basename(dest))}"><a href="${esc(path.basename(dest))}">Open ${title}</a>`;
            try {
                await writeFile(navigationPath, navigation, { flag: "wx" });
            }
            catch (error) {
                if (error?.code !== "EEXIST")
                    throw error;
                const { lstat } = await import("node:fs/promises");
                if ((await lstat(navigationPath)).isSymbolicLink() || !(await readFile(navigationPath, "utf8")).startsWith(marker))
                    throw new Error("Refusing to replace an unrelated HTML navigation file.");
                await writeFile(navigationPath, navigation, { flag: "w" });
            }
            return { artboard: ab.name, id: ab.id, savedTo: dest, navigationPath, width, height, bytes: Buffer.byteLength(html), missingImages: [...missing], fonts: tree.fonts, format: "html-dom-png", assets: assets.map(a => path.join(assetDir, a.name)), graphics, textNodes: textCount, components: components.length, interactions: components.reduce((n, c) => n + c.wires.length, pageWires.length), warnings: [...warnings], note: "DOM text and PNG graphic slices. XD component states animate with their saved duration/easing using an opacity transition; path morphing is not reproduced. Export destination artboards into the same folder for prototype page links. Fonts use installed families and system fallbacks." };
        }
        catch (e) {
            if (e?.code !== "EEXIST")
                throw e;
        }
    }
    throw new Error("Too many HTML exports with this name already exist in that folder.");
}
