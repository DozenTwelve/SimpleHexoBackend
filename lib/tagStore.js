'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const storePath = path.join(__dirname, '..', '..', 'tags.json');
const DEFAULT_TAG = 'uncategorised';

const ensureFile = async () => {
  try {
    await fsp.access(storePath);
  } catch (err) {
    if (err.code === 'ENOENT') {
      await fsp.writeFile(storePath, JSON.stringify({ tags: [DEFAULT_TAG] }, null, 2));
    } else {
      throw err;
    }
  }
};

const readStore = async () => {
  await ensureFile();
  const raw = await fsp.readFile(storePath, 'utf8');
  const json = JSON.parse(raw || '{}');
  const list = Array.isArray(json.tags) ? json.tags : [];
  if (!list.includes(DEFAULT_TAG)) list.unshift(DEFAULT_TAG);
  return Array.from(new Set(list.map(t => t.trim()).filter(Boolean)));
};

const writeStore = async (tags) => {
  await fsp.writeFile(storePath, JSON.stringify({ tags }, null, 2));
};

const getTags = async () => {
  return await readStore();
};

const addTag = async (name) => {
  const tag = (name || '').trim();
  if (!tag) throw new Error('Tag name required');
  const tags = await readStore();
  if (!tags.includes(tag)) {
    tags.push(tag);
    await writeStore(tags);
  }
  return tags;
};

module.exports = {
  DEFAULT_TAG,
  getTags,
  addTag
};
