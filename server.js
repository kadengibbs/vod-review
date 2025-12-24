const express = require("express");
const path = require("path");

function startServer(port = 3000) {
  const app = express();

  // Serve everything in this folder (index.html, renderer.js, etc.)
  app.use(express.static(__dirname));

  return new Promise((resolve) => {
    const server = app.listen(port, "127.0.0.1", () => resolve({ server, port }));
  });
}

module.exports = { startServer };
