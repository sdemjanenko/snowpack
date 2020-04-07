/**
 * This license applies to parts of this file originating from the
 * https://github.com/lukejacksonn/servor repository:
 *
 * MIT License
 * Copyright (c) 2019 Luke Jackson
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import url from 'url';
import path from 'path';
import {EventEmitter} from 'events';
import http from 'http';
import mime from 'mime-types';
import chalk from 'chalk';
import execa from 'execa';
import {promises as fs, watch as fsWatch, statSync, readdirSync, existsSync} from 'fs';
import babel from '@babel/core';
import {paint} from './paint';

const cwd = process.cwd();
const FILE_CACHE = new Map<string, string>();

const LIVE_RELOAD_SNIPPET = `
  <script>
    const source = new EventSource('/livereload');
    const reload = () => location.reload(true);
    source.onmessage = reload;
    source.onerror = () => (source.onopen = reload);
    console.log('[snowpack] listening for file changes');
  </script>
`;

function getEncodingType(ext: string): 'utf8' | 'binary' {
  if (ext === '.js' || ext === '.css' || ext === '.html') {
    return 'utf8';
  } else {
    return 'binary';
  }
}

function watch(fileLoc: string, notify: (event: string, filename: string) => void) {
  if (process.platform !== 'linux') {
    fsWatch(fileLoc, {recursive: true}, notify);
    return;
  }
  // For performance: don't step into node_modules directories
  if (fileLoc.endsWith('node_modules')) {
    return;
  }
  if (statSync(fileLoc).isDirectory()) {
    fsWatch(fileLoc, notify);
  } else {
    readdirSync(fileLoc).forEach((entry) => watch(path.join(fileLoc, entry), notify));
  }
}

const sendFile = (res, file, ext = '.html') => {
  res.writeHead(200, {
    'Content-Type': mime.contentType(ext) || 'application/octet-stream',
    'Access-Control-Allow-Origin': '*',
  });
  res.write(file, getEncodingType(ext));
  res.end();
};

const sendError = (res, status) => {
  res.writeHead(status);
  res.end();
};

const sendMessage = (res, channel, data) => {
  res.write(`event: ${channel}\nid: 0\ndata: ${data}\n`);
  res.write('\n\n');
};

function exitWithInvalidBabelConfiguration() {
  console.log(chalk.bold.red('⚠️  Valid Babel configuration could not be found!'));
  console.log(`To continue, create a "babel.config.json" file and include the Snowpack plugin:

{
  "plugins": [
    ["snowpack/assets/babel-plugin.js"]
  ]
}
`);
  process.exit(1);
}

interface DevOptions {
  cwd: string;
  port: number;
  publicDir: string;
  fallback: string;
  paths: ([string] | [string, string])[];
}

export async function command({port, cwd, publicDir, fallback, paths}: DevOptions) {
  console.log(chalk.bold('Snowpack Dev Server (Beta)'));
  console.log('NOTE: Still experimental, default behavior may change.');
  console.log('Starting up...');

  const liveReloadClients: http.ServerResponse[] = [];

  const messageBus = new EventEmitter();

  const babelUserConfig = babel.loadPartialConfig({cwd}) || {options: {}};
  const hasBabelUserConfig = !!babelUserConfig.options.babelrc || !!babelUserConfig.config;
  const babelConfig = hasBabelUserConfig && babelUserConfig.options;
  const babelFileErrors = new Map<string, Error>();
  const hasTypeScriptConfig = existsSync(path.resolve(cwd, 'tsconfig.json'));

  async function buildBabelFile(fileLoc, fileContents) {
    try {
      messageBus.emit('BABEL_START', {file: fileLoc});
      const result = await babel.transformAsync(fileContents, {
        ...babelConfig,
        filename: fileLoc,
      });
      babelFileErrors.delete(fileLoc);
      messageBus.emit('BABEL_FINISH', {file: fileLoc, result});
      return [null, result];
    } catch (err) {
      babelFileErrors.set(fileLoc, err);
      messageBus.emit('BABEL_ERROR', {file: fileLoc, err});
      return [err];
    }
  }

  // TODO: Support a default Babel config if none is found.
  if (!babelConfig || !babelConfig.plugins) {
    exitWithInvalidBabelConfiguration();
    return;
  }
  const hasSnowpackBabelPlugin = !!babelConfig.plugins.find((p: any) => {
    if (p.file) {
      return p.file.request === 'snowpack/assets/babel-plugin.js';
    }
    if (p.name) {
      return p.name === 'snowpack/assets/babel-plugin.js';
    }
    return false;
  });
  const hasJsxBabelPlugin = !!babelConfig.plugins.find((p: any) => {
    if (p.file) {
      return p.file.request === '@babel/plugin-syntax-jsx';
    }
    if (p.name) {
      return p.name === '@babel/plugin-syntax-jsx';
    }
    return false;
  });
  // if (!hasSnowpackBabelPlugin || !hasJsxBabelPlugin) {
  //   exitWithInvalidBabelConfiguration();
  //   return;
  // }

  if (hasTypeScriptConfig) {
    const {stdout, stderr} = execa(require.resolve('typescript/bin/tsc'), [
      '--watch',
      '--noEmit',
      '--pretty',
    ]);
    stdout?.on('data', (b) => {
      let tscOutput: string = b.toString();
      if (tscOutput.startsWith('\u001bc') || tscOutput.startsWith('\x1Bc')) {
        messageBus.emit('TSC_RESET', {});
      }
      tscOutput = tscOutput
        .replace(/\x1Bc/, '')
        .replace(/\u001bc/, '')
        .trimStart();

      messageBus.emit('TSC_MSG', {msg: tscOutput});

      if (/^\[/gm.test(tscOutput)) {
        if (/Watching for file changes./gm.test(tscOutput)) {
          messageBus.emit('TSC_DONE', {});
        }
        const errorMatch = tscOutput.match(/Found (\d+) errors/);
        if (errorMatch) {
          messageBus.emit('TSC_ERROR', {num: parseInt(errorMatch[1])});
        }
      }
    });
  }

  console.log = (...args) => {
    messageBus.emit('CONSOLE', {level: 'log', args});
  };
  console.warn = (...args) => {
    messageBus.emit('CONSOLE', {level: 'warn', args});
  };
  console.error = (...args) => {
    messageBus.emit('CONSOLE', {level: 'error', args});
  };

  // const snowpackInstallPromise = execa(require.resolve('./index.bin.js'), []);
  // snowpackInstallPromise.stdout!.pipe(process.stdout);
  // snowpackInstallPromise.stderr!.pipe(process.stderr);
  // await snowpackInstallPromise;

  // spin up a web server, serve each file from our cache
  http
    .createServer(async (req, res) => {
      const reqUrl = req.url!;
      let reqPath = url.parse(reqUrl).pathname!;

      // const requestStart = Date.now();
      res.on('finish', () => {
        const {method, url} = req;
        const {statusCode} = res;
        if (statusCode !== 200) {
          messageBus.emit('SERVER_RESPONSE', {
            method,
            url,
            statusCode,
            // processingTime: Date.now() - requestStart,
          });
        }
      });

      if (reqPath === '/livereload') {
        res.writeHead(200, {
          Connection: 'keep-alive',
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Access-Control-Allow-Origin': '*',
        });
        sendMessage(res, 'connected', 'ready');
        setInterval(sendMessage, 60000, res, 'ping', 'waiting');
        liveReloadClients.push(res);
        return;
      }

      const resource = decodeURI(reqPath);
      let requestedFile = path.join(publicDir, resource);
      let requestedFileExt = path.parse(resource).ext.toLowerCase();
      let isSrc = false;
      let isRoute = false;

      for (const [pathStart, pathEnd] of paths) {
        if (reqPath.startsWith(pathStart)) {
          requestedFile = path.join(cwd, resource);
          isSrc = true;
          if (pathEnd) {
            requestedFile = requestedFile.replace(pathStart, pathEnd);
          }
        }
      }
      if (FILE_CACHE.has(requestedFile)) {
        sendFile(res, FILE_CACHE.get(requestedFile), requestedFileExt);
        return;
      }

      let fileLoc = await fs
        .stat(requestedFile)
        .then((stat) => (stat.isFile() ? requestedFile : null))
        .catch(() => null /* ignore */);

      if (!fileLoc && isSrc) {
        fileLoc =
          fileLoc ||
          (await fs
            .stat(requestedFile.replace(/\.js$/, '.ts'))
            .then(() => requestedFile.replace(/\.js$/, '.ts'))
            .catch(() => null /* ignore */)) ||
          (await fs
            .stat(requestedFile.replace(/\.js$/, '.jsx'))
            .then(() => requestedFile.replace(/\.js$/, '.jsx'))
            .catch(() => null /* ignore */)) ||
          (await fs
            .stat(requestedFile.replace(/\.js$/, '.tsx'))
            .then(() => requestedFile.replace(/\.js$/, '.tsx'))
            .catch(() => null /* ignore */));
      }
      if (!fileLoc && !requestedFileExt) {
        fileLoc =
          (await fs
            .stat(requestedFile + '.html')
            .then(() => requestedFile + '.html')
            .catch(() => null /* ignore */)) ||
          (await fs
            .stat(requestedFile + '/index.html')
            .then(() => requestedFile + '/index.html')
            .catch(() => null /* ignore */)) ||
          (await fs
            .stat(requestedFile + 'index.html')
            .then(() => requestedFile + 'index.html')
            .catch(() => null /* ignore */)) ||
          (await fs
            .stat(path.join(publicDir, fallback))
            .then((stat) => (stat.isFile() ? path.join(publicDir, fallback) : null))
            .catch(() => null /* ignore */));
        if (fileLoc) {
          requestedFileExt = '.html';
          isRoute = true;
        }
      }
      if (!fileLoc) {
        return sendError(res, 404);
      }

      try {
        var fileContents = await fs.readFile(fileLoc, getEncodingType(requestedFileExt));
      } catch (err) {
        return sendError(res, 500);
      }

      if (!fileContents) {
        return sendError(res, 404);
      }

      if (isRoute) {
        fileContents = fileContents + LIVE_RELOAD_SNIPPET;
        messageBus.emit('NEW_SESSION');
      }

      let responseContents = fileContents;
      if (requestedFileExt === '.js' && !fileLoc.includes('/web_modules/')) {
        const [babelErr, babelResult] = await buildBabelFile(fileLoc, fileContents);
        if (babelErr || !babelResult.code) {
          return sendError(res, 500);
        }
        responseContents = babelResult.code;
      }

      FILE_CACHE.set(fileLoc, responseContents);
      sendFile(res, responseContents, requestedFileExt);
    })
    .listen(port);

  async function onWatchEvent(event, fileLoc) {
    let requestId = fileLoc;
    if (requestId.startsWith(cwd)) {
      requestId = requestId.replace(/\.(js|ts|jsx|tsx)$/, '.js');
    }
    FILE_CACHE.delete(requestId);
    while (liveReloadClients.length > 0) {
      sendMessage(liveReloadClients.pop(), 'message', 'reload');
    }
    if (babelFileErrors.has(fileLoc)) {
      const fileContents = await fs.readFile(fileLoc, 'utf-8').catch((err) => null /* ignore */);
      if (!fileContents) {
        babelFileErrors.delete(fileLoc);
      } else {
        buildBabelFile(fileLoc, fileContents);
      }
    }
  }

  if (!cwd.startsWith(publicDir)) {
    watch(cwd, onWatchEvent);
  }
  if (!publicDir.startsWith(cwd)) {
    watch(publicDir, onWatchEvent);
  }

  process.on('SIGINT', () => {
    for (const client of liveReloadClients) {
      client.end();
    }
    process.exit();
  });

  paint(messageBus);
  return new Promise(() => {});
}
