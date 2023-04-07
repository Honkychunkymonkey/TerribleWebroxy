const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const url = require('url');
const axios = require('axios');
const cheerio = require('cheerio');
const cache = require('memory-cache');
const compression = require('compression');
const async = require('async');
const sharp = require('sharp');
const morgan = require('morgan');
const helmet = require('helmet');
const cluster = require('cluster');
const os = require('os');

const app = express();
const port = process.env.PORT || 3000;

app.use(compression({ level: 9 }));
app.use(morgan('dev'));
app.set('etag', 'strong');
app.use(helmet());

function rewriteUrls(html, proxyUrl, originalUrl) {
  const $ = cheerio.load(html);
  const absolutizeUrl = (relativeUrl) => {
    return new url.URL(relativeUrl, originalUrl).toString();
  };

  const elements = $('a[href], link[href], script[src], img[src]');

  async.each(elements, (element, callback) => {
    const tag = element.name;
    const attr = tag === 'a' || tag === 'link' ? 'href' : 'src';
    let resourceUrl = $(element).attr(attr);

    if (!resourceUrl.startsWith('http') && !resourceUrl.startsWith('//')) {
      resourceUrl = absolutizeUrl(resourceUrl);
    }

    const proxiedUrl = `${proxyUrl}/${resourceUrl.replace(/^https?:\/\//, '')}`;
    $(element).attr(attr, proxiedUrl);

    callback();
  }, (err) => {
    if (err) {
      console.error('Error while processing resources:', err);
    }
  });

  return $.html();
}

function cacheMiddleware(duration) {
  return (req, res, next) => {
    const key = '__proxy_cache__' + req.originalUrl;
    const cachedContent = cache.get(key);
    if (cachedContent) {
      res.send(cachedContent);
      return;
    }

    res.originalSend = res.send;
    res.send = (body) => {
      cache.put(key, body, duration * 1000);
      res.originalSend(body);
    };

    next();
  };
}

// Use the cache middleware before proxying requests
app.use(cacheMiddleware(60)); // Cache for 60 seconds

function rewriteUrls(html, proxyUrl, originalUrl) {
  const $ = cheerio.load(html);
const absolutizeUrl = (relativeUrl) => {
    return new url.URL(relativeUrl, originalUrl).toString();
  };

  $('a[href], link[href], script[src], img[src]').each(function () {
    const tag = this.name;
    const attr = tag === 'a' || tag === 'link' ? 'href' : 'src';
    let resourceUrl = $(this).attr(attr);

    if (!resourceUrl.startsWith('http') && !resourceUrl.startsWith('//')) {
      resourceUrl = absolutizeUrl(resourceUrl);
    }

    const proxiedUrl = `${proxyUrl}/${resourceUrl.replace(/^https?:\/\//, '')}`;
    $(this).attr(attr, proxiedUrl);
  });

  return $.html();
}
    
  
function injectBaseTag(html, baseUrl) {
  const baseTag = `<base href="${baseUrl}">`;
  const headTag = /<head[^>]*>/i;
  return html.replace(headTag, `$&${baseTag}`);
}

function injectFaviconTag(html, req) {
  const targetDomain = url.parse(req.target).hostname;
  const faviconTag = `<link rel="shortcut icon" type="image/x-icon" href="https://www.google.com/s2/favicons?domain=${encodeURIComponent(targetDomain)}">`;
  const headTag = /<head[^>]*>/i;
  return html.replace(headTag, `$&${faviconTag}`);
}

function modifyResponseContent(onProxyRes, req, res) {
  const _write = res.write;
  const _end = res.end;
  let buffer = Buffer.alloc(0);

app.use((proxyRes, req, res, next) => {
    res.write = chunk => {
      buffer = Buffer.concat([buffer, chunk]);
    };

    res.end = async () => {
  const contentType = res.get('content-type');
  if (contentType && contentType.startsWith('text/html')) {
    let modifiedContent = injectBaseTag(buffer.toString(), req.baseUrl);
    modifiedContent = injectFaviconTag(modifiedContent, req);
    modifiedContent = rewriteUrls(modifiedContent, req.baseUrl, req.target);
    res.setHeader('content-length', Buffer.byteLength(modifiedContent));
    _write.call(res, modifiedContent);
  } else if (contentType && contentType.startsWith('image/')) {
    try {
      const webpBuffer = await sharp(buffer).webp({ quality: 75 }).toBuffer();
      res.setHeader('content-type', 'image/webp');
      res.setHeader('content-length', webpBuffer.length);
      _write.call(res, webpBuffer);
    } catch (err) {
      console.error('Failed to convert image to WebP:', err);
      _write.call(res, buffer);
    }
  } else {
    _write.call(res, buffer);
  }
  _end.call(res);
};

  });

  return (req, res, next) => {
    req.baseUrl = req.protocol + '://' + req.get('host');
    onProxyRes(null, req, res);
    next();
  };
}

// ... (previous code remains the same)

app.use((req, res, next) => {
  const regex = /^\/(https?:)(\/{1,2})(.+)$/;
  if (req.url.match(regex)) {
    const match = req.url.match(regex);
    const target = `${match[1]}//${match[3]}`;
    const targetDomain = url.parse(target).hostname;

    if (targetDomain === 'terriblewebroxy.o-lawd-he-comin.repl.co') {
      return res.status(400).send('Proxying to itself is not allowed');
    }

    req.target = target;
    next();
  } else {
    next();
  }
});

app.use((req, res, next) => {
  if (req.target) {
    return createProxyMiddleware({
      target: req.target,
      changeOrigin: true,
      secure: false,
      followRedirects: true,
      ws: true,
      perMessageDeflate: true,
      xfwd: false,
      pathRewrite: (path, req) => {
        const proxyPath = req.originalUrl.replace(/^\/(https?:)(\/{1,2})(.+)$/, '');
        return proxyPath;
      },
      onProxyRes: (proxyRes, req, res) => {
        // Force CORS headers
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Content-Length, X-Requested-With');

        // Modify security headers
        delete proxyRes.headers['x-frame-options'];
        delete proxyRes.headers['x-content-type-options'];
        delete proxyRes.headers['x-xss-protection'];
        delete proxyRes.headers['content-security-policy'];
        delete proxyRes.headers['strict-transport-security'];
      },
    })(req, res, next);
  }

  next();
});

// Move function declaration below the last app.use block
app.use((proxyRes, req, res, next) => {
  const _write = res.write;
  const _end = res.end;
  let buffer = Buffer.alloc(0);

  res.write = chunk => {
    buffer = Buffer.concat([buffer, chunk]);
  };

  res.end = () => {
    const contentType = res.get('content-type');
    if (contentType && contentType.startsWith('text/html')) {
      let modifiedContent = injectBaseTag(buffer.toString(), req.baseUrl);
      modifiedContent = injectFaviconTag(modifiedContent, req);
      res.setHeader('content-length', Buffer.byteLength(modifiedContent));
      _write.call(res, modifiedContent);
    } else {
      _write.call(res, buffer);
    }
    _end.call(res);
  };
});

if (cluster.isMaster) {
  const numCPUs = os.cpus().length;
  console.log(`Master process ${process.pid} is running`);

  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    console.log(`Worker ${worker.process.pid} died`);
    cluster.fork();
  });
} else {
  app.listen(port, () => {
    console.log(`Worker process ${process.pid} started`);
    console.log(`Web proxy listening at http://localhost:${port}`);
  });
}
