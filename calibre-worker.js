import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFilePromise = promisify(execFile);

process.on('message', async (task) => {
  if (task.type === 'CONVERT') {
    const { flags, originalDownloadName, input, output } = task.payload; // Added input/output for logging if needed
    try {
      console.log(`Calibre Worker: Starting conversion for ${originalDownloadName}...`);
      // The 'flags' array should contain the full paths for input and output
      await execFilePromise("ebook-convert", flags, { maxBuffer: 20 * 1024 * 1024 }); // 20MB buffer
      console.log(`Calibre Worker: Finished conversion for ${originalDownloadName} to ${output}`);
      process.send({ status: 'success', outputPath: output, originalDownloadName });
    } catch (error) {
      console.error(`Calibre Worker: Conversion error for ${originalDownloadName}:`, error);
      process.send({ status: 'error', error: error.message || 'Conversion failed in worker', originalDownloadName });
    }
  }
});

// Send a ready message to the parent process when the worker starts
process.send({ status: 'ready' });
console.log('Calibre worker started and listening for tasks.'); 