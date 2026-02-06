import crypto from "node:crypto";

export const SERVER_VERSION = "2026-01-11";

export const nowIso = () => new Date().toISOString();

export const stableStringify = (value) => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
};

export const hashPayload = (value) => {
  const serialized = stableStringify(value);
  return crypto.createHash("sha256").update(serialized).digest("hex");
};

export const parseJson = (value) => {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    return value;
  }
  if (!value.length) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch (error) {
    return null;
  }
};

export const serializeJson = (value) => {
  if (value === undefined) {
    return null;
  }
  return value === null ? null : JSON.stringify(value);
};

export const normalizeUrl = (value) => {
  if (!value) {
    return "";
  }
  return value.replace(/\/+$/, "");
};

export const createSeededRandom = (seed) => {
  let hash = 2166136261;
  const value = String(seed ?? "");
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return () => {
    hash += 0x6d2b79f5;
    let t = Math.imul(hash ^ (hash >>> 15), 1 | hash);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
