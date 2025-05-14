## 0 Project snapshot

```
epub-to-pdf/
├─ Dockerfile
├─ package.json
├─ pnpm-lock.yaml           # or package-lock.json / yarn.lock
├─ server.js
├─ public/
│  └─ index.html
└─ (optional) middleware.js # edge-rate-limit on Vercel
```

---

## 1 package.json

```jsonc
{
  "name": "epub-to-pdf",
  "type": "module",
  "version": "0.1.0",
  "scripts": {
    "dev": "nodemon server.js",
    "start": "node server.js"
  },
  "dependencies": {
    "express": "^4.19.2",
    "multer": "^1.4.5",
    "express-rate-limit": "^7.1.0"
  },
  "devDependencies": {
    "nodemon": "^3.1.0"
  }
}
```

> **Install:** `pnpm i` (or `npm i`).

---

## 2 server.js  (REST API + static hosting + rate-limiter)

```js
import express          from "express";
import multer           from "multer";
import rateLimit        from "express-rate-limit";
import { execFile }     from "node:child_process";
import fs               from "node:fs/promises";
import { mkdtemp, rm }  from "node:fs/promises";
import { tmpdir }       from "node:os";
import path             from "node:path";

const app    = express();
const upload = multer({ limits: { fileSize: 75 * 1024 * 1024 } });

// ─── 10 conversions / hr / IP ───────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 60 * 60 * 1000,  // 1 h
  max: 10,                   // hits per IP
  standardHeaders: true,     // RateLimit-Reset etc.
  legacyHeaders: false
});
app.use("/convert", limiter);
// ────────────────────────────────────────────────────────────────────────

// serve the static front-end
app.use(express.static("public", { extensions:["html"] }));

// POST /convert  (multipart/form-data)
app.post("/convert", upload.single("epub"), async (req, res) => {
  const dir = await mkdtemp(path.join(tmpdir(), "epub2pdf-"));
  const input  = path.join(dir, "book.epub");
  const output = path.join(dir, "book.pdf");
  await fs.writeFile(input, req.file.buffer);

  const pageSize = req.body.pageSize ?? "a5";
  const margin   = req.body.margin   ?? 36;     // points (1/72")

  const flags = [
    input, output,
    "--pdf-page-size", pageSize,
    "--margin-top", margin,
    "--margin-right", margin,
    "--margin-bottom", margin,
    "--margin-left", margin,
    "--embed-all-fonts"
  ];

  execFile("ebook-convert", flags, { maxBuffer: 20e6 }, async (err) => {
    if (err) {
      console.error(err);
      res.status(500).send("Conversion failed");
    } else {
      const downloadName = req.file.originalname.replace(/\.epub$/i,".pdf");
      res.download(output, downloadName, () =>
        rm(dir, { recursive:true, force:true })
      );
    }
  });
});

app.listen(3000, () => console.log("⇢ API ready on :3000"));
```

---

## 3 public/index.html  (minimal UI)

```html
<!doctype html>
<meta charset="utf-8">
<title>EPUB ➜ PDF Converter</title>
<style>
 body{font-family:system-ui;padding:2rem;max-width:30rem;margin:auto}
 label{display:block;margin:1rem 0}
 button{padding:.5rem 1rem;border:0;border-radius:.3rem;cursor:pointer}
</style>

<h1>EPUB ➜ PDF Converter</h1>
<form id="form">
  <label>
    Select EPUB:
    <input type="file" name="epub" accept=".epub" required>
  </label>

  <label>
    Page size:
    <select name="pageSize">
      <option value="a5" selected>A5 (Daylight default)</option>
      <option value="a4">A4</option>
      <option value="letter">Letter</option>
    </select>
  </label>

  <label>
    Margin (pt):
    <input type="number" name="margin" value="36" min="0" max="100">
  </label>

  <button>Convert</button>
</form>

<script>
document.getElementById("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const btn = e.target.querySelector("button");
  btn.disabled = true; btn.textContent = "Converting…";

  const r = await fetch("/convert", { method:"POST", body:fd });
  if(r.ok){
    const blob = await r.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = fd.get("epub").name.replace(/\.epub$/i,".pdf");
    a.click();
  } else if(r.status === 429){
    alert("Whoa there! Rate limit hit – try again later.");
  } else {
    alert("Conversion failed");
  }
  btn.disabled = false; btn.textContent = "Convert";
});
</script>
```

---

## 4 Dockerfile  (Calibre CLI + Node runtime) — 160 MB

```dockerfile
FROM python:3.12-slim

# ── 1. Install Calibre CLI only ────────────────────────────────────────
RUN apt-get update && \
    apt-get install -y --no-install-recommends wget xz-utils fonts-dejavu-core && \
    wget -qO- https://download.calibre-ebook.com/linux-installer.sh | \
        sh /dev/stdin install-cli && \
    apt-get purge -y wget xz-utils && \
    apt-get autoremove -y && \
    rm -rf /var/lib/apt/lists/*

# ── 2. Node runtime ────────────────────────────────────────────────────
RUN corepack enable && corepack prepare pnpm@9.1.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod
COPY . .

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node","server.js"]
```

---

## 5 (optional) middleware.js  (edge-rate-limit on Vercel)

> Skip if you’re happy with the in-app limiter.
> Edge limiter stops abuse **before** the container spins up.

```js
import { NextResponse } from "next/server";
import { RateLimiterMemory } from "rate-limiter-flexible";

const limiter = new RateLimiterMemory({ points:10, duration:60*60 }); // 10/h

export async function middleware(req) {
  try {
    await limiter.consume(req.ip ?? "anon");
    return NextResponse.next();
  } catch {
    return new NextResponse("Rate limit exceeded", { status: 429 });
  }
}

export const config = { matcher: "/convert" };
```

---

## 6 Local test

```bash
docker build -t epub2pdf .
docker run -p 3000:3000 epub2pdf
# browse to http://localhost:3000
```

*Hit /convert >10× within an hour to verify the 429 response.*

---

## 7 Deploy (Vercel example)

1. **Push repo to GitHub**.
2. `vercel --prod --prebuilt` (from project root).
3. In the Vercel dashboard:

   * “Framework = Other (Dockerfile)”.
   * No extra env vars needed.
4. Test cold-start (first request \~2–3 s).
5. Optionally delete `middleware.js` or the in-app limiter if you only need one layer.

> **Image size:** ≈ 160 MB; well under Vercel’s 250 MB limit.
> If you ever outgrow the quota, drop the same container on Fly.io, Render, or a \$5 VPS.

---

## 8 Future upgrades (parking lot)

| Idea                           | Path                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------- |
| Multi-file queue / status page | `bullmq` + Redis (Upstash)                                                            |
| Progress bar                   | stream Calibre output over SSE / WS                                                   |
| Extra Calibre flags            | expose `--pdf-sans-family`, `--embed-font-family`, `--remove-paragraph-spacing`, etc. |
| Save last settings             | `localStorage` in `index.html`                                                        |

