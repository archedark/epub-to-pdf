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
    "--paper-size", pageSize,
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