/**
 * Packages the Chrome extension into extension.zip for team distribution.
 * Run: npm run package-extension
 *
 * Includes: all runtime extension files.
 */

const archiver = require('archiver');
const fs = require('fs');
const path = require('path');

const OUTPUT = path.join(__dirname, '..', 'extension.zip');
const EXT_DIR = path.join(__dirname, '..', 'extension');

// Remove old zip if it exists
if (fs.existsSync(OUTPUT)) fs.unlinkSync(OUTPUT);

const output = fs.createWriteStream(OUTPUT);
const archive = archiver('zip', { zlib: { level: 9 } });

output.on('close', () => {
  const kb = (archive.pointer() / 1024).toFixed(1);
  console.log(`✓ extension.zip created (${kb} KB)`);
  console.log('  Share this file with your team for Chrome extension installation.');
});

archive.on('error', (err) => { throw err; });
archive.pipe(output);

// Include everything in extension/ (runtime files only).
archive.glob('**/*', { cwd: EXT_DIR });

archive.finalize();
