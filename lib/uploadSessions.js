'use strict';

const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const fm = require('hexo-front-matter');
const { slugize } = require('hexo-util');
const { DEFAULT_TAG } = require('./tagStore');

const projectRoot = path.resolve(__dirname, '../..');
const postsRoot = path.join(projectRoot, 'posts');
const sessionsRoot = path.join(projectRoot, 'uploads', 'sessions');

const ensureDir = async dir => {
  await fsp.mkdir(dir, { recursive: true });
};

const randomId = () => crypto.randomBytes(8).toString('hex');

const archiveIdFromUrl = url => crypto.createHash('md5').update(url).digest('hex').slice(0, 10);

const baseName = filename => filename.replace(/\.[^.]+$/, '');

const normalizeDate = value => {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return new Date();
  return date;
};

const formatDate = date => date.toISOString();

const folderFromDateSlug = (dateISO, slug) => `${dateISO.slice(0, 10)}-${slug}`;
const permalinkFromDateSlug = (dateISO, slug) => {
  const y = dateISO.slice(0, 4);
  const m = dateISO.slice(5, 7);
  const d = dateISO.slice(8, 10);
  return `/${y}/${m}/${d}/${slug}/`;
};

const readJSON = async file => JSON.parse(await fsp.readFile(file, 'utf8'));

const writeJSON = async (file, data) => {
  await ensureDir(path.dirname(file));
  await fsp.writeFile(file, JSON.stringify(data, null, 2));
};

const buildExistingCache = async () => {
  const cache = {};
  try {
    const folders = await fsp.readdir(postsRoot);
    folders.forEach(folder => {
      const parts = folder.split('-');
      if (parts.length < 2) return;
      const slug = parts.slice(3).join('-') || parts.slice(2).join('-') || parts.slice(1).join('-') || folder;
      cache[slug] = folder;
    });
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return cache;
};

const findExistingFolder = (cache, slug) => cache[slug] || null;

const slugFromTitle = title => slugize(title || '', { transform: 1 }) || slugize(randomId(), { transform: 1 });

const parseMarkdown = (raw, filename) => {
  const data = fm.parse(raw);
  const meta = { ...data };
  const body = data._content || '';
  delete meta._content;
  if (!meta.title) meta.title = baseName(filename);
  const date = normalizeDate(meta.date);
  meta.date = formatDate(date);
  if (!meta.slug) meta.slug = slugFromTitle(meta.title);
  return { meta, body };
};

const extractWikiLinks = body => {
  const regex = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
  const results = [];
  let match;
  while ((match = regex.exec(body))) {
    const targetTitle = match[1].trim();
    const alias = (match[2] || match[1]).trim();
    const targetSlug = slugFromTitle(targetTitle);
    results.push({ targetTitle, alias, targetSlug });
  }
  return results;
};

const extractExternalLinks = body => {
  const regex = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  const results = [];
  let match;
  while ((match = regex.exec(body))) {
    results.push({ text: match[1], url: match[2] });
  }
  return results;
};

const sessionPath = id => path.join(sessionsRoot, id);

const sessionFile = id => path.join(sessionPath(id), 'session.json');

const defaultSession = id => ({
  id,
  createdAt: new Date().toISOString(),
  notes: {},
  archives: {},
  pendingNotes: {},
  mainSlug: null
});

const loadSession = async id => {
  const file = sessionFile(id);
  try {
    return await readJSON(file);
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error('Session not found');
    throw err;
  }
};

const saveSession = async session => {
  await writeJSON(sessionFile(session.id), session);
};

const createSession = async () => {
  const id = randomId();
  await ensureDir(sessionPath(id));
  await saveSession(defaultSession(id));
  return { sessionId: id };
};

const notePath = (sessionId, slug) => path.join(sessionPath(sessionId), 'notes', `${slug}.md`);

const archivePath = (sessionId, archiveId, filename) => path.join(sessionPath(sessionId), 'archives', `${archiveId}-${filename}`);

const ensureNoteDependency = (session, existingCache, sourceSlug, depInfo) => {
  if (session.notes[depInfo.targetSlug]) return;
  if (findExistingFolder(existingCache, depInfo.targetSlug)) return;
  session.pendingNotes[depInfo.targetSlug] = session.pendingNotes[depInfo.targetSlug] || { targetTitle: depInfo.targetTitle, referencedBy: [] };
  if (!session.pendingNotes[depInfo.targetSlug].referencedBy.includes(sourceSlug)) {
    session.pendingNotes[depInfo.targetSlug].referencedBy.push(sourceSlug);
  }
};

const updateNoteDependencies = (session, note, wikiLinks, externalLinks, existingCache) => {
  note.dependencies = note.dependencies || { notes: {}, archives: {} };

  for (const dep of wikiLinks) {
    note.dependencies.notes[dep.targetSlug] = {
      alias: dep.alias,
      targetTitle: dep.targetTitle
    };
    ensureNoteDependency(session, existingCache, note.slug, dep);
  }

  for (const link of externalLinks) {
    const archiveId = archiveIdFromUrl(link.url);
    session.archives[archiveId] = session.archives[archiveId] || {
      id: archiveId,
      url: link.url,
      resolved: false,
      filename: null,
      filePath: null,
      referencedBy: []
    };
    if (!session.archives[archiveId].referencedBy.includes(note.slug)) {
      session.archives[archiveId].referencedBy.push(note.slug);
    }
    note.dependencies.archives[archiveId] = link.text;
  }
};

const addNote = async ({ sessionId, filename, content, isMain }) => {
  if (!filename || !content) throw new Error('Filename and content required');
  const session = await loadSession(sessionId);
  const existingCache = await buildExistingCache();
  const { meta, body } = parseMarkdown(content, filename);
  const slug = meta.slug;
  const fileTarget = notePath(sessionId, slug);
  await ensureDir(path.dirname(fileTarget));
  await fsp.writeFile(fileTarget, content);

  const wikiLinks = extractWikiLinks(body);
  const externalLinks = extractExternalLinks(body);

  meta.tags = normalizeTags(meta.tags);

  session.notes[slug] = {
    slug,
    title: meta.title,
    date: meta.date,
    meta,
    body,
    file: fileTarget,
    isMain: Boolean(isMain),
    dependencies: { notes: {}, archives: {} }
  };

  if (isMain) session.mainSlug = slug;

  delete session.pendingNotes[slug];
  await updateNoteDependencies(session, session.notes[slug], wikiLinks, externalLinks, existingCache);

  await saveSession(session);
  return await summarizeSession(session);
};

const addArchive = async ({ sessionId, sourceUrl, filename, data }) => {
  if (!sourceUrl || !filename || !data) throw new Error('Archive upload requires url, filename and data');
  const session = await loadSession(sessionId);
  const archiveId = archiveIdFromUrl(sourceUrl);
  if (!session.archives[archiveId]) {
    throw new Error('Archive was not requested');
  }
  const buffer = Buffer.from(data.replace(/^data:[^,]+,/, ''), 'base64');
  const fileTarget = archivePath(sessionId, archiveId, filename);
  await ensureDir(path.dirname(fileTarget));
  await fsp.writeFile(fileTarget, buffer);
  session.archives[archiveId].resolved = true;
  session.archives[archiveId].filename = filename;
  session.archives[archiveId].filePath = fileTarget;
  await saveSession(session);
  return await summarizeSession(session);
};

const summarizeSession = async session => {
  const existingCache = await buildExistingCache();
  const pendingNotes = Object.entries(session.pendingNotes).map(([slug, info]) => ({ slug, ...info }));
  const pendingArchives = Object.values(session.archives).filter(archive => !archive.resolved).map(({ id, url, referencedBy }) => ({ id, url, referencedBy }));
  const noteSummaries = Object.values(session.notes).map(note => ({
    slug: note.slug,
    title: note.title,
    isMain: note.isMain,
    missingNotes: Object.keys(note.dependencies.notes).filter(dep => !session.notes[dep] && !findExistingFolder(existingCache, dep)).map(dep => ({ slug: dep, alias: note.dependencies.notes[dep].alias })),
    missingArchives: Object.keys(note.dependencies.archives).filter(id => !session.archives[id] || !session.archives[id].resolved).map(id => ({ id, text: note.dependencies.archives[id] }))
  }));
  const ready = pendingNotes.length === 0 && pendingArchives.length === 0;
  return {
    sessionId: session.id,
    mainSlug: session.mainSlug,
    notes: noteSummaries,
    pendingNotes,
    pendingArchives,
    ready
  };
};

const getSession = async id => await summarizeSession(await loadSession(id));

const assertReady = session => {
  if (Object.keys(session.pendingNotes).length > 0) {
    throw new Error('Cannot commit: missing linked notes');
  }
  const unresolved = Object.values(session.archives).filter(a => !a.resolved);
  if (unresolved.length) throw new Error('Cannot commit: missing archive uploads');
  if (!session.mainSlug) throw new Error('No main note uploaded');
};

const convertWikiLinks = (body, session, currentSlug, folderMap, existingCache) => body.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (match, target, alias) => {
  const targetSlug = slugFromTitle(target.trim());
  const display = (alias || target).trim();
  const url = resolveNoteUrl(session, targetSlug, folderMap, existingCache);
  return url ? `[${display}](${url})` : display;
});

const convertExternalLinks = (body, note, archiveMap) => body.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (match, text, url) => {
  const archiveId = archiveIdFromUrl(url);
  const newUrl = archiveMap[archiveId];
  if (!newUrl) return match;
  return `[${text}](${newUrl})`;
});

const permalinkFromFolder = folder => {
  const date = folder.slice(0, 10);
  const slug = folder.slice(11);
  if (!date || !slug) return `/posts/${folder}/`;
  const y = date.slice(0, 4);
  const m = date.slice(5, 7);
  const d = date.slice(8, 10);
  return `/${y}/${m}/${d}/${slug}/`;
};

const resolveNoteUrl = (session, targetSlug, folderMap, existingCache) => {
  if (session.notes[targetSlug]) {
    return permalinkFromDateSlug(session.notes[targetSlug].date, targetSlug);
  }
  const existing = findExistingFolder(existingCache, targetSlug);
  if (existing) return permalinkFromFolder(existing);
  return null;
};

const commitSession = async sessionId => {
  const session = await loadSession(sessionId);
  assertReady(session);
  await ensureDir(postsRoot);

  const existingCache = await buildExistingCache();
  const folderMap = {};
  for (const note of Object.values(session.notes)) {
    const folder = folderFromDateSlug(note.date, note.slug);
    folderMap[note.slug] = folder;
  }

  for (const [slug, note] of Object.entries(session.notes)) {
    const folder = folderMap[slug];
    const destDir = path.join(postsRoot, folder);
    await ensureDir(destDir);

    const archiveLinks = {};
    for (const archiveId of Object.keys(note.dependencies.archives)) {
      const archive = session.archives[archiveId];
      const archivesDir = path.join(destDir, 'archives');
      await ensureDir(archivesDir);
      const safeName = archive.filename || `${archiveId}.html`;
      const destFile = path.join(archivesDir, `${archiveId}-${safeName}`);
      await fsp.copyFile(archive.filePath, destFile);
      archiveLinks[archiveId] = encodeURI(`/posts/${folder}/archives/${path.basename(destFile)}`);
    }

    let body = note.body;
    body = convertWikiLinks(body, session, slug, folderMap, existingCache);
    body = convertExternalLinks(body, note, archiveLinks);

    const meta = { ...note.meta, slug: note.slug, date: note.date };
    meta.tags = normalizeTags(meta.tags);
    const content = body.endsWith('\n') ? body : `${body}\n`;
    const output = fm.stringify({ ...meta, _content: content });
    await fsp.writeFile(path.join(destDir, 'index.md'), output);
  }

  await fsp.rm(sessionPath(sessionId), { recursive: true, force: true });
  return { success: true, folders: Object.values(folderMap) };
};

module.exports = {
  createSession,
  addNote,
  addArchive,
  getSession,
  commitSession
};
