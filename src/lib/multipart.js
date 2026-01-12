"use strict";

const formidable = require("formidable");
const fs = require("fs");

/**
 * Parse multipart/form-data request using formidable.
 * Returns { fields, files }.
 */
function parseMultipart(req, opts = {}) {
  const form = formidable({
    multiples: false,
    maxFileSize: opts.maxFileSize || 6 * 1024 * 1024, // 6MB default
    keepExtensions: true,
  });

  return new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => {
      if (err) return reject(err);
      resolve({ fields, files });
    });
  });
}

/**
 * Read formidable file into Buffer
 */
function fileToBuffer(file) {
  if (!file || !file.filepath) throw new Error("Missing uploaded file");
  return fs.promises.readFile(file.filepath);
}

module.exports = { parseMultipart, fileToBuffer };
