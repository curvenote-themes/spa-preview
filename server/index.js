import express from "express";
import http from "node:http";
import { createProxyMiddleware } from "http-proxy-middleware";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const version = "0.1.2";
const __dirname$1 = path.dirname(fileURLToPath(import.meta.url));
const isProduction = process.env.NODE_ENV === "production";
const port = process.env.PORT || 3e3;
const contentCdnPort = process.env.CONTENT_CDN_PORT || 3100;
const contentCdnHost = process.env.CONTENT_CDN_HOST || "localhost";
const contentCdnUrl = `${contentCdnHost}:${contentCdnPort}`;
const rawBasePath = process.env.BASE_PATH || "";
const basePath = rawBasePath.replace(/[^a-zA-Z0-9\-_/]/g, "").replace(/\/+/g, "/").replace(/\/$/, "");
let serverInstance = null;
function stripHttpProtocols(...args) {
  return args.map((arg) => {
    if (typeof arg === "string") {
      return arg.replace(/https?:\/\//gi, "");
    }
    return arg;
  });
}
const proxyLogger = {
  log: (...args) => {
    const cleanedArgs = stripHttpProtocols(...args);
    console.log(...cleanedArgs);
  },
  info: (...args) => {
    const cleanedArgs = stripHttpProtocols(...args);
    console.info(...cleanedArgs);
  },
  warn: (...args) => {
    const cleanedArgs = stripHttpProtocols(...args);
    console.warn(...cleanedArgs);
  },
  error: (...args) => {
    const cleanedArgs = stripHttpProtocols(...args);
    console.error(...cleanedArgs);
  },
  debug: (...args) => {
    if (!isProduction) {
      const cleanedArgs = stripHttpProtocols(...args);
      console.debug(...cleanedArgs);
    }
  }
};
function createServer() {
  if (serverInstance) {
    console.log("Server already running, skipping duplicate start");
    return;
  }
  console.log(`Starting server with BASE_PATH: ${basePath || "(none)"}`);
  const app = express();
  if (isProduction) {
    const clientPath = path.resolve(__dirname$1, "../client");
    console.log("Serving static files from:", clientPath);
    app.use(
      `${basePath}/assets`,
      express.static(path.join(clientPath, "assets"), { fallthrough: false })
    );
  }
  app.get("_hello", (req, res) => {
    res.json({
      name: "Curvenote Preview Express Server",
      version
    });
  });
  app.use(
    `${basePath}/_build`,
    createProxyMiddleware({
      target: `http://${contentCdnUrl}`,
      changeOrigin: true,
      pathRewrite: {
        // Remove the /_build prefix before forwarding to CDN
        // e.g., /_build/article -> /article
        [`^${basePath}/_build`]: ""
      },
      logger: proxyLogger
    })
  );
  const wsProxy = createProxyMiddleware({
    target: `http://${contentCdnUrl}`,
    changeOrigin: true,
    ws: true,
    pathRewrite: {
      [`^${basePath}/_socket`]: "/socket"
    },
    logger: proxyLogger
  });
  app.use(`${basePath}/_socket`, wsProxy);
  const spaRouteHandler = async (req, res, next) => {
    if (req.path.startsWith("/assets/")) {
      return next();
    }
    console.log("Serving index.html for route:", req.url.replace(/^https?:\/\/[^/]+/, ""));
    try {
      let html = "";
      if (isProduction) {
        const clientPath = path.resolve(__dirname$1, "../client");
        html = fs.readFileSync(path.join(clientPath, "index.html"), "utf-8");
      } else {
        const indexPath = path.resolve(__dirname$1, "../../index.html");
        html = fs.readFileSync(indexPath, "utf-8");
      }
      const headInjection = `
    <script>window.__BASE_PATH__ = "${basePath}";<\/script>
    <script>window.thebeLite = { version: 'monkey-patch-not-loaded' };<\/script>
    <script src="${basePath}/thebe-core.min.js" onload="window.setupThebeCore?.()"><\/script>
    <link rel="stylesheet" href="${basePath}/thebe-core.css">
  </head>`;
      html = html.replace("</head>", headInjection);
      html = html.replace(/src="\/assets\//g, `src="${basePath}/assets/`);
      html = html.replace(/href="\/assets\//g, `href="${basePath}/assets/`);
      html = html.replace(/href="\/app\//g, `href="${basePath}/app/`);
      res.send(html).end();
    } catch (error) {
      next(error);
    }
  };
  function thebeAssetsHandler(req, res, next) {
    const thebeAssetsPath = path.resolve(__dirname$1, "./public");
    let assetPath = req.path;
    if (basePath && assetPath.startsWith(basePath)) {
      assetPath = assetPath.slice(basePath.length);
    }
    const thebeAssets = fs.readFileSync(path.join(thebeAssetsPath, assetPath), "utf-8");
    res.send(thebeAssets).end();
  }
  app.get(`${basePath}`, (req, res, next) => {
    spaRouteHandler(req, res, next);
  });
  app.get(`${basePath}/*`, (req, res, next) => {
    if (req.path.endsWith("thebe-core.min.js") || req.path.endsWith("thebe-lite.min.js") || req.path.endsWith("/service-worker.js") || req.path.endsWith("/thebe-core.css")) {
      return thebeAssetsHandler(req, res);
    }
    spaRouteHandler(req, res, next);
  });
  app.get("*", (req, res, next) => {
    if (req.path.endsWith("thebe-core.min.js") || req.path.endsWith("thebe-lite.min.js") || req.path.endsWith("/service-worker.js") || req.path.endsWith("/thebe-core.css")) {
      return thebeAssetsHandler(req, res);
    }
    if (basePath && !req.path.startsWith(basePath)) {
      return res.redirect(basePath);
    }
    next();
  });
  const server = http.createServer(app);
  serverInstance = server;
  server.on("upgrade", (req, socket, head) => {
    if (req.url?.startsWith(`${basePath}/_socket`)) {
      console.log("✅ Proxying WebSocket to content CDN...");
      wsProxy.upgrade?.(req, socket, head);
    } else {
      console.log("❌ WebSocket URL did not match, destroying socket");
      socket.destroy();
    }
  });
  server.listen(port, () => {
    const baseUrl = `localhost:${port}${basePath}`;
    console.log("Curvenote Preview Server is running...");
    console.log(`Server running at ${baseUrl}`);
    console.log(`  - Build API: ${baseUrl}/_build/:slug`);
    console.log(`  - WebSocket: ws://localhost:${port}${basePath}/_socket`);
  });
}
createServer();
