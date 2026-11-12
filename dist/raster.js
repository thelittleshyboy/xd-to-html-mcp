import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { findBrowser } from "./render.js";
/** Rasterize trusted, internally generated SVGs in one offline browser process per batch. */
export async function rasterize(svgs) {
    if (!svgs.length)
        return [];
    const browser = await findBrowser();
    if (!browser)
        throw new Error("HTML image export requires Chrome or Edge. Set XD_MCP_CHROME to the browser executable.");
    const output = [];
    for (let start = 0; start < svgs.length; start += 30) {
        const dir = await mkdtemp(path.join(tmpdir(), "xd-assets-"));
        try {
            const data = svgs.slice(start, start + 30).map(svg => Buffer.from(svg).toString("base64"));
            const html = `<!doctype html><meta charset="utf-8"><pre id="result"></pre><script>(async()=>{try{const out=[];for(const b of ${JSON.stringify(data)}){const img=new Image();img.src='data:image/svg+xml;base64,'+b;await img.decode();if(img.width>16384||img.height>16384||img.width*img.height>40000000)throw Error('Image slice exceeds raster limits');const c=document.createElement('canvas');c.width=img.width;c.height=img.height;c.getContext('2d').drawImage(img,0,0);out.push(c.toDataURL('image/png').split(',')[1])}document.querySelector('pre').textContent=JSON.stringify(out)}catch(e){document.querySelector('pre').textContent=JSON.stringify({error:String(e)})}})()</script>`;
            const file = path.join(dir, "assets.html");
            await writeFile(file, html);
            const dom = await new Promise((resolve, reject) => execFile(browser, ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions", "--disable-background-networking", "--host-resolver-rules=MAP * ~NOTFOUND", `--user-data-dir=${path.join(dir, "profile")}`, "--virtual-time-budget=10000", "--dump-dom", pathToFileURL(file).href], { timeout: 90000, windowsHide: true, maxBuffer: 80 * 1024 * 1024 }, (err, stdout) => err ? reject(err) : resolve(stdout)));
            const raw = dom.match(/<pre id="result">([^<]+)<\/pre>/)?.[1];
            if (!raw)
                throw new Error("Browser did not finish rasterizing HTML image slices.");
            const result = JSON.parse(raw);
            if (!Array.isArray(result) || result.length !== data.length)
                throw new Error(`Rasterization failed: ${result.error ?? "incomplete output"}`);
            for (const png of result)
                output.push(Buffer.from(png, "base64"));
        }
        finally {
            // dir was created by mkdtemp for this batch, never derived from document paths.
            await rm(dir, { recursive: true, force: true });
        }
    }
    return output;
}
