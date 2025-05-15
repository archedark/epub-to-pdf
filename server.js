import express          from "express";
import multer           from "multer";
import rateLimit        from "express-rate-limit";
import { execFile }     from "node:child_process";
import fs               from "node:fs/promises";
import { mkdtemp, rm }  from "node:fs/promises";
import { tmpdir }       from "node:os";
import path             from "node:path";
import { promisify }    from "node:util";

const execFilePromise = promisify(execFile);

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

// POST /preview (multipart/form-data) - Not rate-limited
app.post("/preview", upload.single("epub"), async (req, res) => {
  let dir;
  try {
    if (!req.file) {
      return res.status(400).send("No EPUB file uploaded.");
    }
    dir = await mkdtemp(path.join(tmpdir(), "epub2pdf-preview-"));
    const inputEpub = path.join(dir, "book.epub");
    const tempFullPdf = path.join(dir, "full_preview.pdf");
    const outputPreviewPdf = path.join(dir, "preview.pdf");

    await fs.writeFile(inputEpub, req.file.buffer);

    const pageSize = req.body.pageSize ?? "a5";
    const margin = req.body.margin ?? 36;     // points (1/72")
    const baseFontSize = req.body.baseFontSize ?? "12"; // Default to 12pt
    const previewPageCount = 10;

    const ebookConvertFlags = [
      inputEpub, tempFullPdf,
      "--paper-size", pageSize,
      "--margin-top", margin,
      "--margin-right", margin,
      "--margin-bottom", margin,
      "--margin-left", margin,
      "--embed-all-fonts",
      "--base-font-size", baseFontSize
    ];

    // Step 1: Convert EPUB to full PDF (for preview)
    await execFilePromise("ebook-convert", ebookConvertFlags, { maxBuffer: 20e6 });

    // Step 2: Extract first N pages using Ghostscript
    const gsFlags = [
      "-q", // Quiet mode
      "-sDEVICE=pdfwrite",
      "-dNOPAUSE",
      "-dBATCH",
      "-dSAFER",
      `-dFirstPage=1`,
      `-dLastPage=${previewPageCount}`,
      `-sOutputFile=${outputPreviewPdf}`,
      tempFullPdf
    ];
    await execFilePromise("gs", gsFlags); // Assumes gs is in PATH and executable

    // Step 3: Send the preview PDF
    res.sendFile(outputPreviewPdf, (err) => {
      if (err) {
        console.error("Error sending preview PDF:", err);
        // If res.sendFile fails after headers might have been sent,
        // we can't reliably send a 500. Client might experience issues.
      }
      // Cleanup is handled in the finally block
    });

  } catch (error) {
    console.error("Preview generation failed:", error);
    if (!res.headersSent) {
      res.status(500).send("Preview generation failed. Check server logs.");
    }
  } finally {
    if (dir) {
      await rm(dir, { recursive: true, force: true }).catch(err => console.error("Failed to cleanup temp dir:", err));
    }
  }
});

// POST /convert  (multipart/form-data)
app.post("/convert", upload.single("epub"), async (req, res) => {
  const dir = await mkdtemp(path.join(tmpdir(), "epub2pdf-"));
  const input  = path.join(dir, "book.epub");
  const output = path.join(dir, "book.pdf");
  await fs.writeFile(input, req.file.buffer);

  const pageSize = req.body.pageSize ?? "a5";
  const margin   = req.body.margin   ?? 36;     // points (1/72")
  const baseFontSize = req.body.baseFontSize ?? "12"; // Default to 12pt

  const flags = [
    input, output,
    "--paper-size", pageSize,
    "--margin-top", margin,
    "--margin-right", margin,
    "--margin-bottom", margin,
    "--margin-left", margin,
    "--embed-all-fonts",
    "--base-font-size", baseFontSize
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