import { arr, childrenOf, readJson } from "./xd.js";
const indexes = new WeakMap();
/** Children plus XD component states (hover etc.): source layers can live inside either. */
const subNodes = (n) => [...childrenOf(n), ...arr(n?.meta?.ux?.states)];
const rootsOf = (agc) => [...arr(agc?.children), ...arr(agc?.resources?.meta?.ux?.symbols)];
async function build(doc) {
    const idx = new Map();
    const states = new Map();
    const MAX_INDEXED = 2_000_000;
    const entries = doc.entries.filter((e) => e.endsWith(".agc"));
    for (const entry of entries) {
        const agc = await readJson(doc, entry);
        const roots = rootsOf(agc);
        const walk = (n, root, path) => {
            if (n?.id && !idx.has(n.id)) {
                if (idx.size >= MAX_INDEXED)
                    throw new Error("Too many layers to index linked components.");
                idx.set(n.id, { entry, root, path });
            }
            const stateId = n?.meta?.ux?.stateId;
            if (typeof stateId === "string" && (!states.has(stateId) || entry.startsWith("resources/"))) {
                if (states.size >= MAX_INDEXED)
                    throw new Error("Too many component states to index.");
                states.set(stateId, { entry, root, path });
            }
            const kids = subNodes(n);
            for (let i = 0; i < kids.length; i++)
                walk(kids[i], root, [...path, i]);
        };
        roots.forEach((r, i) => walk(r, i, []));
    }
    for (const [id, loc] of states)
        if (!idx.has(id))
            idx.set(id, loc);
    return idx;
}
export function idIndex(doc) {
    let p = indexes.get(doc);
    if (!p)
        indexes.set(doc, (p = build(doc)));
    return p;
}
export async function fetchLayer(doc, id) {
    const loc = (await idIndex(doc)).get(id);
    if (!loc)
        return undefined;
    const agc = await readJson(doc, loc.entry);
    let n = rootsOf(agc)[loc.root];
    for (const i of loc.path)
        n = subNodes(n)[i];
    return n;
}
const MAX_SYNC_DEPTH = 8;
/** Collect every referenced source layer (recursively) for the subtree `root`. */
export async function prefetchSources(doc, root) {
    const found = new Map();
    const prototype = doc.entries.includes("interactions/interactions.json") ? (await readJson(doc, "interactions/interactions.json"))?.interactions ?? {} : {};
    const wires = Object.values(prototype).flat();
    let frontier = [root];
    for (let level = 0; level <= MAX_SYNC_DEPTH && frontier.length; level++) {
        const wanted = new Set();
        const walk = (n) => {
            if (n?.type === "syncRef" && typeof n.syncSourceGuid === "string" && !found.has(n.syncSourceGuid))
                wanted.add(n.syncSourceGuid);
            if (n?.meta?.ux?.symbolId) {
                const guids = new Set(arr(n.meta.ux.interactions).filter((w) => w.enabled !== false && w.valid !== false).map((w) => w.guid));
                for (const w of [...arr(prototype[n.id]), ...wires.filter(w => guids.has(w.id))]) {
                    const dest = w.properties?.destination;
                    if (w.action === "state-transition" && typeof dest === "string" && !found.has(dest))
                        wanted.add(dest);
                }
            }
            for (const k of childrenOf(n))
                walk(k);
            for (const s of arr(n?.meta?.ux?.states))
                walk(s);
            for (const m of arr(n?.meta?.ux?.clipPathResources?.children))
                walk(m);
        };
        frontier.forEach(walk);
        frontier = [];
        for (const id of wanted) {
            const src = await fetchLayer(doc, id);
            if (src) {
                found.set(id, src);
                frontier.push(src);
            }
        }
    }
    return found;
}
export const MAX_SYNC = MAX_SYNC_DEPTH;
