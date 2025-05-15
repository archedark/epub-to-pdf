import express          from "express";
import multer           from "multer";
import rateLimit        from "express-rate-limit";
import { execFile, fork }     from "node:child_process";
import fs               from "node:fs/promises";
import { mkdtemp, rm }  from "node:fs/promises";
import { tmpdir }       from "node:os";
import path             from "node:path";
import { promisify }    from "node:util";

const execFilePromise = promisify(execFile);

const app    = express();
const upload = multer({ limits: { fileSize: 75 * 1024 * 1024 } });

// Worker management variables
let calibreWorker;
let isWorkerReady = false;
let isWorkerBusy = false; // To track if the single worker is currently processing a job
let workerJobCallback = null; // To store the callback for the current job

function startCalibreWorker() {
  console.log('Starting Calibre worker process...');
  // Ensure the path to calibre-worker.js is correct, assuming it's in the root
  const workerPath = path.resolve(process.cwd(), 'calibre-worker.js');
  calibreWorker = fork(workerPath);
  isWorkerReady = false; // Will be set to true upon 'ready' message
  isWorkerBusy = false; // Worker starts as not busy

  calibreWorker.on('message', (msg) => {
    if (msg.status === 'ready') {
      isWorkerReady = true;
      console.log('Calibre worker is ready and connected.');
    } else if (msg.status === 'success' || msg.status === 'error') {
      if (workerJobCallback) {
        workerJobCallback(msg); // Resolve the promise/callback for the HTTP request
        workerJobCallback = null; // Clear callback after use
      } else {
        console.warn("Worker sent a result, but no job callback was registered.", msg);
      }
      isWorkerBusy = false; // Worker is no longer busy after completing/failing a task
    }
  });

  calibreWorker.on('exit', (code, signal) => {
    isWorkerReady = false;
    isWorkerBusy = false; // If worker exits, it's not busy
    workerJobCallback = null; // Clear any pending callback
    console.error(`Calibre worker exited with code ${code} and signal ${signal}`);
    // Optionally, implement a restart limit or different strategy for repeated crashes
    if (code !== 0 && signal !== 'SIGINT') { // Don't restart on clean exit or manual termination (like nodemon restart)
      console.log('Restarting Calibre worker in 2 seconds...');
      setTimeout(startCalibreWorker, 2000); // Restart after a short delay
    }
  });

  calibreWorker.on('error', (err) => {
    isWorkerReady = false;
    isWorkerBusy = false;
    console.error('Calibre worker encountered an error:', err);
    // Consider if a restart is appropriate here too
  });
}

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
  if (!req.file) {
    return res.status(400).send("No EPUB file uploaded.");
  }

  if (!isWorkerReady || !calibreWorker || !calibreWorker.connected) {
    console.error("Convert request: Calibre worker is not ready or not connected.");
    return res.status(503).send("Server busy: Conversion worker is not available. Please try again shortly.");
  }

  if (isWorkerBusy) {
    console.warn("Convert request: Worker is busy with another task.");
    return res.status(503).send("Server busy: Currently processing another conversion. Please try again shortly.");
  }

  isWorkerBusy = true; // Set worker as busy
  let tempDir;

  try {
    tempDir = await mkdtemp(path.join(tmpdir(), "epub2pdf-"));
    const inputEpubPath  = path.join(tempDir, "book.epub");
    const outputPdfPath = path.join(tempDir, "book.pdf");
    await fs.writeFile(inputEpubPath, req.file.buffer);

    const pageSize = req.body.pageSize ?? "a5";
    const margin   = req.body.margin   ?? 36;
    const baseFontSize = req.body.baseFontSize ?? "12";

    const flags = [
      inputEpubPath, outputPdfPath,
      "--paper-size", pageSize,
      "--margin-top", margin,
      "--margin-right", margin,
      "--margin-bottom", margin,
      "--margin-left", margin,
      "--embed-all-fonts",
      "--base-font-size", baseFontSize
    ];

    const originalDownloadName = req.file.originalname.replace(/\.epub$/i,".pdf");

    const conversionPromise = new Promise((resolve) => {
      workerJobCallback = resolve; // Store the resolve function for this job
    });

    calibreWorker.send({
      type: 'CONVERT',
      payload: {
        input: inputEpubPath,
        output: outputPdfPath,
        flags,
        originalDownloadName
      }
    });

    // console.log(`Task sent to worker for ${originalDownloadName}. Waiting for response...`);
    const result = await conversionPromise;
    // console.log(`Received response from worker for ${originalDownloadName}:`, result);

    if (result.status === 'success' && result.originalDownloadName === originalDownloadName) {
      res.download(result.outputPath, originalDownloadName, async (downloadError) => {
        if (downloadError) {
          console.error("Error sending file to client:", downloadError);
          // If headers not sent, can send error. Otherwise, connection might just close.
          if (!res.headersSent) {
            res.status(500).send("Failed to send the converted file.");
          }
        }
        if (tempDir) {
          await rm(tempDir, { recursive: true, force: true }).catch(err => console.error("Failed to cleanup temp dir after successful download:", err));
        }
      });
    } else {
      console.error("Worker conversion failed or mismatched response:", result.error || 'Unknown worker error');
      if (!res.headersSent) {
        res.status(500).send(result.error || "Conversion failed via worker");
      }
      if (tempDir) {
        await rm(tempDir, { recursive: true, force: true }).catch(err => console.error("Failed to cleanup temp dir after failed conversion:", err));
      }
    }
  } catch (error) {
    console.error("Error in /convert route with worker:", error);
    if (!res.headersSent) {
      res.status(500).send("Server error during conversion process.");
    }
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(err => console.error("Failed to cleanup temp dir in main catch block:", err));
    }
  } finally {
    // isWorkerBusy is reset inside the worker message handler or if worker exits
    // No, it should be reset when the job is *done* from the main server's perspective
    // The worker message handler already sets isWorkerBusy = false;
  }
});

app.listen(3000, () => {
  console.log("⇢ API ready on :3000");
  startCalibreWorker(); // Start the worker when the server starts
}); 