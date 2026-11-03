import { mkdirSync, createReadStream, writeFileSync, existsSync, statSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Attachment storage behind a tiny interface: local disk today, S3-compatible later. */
export interface FileStore { put(bytes: Buffer): string; stream(key: string): NodeJS.ReadableStream; has(key: string): boolean; read(key: string): Buffer; putAt(key: string, bytes: Buffer): void }

export class LocalDiskStore implements FileStore {
  dir: string;
  constructor(dir: string) { this.dir = resolve(dir); mkdirSync(this.dir, { recursive: true }); }
  private path(key: string) {
    const p = resolve(join(this.dir, key));
    if (!p.startsWith(this.dir + sep) || /[\\/]/.test(key)) throw new Error('Invalid file key');  // no path traversal
    return p;
  }
  put(bytes: Buffer) { const key = randomUUID(); writeFileSync(this.path(key), bytes); return key; }
  putAt(key: string, bytes: Buffer) { writeFileSync(this.path(key), bytes); }
  stream(key: string) { return createReadStream(this.path(key)); }
  has(key: string) { try { return existsSync(this.path(key)) && statSync(this.path(key)).isFile(); } catch { return false; } }
  read(key: string) { return readFileSync(this.path(key)); }
}
