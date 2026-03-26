import fs from 'fs';
import path from 'path';

/**
 * Copy a directory recursively. Tries fs.cpSync first (fast native path),
 * falls back to per-file readFileSync/writeFileSync for Electron asar
 * compatibility (asar's cpSync override only handles files, not directories).
 */
export function copyDirRecursive(src: string, dst: string): void {
  try {
    fs.cpSync(src, dst, { recursive: true });
  } catch {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      const srcPath = path.join(src, entry);
      const dstPath = path.join(dst, entry);
      if (fs.statSync(srcPath).isDirectory()) {
        copyDirRecursive(srcPath, dstPath);
      } else {
        fs.writeFileSync(dstPath, fs.readFileSync(srcPath));
      }
    }
  }
}
