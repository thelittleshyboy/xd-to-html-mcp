/**
 * SVG path helpers for XD vector data (absolute M/L/H/V/C/S/Q/T/A/Z commands, as written by XD).
 */
const NUM = /-?\d*\.?\d+(?:e[-+]?\d+)?/gi;
const SEG = /([MLHVCSQTAZmlhvcsqtaz])([^MLHVCSQTAZmlhvcsqtaz]*)/g;
function parse(d) {
    const out = [];
    for (const m of d.matchAll(SEG))
        out.push({ cmd: m[1], nums: (m[2].match(NUM) ?? []).map(Number) });
    return out;
}
const fmt = (n) => String(Math.round(n * 1000) / 1000);
/** Real extrema of a cubic Bezier along one axis (t values in (0,1)). */
function cubicExtrema(p0, p1, p2, p3) {
    const a = -p0 + 3 * p1 - 3 * p2 + p3;
    const b = 2 * (p0 - 2 * p1 + p2);
    const c = p1 - p0;
    const ts = [];
    if (Math.abs(a) < 1e-12) {
        if (Math.abs(b) > 1e-12)
            ts.push(-c / b);
    }
    else {
        const disc = b * b - 4 * a * c;
        if (disc >= 0) {
            const s = Math.sqrt(disc);
            ts.push((-b + s) / (2 * a), (-b - s) / (2 * a));
        }
    }
    return ts.filter((t) => t > 0 && t < 1);
}
const cubicAt = (p0, p1, p2, p3, t) => {
    const u = 1 - t;
    return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
};
const quadExtrema = (p0, p1, p2) => {
    const d = p0 - 2 * p1 + p2;
    if (Math.abs(d) < 1e-12)
        return [];
    const t = (p0 - p1) / d;
    return t > 0 && t < 1 ? [t] : [];
};
const quadAt = (p0, p1, p2, t) => (1 - t) * (1 - t) * p0 + 2 * (1 - t) * t * p1 + t * t * p2;
/**
 * Exact bounding box of a path. `approx` is true only when the path uses commands whose extent was
 * estimated from control points (relative commands, arcs, smooth curves).
 */
export function pathBox(d) {
    const segs = parse(d);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    let cx = 0, cy = 0, sx = 0, sy = 0;
    let approx = false;
    const add = (x, y) => {
        if (!Number.isFinite(x) || !Number.isFinite(y))
            return;
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
    };
    for (const { cmd, nums } of segs) {
        const rel = cmd === cmd.toLowerCase() && cmd.toLowerCase() !== "z";
        const c = cmd.toUpperCase();
        if (rel)
            approx = true; // relative data: bounds still computed below, but flagged
        const ox = rel ? cx : 0, oy = rel ? cy : 0;
        switch (c) {
            case "M":
            case "L":
            case "T":
                if (c === "T")
                    approx = true;
                for (let i = 0; i + 1 < nums.length; i += 2) {
                    cx = ox + nums[i];
                    cy = oy + nums[i + 1];
                    if (c === "M" && i === 0) {
                        sx = cx;
                        sy = cy;
                    }
                    add(cx, cy);
                }
                break;
            case "H":
                for (const n of nums) {
                    cx = ox + n;
                    add(cx, cy);
                }
                break;
            case "V":
                for (const n of nums) {
                    cy = oy + n;
                    add(cx, cy);
                }
                break;
            case "C":
                for (let i = 0; i + 5 < nums.length; i += 6) {
                    const [a1, b1, a2, b2, ex, ey] = [ox + nums[i], oy + nums[i + 1], ox + nums[i + 2], oy + nums[i + 3], ox + nums[i + 4], oy + nums[i + 5]];
                    add(cx, cy);
                    add(ex, ey);
                    for (const t of cubicExtrema(cx, a1, a2, ex))
                        add(cubicAt(cx, a1, a2, ex, t), cubicAt(cy, b1, b2, ey, t));
                    for (const t of cubicExtrema(cy, b1, b2, ey))
                        add(cubicAt(cx, a1, a2, ex, t), cubicAt(cy, b1, b2, ey, t));
                    cx = ex;
                    cy = ey;
                }
                break;
            case "S":
                approx = true;
                for (let i = 0; i + 3 < nums.length; i += 4) {
                    add(ox + nums[i], oy + nums[i + 1]);
                    cx = ox + nums[i + 2];
                    cy = oy + nums[i + 3];
                    add(cx, cy);
                }
                break;
            case "Q":
                for (let i = 0; i + 3 < nums.length; i += 4) {
                    const [a1, b1, ex, ey] = [ox + nums[i], oy + nums[i + 1], ox + nums[i + 2], oy + nums[i + 3]];
                    add(cx, cy);
                    add(ex, ey);
                    for (const t of quadExtrema(cx, a1, ex))
                        add(quadAt(cx, a1, ex, t), quadAt(cy, b1, ey, t));
                    for (const t of quadExtrema(cy, b1, ey))
                        add(quadAt(cx, a1, ex, t), quadAt(cy, b1, ey, t));
                    cx = ex;
                    cy = ey;
                }
                break;
            case "A":
                approx = true;
                for (let i = 0; i + 6 < nums.length; i += 7) {
                    cx = ox + nums[i + 5];
                    cy = oy + nums[i + 6];
                    add(cx, cy);
                }
                break;
            case "Z":
                cx = sx;
                cy = sy;
                break;
        }
    }
    if (!(x1 >= x0))
        return undefined;
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0, approx };
}
/** Translate an absolute path by (dx, dy). Relative commands are left as they are (they follow the move-to). */
export function translatePath(d, dx, dy) {
    const out = [];
    let first = true;
    for (const { cmd, nums } of parse(d)) {
        const rel = cmd === cmd.toLowerCase();
        const c = cmd.toUpperCase();
        const n = [...nums];
        if (c === "Z") {
            out.push(cmd);
            continue;
        }
        if (!rel || (first && c === "M")) {
            if (c === "H")
                for (let i = 0; i < n.length; i++)
                    n[i] += dx;
            else if (c === "V")
                for (let i = 0; i < n.length; i++)
                    n[i] += dy;
            else if (c === "A")
                for (let i = 0; i + 6 < n.length; i += 7) {
                    n[i + 5] += dx;
                    n[i + 6] += dy;
                }
            else
                for (let i = 0; i + 1 < n.length; i += 2) {
                    n[i] += dx;
                    n[i + 1] += dy;
                }
        }
        first = false;
        out.push(cmd + n.map(fmt).join(" "));
    }
    return out.join(" ");
}
