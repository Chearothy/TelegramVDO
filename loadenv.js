'use strict';
// Tiny .env loader (no dependency). Real environment variables win over the file.
// Also copes with Windows quirks: ".env.txt" (hidden extension), UTF-8 BOM and UTF-16 files.
const fs = require('fs');
const path = require('path');

const info = { file: null, notes: [], empty: [] };

function readText(file) {
  const buf = fs.readFileSync(file);
  const text = (buf[0] === 0xFF && buf[1] === 0xFE) ? buf.toString('utf16le') : buf.toString('utf8');
  return text.replace(/^\uFEFF/, '');
}

['.env', '.env.txt'].some(function (name) {
  const file = path.join(__dirname, name);
  if (!fs.existsSync(file)) return false;
  info.file = file;
  if (name !== '.env') info.notes.push('Found ".env.txt". Rename it to ".env" (Windows added .txt).');
  readText(file).split(/\r?\n/).forEach(function (line) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) return;
    const value = m[2].replace(/^["']|["']$/g, '');
    if (value === '') info.empty.push(m[1]);
    if (value !== '' && !process.env[m[1]]) process.env[m[1]] = value;
  });
  return true;
});

// Write or replace KEY=value in .env (keeps the other lines). Used by login.js so you never copy the session by hand.
info.save = function (key, value) {
  const file = path.join(__dirname, '.env');
  let text = '';
  try { text = readText(file); } catch (e) { /* new file */ }
  const nl = text.indexOf('\r\n') !== -1 ? '\r\n' : '\n';
  const re = new RegExp('^[ \\t]*' + key + '[ \\t]*=.*$', 'm');
  if (re.test(text)) text = text.replace(re, function () { return key + '=' + value; });
  else text += (text && !/\n$/.test(text) ? nl : '') + key + '=' + value + nl;
  fs.writeFileSync(file, text, 'utf8');
  return file;
};

module.exports = info;
