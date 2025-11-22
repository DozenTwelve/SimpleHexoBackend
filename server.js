#!/usr/bin/env node
'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { spawn } = require('child_process');
const fm = require('hexo-front-matter');
const yaml = require('js-yaml');
const { slugize } = require('hexo-util');
const uploadSessions = require('./lib/uploadSessions');
const tagStore = require('./lib/tagStore');
const { DEFAULT_TAG } = tagStore;

const PORT = process.env.BLOG_API_PORT ? Number(process.env.BLOG_API_PORT) : 4001;
const AUTH_TOKEN = process.env.BLOG_API_TOKEN || 'change-me';
const ROOT = path.resolve(__dirname, '..');
const POSTS_DIR = path.join(ROOT, 'posts');

const respond = (res, status, payload) => {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(body);
};

const notFound = (res) => respond(res, 404, { error: 'Not found' });

const toSlug = (value) => {
  const base = slugize(value || '', { transform: 1 }) || '';
  const ascii = base.replace(/[^a-z0-9-]/g, '');
  return ascii || `post-${Date.now()}`;
};

const formatDate = (value) => {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return new Date().toISOString();
  return date.toISOString();
};

const folderFromMeta = (meta) => {
  const dateOnly = (meta.date || '').slice(0, 10);
  return `${dateOnly}-${meta.slug}`;
};

const ensureDir = async (dir) => {
  await fsp.mkdir(dir, { recursive: true });
};

const readJsonBody = (req, limit = 5 * 1024 * 1024) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  req.on('data', chunk => {
    size += chunk.length;
    if (size > limit) {
      reject(Object.assign(new Error('Payload too large'), { status: 413 }));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    try {
      const raw = Buffer.concat(chunks).toString();
      const data = raw ? JSON.parse(raw) : {};
      resolve(data);
    } catch (err) {
      reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
    }
  });
  req.on('error', reject);
});

const normalizeTags = (tags) => {
  if (!tags) return [DEFAULT_TAG];
  const list = Array.isArray(tags) ? tags : [tags];
  const cleaned = Array.from(new Set(list.map(tag => tag && tag.toString().trim()).filter(Boolean)));
  return cleaned.length ? cleaned : [DEFAULT_TAG];
};

const GALLERY_START = '<div class="upload-gallery" style="display: flex; flex-wrap: wrap; gap: 10px; justify-content: center;">';
const GALLERY_END = '</div>';
const buildGalleryAnchor = (imgPath) => `    <a href="${imgPath}"><img src="${imgPath}" width="440" height="300" style="object-fit: cover;"></a>`;

const appendImageToContent = (content, imgPath) => {
  if (!imgPath) return content;
  if (content.includes(imgPath)) return content;

  const start = content.indexOf(GALLERY_START);
  const end = start !== -1 ? content.indexOf(GALLERY_END, start + GALLERY_START.length) : -1;
  const anchor = buildGalleryAnchor(imgPath);

  if (start !== -1 && end !== -1) {
    const before = content.slice(0, end);
    const after = content.slice(end);
    const newline = before.endsWith('\n') ? '' : '\n';
    return `${before}${newline}${anchor}\n${after}`;
  }

  const trimmed = content.trimEnd();
  const prefix = trimmed ? `${trimmed}\n\n` : '';
  return `${prefix}${GALLERY_START}\n${anchor}\n${GALLERY_END}\n`;
};

const isSafeFolder = (folder) => {
  if (!folder) return false;
  if (folder.includes('..') || folder.includes('/') || folder.includes('\\')) return false;
  return true;
};

const writePostFile = async (folderName, meta, content) => {
  const dir = path.join(POSTS_DIR, folderName);
  await ensureDir(dir);
  const body = content.endsWith('\n') ? content : `${content}\n`;
  const finalMeta = { ...meta, tags: normalizeTags(meta.tags) };
  const yamlStr = yaml.dump(finalMeta, { lineWidth: Infinity });
  const fileContent = `---\n${yamlStr}---\n${body}`;
  await fsp.writeFile(path.join(dir, 'index.md'), fileContent);
  return { dir, fileContent };
};

const getFolders = async () => {
  await ensureDir(POSTS_DIR);
  const entries = await fsp.readdir(POSTS_DIR, { withFileTypes: true });
  return entries.filter(entry => entry.isDirectory()).map(entry => entry.name);
};

const loadPost = async (folder) => {
  const dir = path.join(POSTS_DIR, folder);
  const indexPath = path.join(dir, 'index.md');
  const raw = await fsp.readFile(indexPath, 'utf8');
  const data = fm.parse(raw);
  const content = data._content || '';
  delete data._content;
  const folderDate = folder.slice(0, 10);
  const folderSlug = folder.slice(11) || folder;
  if (!data.slug) data.slug = folderSlug;
  if (!data.date) data.date = `${folderDate}T00:00:00.000Z`;
  if (!data.title) data.title = folderSlug;
  if (!Array.isArray(data.tags)) {
    data.tags = normalizeTags(data.tags);
  } else if (!data.tags.length) {
    data.tags = normalizeTags([]);
  }
  return { meta: data, content, dir, indexPath };
};

const listPosts = async () => {
  const folders = await getFolders();
  const results = [];
  for (const folder of folders) {
    try {
      const { meta } = await loadPost(folder);
      results.push({
        folder,
        title: meta.title,
        slug: meta.slug,
        date: meta.date,
        cover: meta.cover || null
      });
    } catch {
      continue;
    }
  }
  return results.sort((a, b) => new Date(b.date) - new Date(a.date));
};

const parsePath = (reqUrl) => {
  const url = new URL(reqUrl, 'http://localhost');
  return { pathname: url.pathname, searchParams: url.searchParams };
};

const authorize = (req) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : header;
  return token === AUTH_TOKEN;
};

const replaceFolderInText = (text, currentFolder, nextFolder) => {
  if (!text) return text;
  const needle = `/posts/${currentFolder}/`;
  const replacement = `/posts/${nextFolder}/`;
  return text.split(needle).join(replacement);
};

const handleCreatePost = async (req, res) => {
  const body = await readJsonBody(req);
  if (!body.title || !body.content) {
    return respond(res, 400, { error: 'title and content are required' });
  }
  const slug = toSlug(body.slug || body.title);
  const isoDate = formatDate(body.date);
  const meta = Object.assign({}, body.meta || {}, {
    title: body.title,
    slug,
    date: isoDate
  });
  meta.tags = normalizeTags(meta.tags || DEFAULT_TAG);
  const folderBase = folderFromMeta(meta);
  await ensureDir(POSTS_DIR);
  let folderName = folderBase;
  let suffix = 1;
  while (fs.existsSync(path.join(POSTS_DIR, folderName))) {
    folderName = `${folderBase}-${suffix++}`;
  }
  await writePostFile(folderName, meta, body.content);
  respond(res, 201, { folder: folderName, meta });
};

const handleUploadImage = async (req, res, folder) => {
  const { filename, data } = await readJsonBody(req, 15 * 1024 * 1024);
  if (!filename || !data) {
    return respond(res, 400, { error: 'filename and data (base64) are required' });
  }
  const buffer = Buffer.from(data.replace(/^data:.+;base64,/, ''), 'base64');
  const targetDir = path.join(POSTS_DIR, folder);
  await ensureDir(targetDir);
  const indexPath = path.join(targetDir, 'index.md');
  if (!fs.existsSync(indexPath)) {
    return respond(res, 404, { error: 'Post not found' });
  }
  const destPath = path.join(targetDir, filename);
  await fsp.writeFile(destPath, buffer);
  const imagePath = `/posts/${folder}/${encodeURIComponent(filename)}`;

  const { meta, content } = await loadPost(folder);
  const nextContent = appendImageToContent(content, imagePath);
  await writePostFile(folder, meta, nextContent);

  respond(res, 200, { path: imagePath, content: nextContent });
};

const handleRenameIfNeeded = async (currentFolder, meta, content, updates = {}) => {
  const desiredSlug = updates.slug ? toSlug(updates.slug) : meta.slug;
  const desiredDate = updates.date ? formatDate(updates.date) : meta.date;
  let nextMeta = Object.assign({}, meta, updates, { slug: desiredSlug, date: desiredDate });
  nextMeta.tags = normalizeTags(nextMeta.tags || meta.tags);
  let nextFolder = folderFromMeta(nextMeta);

  if (nextFolder === currentFolder) {
    return { folder: currentFolder, meta: nextMeta, content };
  }

  let candidate = nextFolder;
  let suffix = 1;
  while (fs.existsSync(path.join(POSTS_DIR, candidate))) {
    candidate = `${nextFolder}-${suffix++}`;
  }
  const currentPath = path.join(POSTS_DIR, currentFolder);
  const newPath = path.join(POSTS_DIR, candidate);
  await fsp.rename(currentPath, newPath);

  const updatedContent = replaceFolderInText(content, currentFolder, candidate);
  nextMeta = Object.assign({}, nextMeta);
  if (nextMeta.cover) nextMeta.cover = replaceFolderInText(nextMeta.cover, currentFolder, candidate);
  if (nextMeta.top_img) nextMeta.top_img = replaceFolderInText(nextMeta.top_img, currentFolder, candidate);

  return { folder: candidate, meta: nextMeta, content: updatedContent };
};

const handleUpdatePost = async (req, res, folder) => {
  const body = await readJsonBody(req, 8 * 1024 * 1024);
  const { meta, content } = await loadPost(folder);
  const updates = Object.assign({}, body.meta || {});
  if (body.title) updates.title = body.title;
  if (body.slug) updates.slug = body.slug;
  if (body.date) updates.date = body.date;
  let nextContent = body.content !== undefined ? body.content : content;

  const { folder: finalFolder, meta: finalMeta, content: renamedContent } = await handleRenameIfNeeded(folder, meta, nextContent, updates);
  nextContent = renamedContent;

  await writePostFile(finalFolder, finalMeta, nextContent);
  respond(res, 200, { folder: finalFolder, meta: finalMeta });
};

const handleBuild = async (res) => {
  const child = spawn('npm', ['run', 'build'], { cwd: ROOT, shell: true });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });
  child.on('close', code => {
    respond(res, code === 0 ? 200 : 500, { success: code === 0, log: output });
  });
};

const handleCreateUploadSession = async (res) => {
  const session = await uploadSessions.createSession();
  respond(res, 201, session);
};

const handleUploadNote = async (req, res) => {
  const body = await readJsonBody(req, 8 * 1024 * 1024);
  const status = await uploadSessions.addNote(body);
  respond(res, 200, status);
};

const handleUploadArchive = async (req, res) => {
  const body = await readJsonBody(req, 12 * 1024 * 1024);
  const status = await uploadSessions.addArchive(body);
  respond(res, 200, status);
};

const handleGetUploadSession = async (res, sessionId) => {
  const status = await uploadSessions.getSession(sessionId);
  respond(res, 200, status);
};

const handleCommitUploadSession = async (req, res) => {
  const body = await readJsonBody(req);
  const result = await uploadSessions.commitSession(body.sessionId);
  respond(res, 200, result);
};

const handleDeletePost = async (res, folder) => {
  const dir = path.join(POSTS_DIR, folder);
  if (!fs.existsSync(dir)) {
    return respond(res, 404, { error: 'Post not found' });
  }
  await fsp.rm(dir, { recursive: true, force: true });
  respond(res, 200, { deleted: folder });
};

const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
      });
      return res.end();
    }

  if (!authorize(req)) {
    return respond(res, 401, { error: 'Unauthorized' });
  }

  try {
    const { pathname } = parsePath(req.url);
    if (pathname.startsWith('/api/posts/')) {
      const segments = pathname.split('/').filter(Boolean);
      const folder = segments[2] ? decodeURIComponent(segments[2]) : '';
      if (segments.length >= 3 && !isSafeFolder(folder)) {
        return respond(res, 400, { error: 'Invalid folder' });
      }
    }

    if (req.method === 'POST' && pathname === '/api/upload/session') {
      return await handleCreateUploadSession(res);
    }

    if (req.method === 'POST' && pathname === '/api/upload/note') {
      return await handleUploadNote(req, res);
    }

    if (req.method === 'POST' && pathname === '/api/upload/archive') {
      return await handleUploadArchive(req, res);
    }

    if (req.method === 'POST' && pathname === '/api/upload/commit') {
      return await handleCommitUploadSession(req, res);
    }

    if (req.method === 'GET' && pathname.startsWith('/api/upload/session/')) {
      const id = pathname.split('/').pop();
      return await handleGetUploadSession(res, id);
    }

    if (req.method === 'GET' && pathname === '/api/tags') {
      const tags = await tagStore.getTags();
      return respond(res, 200, { tags });
    }

    if (req.method === 'POST' && pathname === '/api/tags') {
      const body = await readJsonBody(req);
      const tags = await tagStore.addTag(body.name);
      return respond(res, 201, { tags });
    }

    if (req.method === 'GET' && pathname === '/api/posts') {
      const posts = await listPosts();
      return respond(res, 200, { posts });
    }

    if (req.method === 'POST' && pathname === '/api/posts') {
      return await handleCreatePost(req, res);
    }

    if (pathname.startsWith('/api/posts/')) {
      const segments = pathname.split('/').filter(Boolean);
      if (segments.length < 3) return notFound(res);
      const folder = decodeURIComponent(segments[2]);
      const sub = segments[3] ? decodeURIComponent(segments[3]) : undefined;

      if (sub === 'images' && req.method === 'POST') {
        return await handleUploadImage(req, res, folder);
      }

      if (req.method === 'GET') {
        const { meta, content } = await loadPost(folder);
        return respond(res, 200, { folder, meta, content });
      }

      if (req.method === 'PUT') {
        return await handleUpdatePost(req, res, folder);
      }

      if (!sub && req.method === 'DELETE') {
        return await handleDeletePost(res, folder);
      }
    }

    if (req.method === 'POST' && pathname === '/api/build') {
      return handleBuild(res);
    }

    notFound(res);
  } catch (err) {
    console.error(err);
    const status = err.status && Number.isInteger(err.status) ? err.status : 500;
    respond(res, status, { error: status === 500 ? 'Internal error' : err.message, detail: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Blog backend listening on http://localhost:${PORT}`);
});
