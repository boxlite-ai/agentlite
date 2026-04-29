import fs from 'fs';
import path from 'path';

export const PRIMARY_INSTRUCTION_FILE = 'CLAUDE.md';
export const COMPAT_INSTRUCTION_FILE = 'AGENTS.md';
export const INSTRUCTION_FILES = [
  PRIMARY_INSTRUCTION_FILE,
  COMPAT_INSTRUCTION_FILE,
] as const;

function pathExists(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function compatSymlinkPointsToPrimary(dir: string): boolean {
  const compatPath = path.join(dir, COMPAT_INSTRUCTION_FILE);
  try {
    const stat = fs.lstatSync(compatPath);
    if (!stat.isSymbolicLink()) return false;
    const target = fs.readlinkSync(compatPath);
    return (
      path.resolve(dir, target) === path.join(dir, PRIMARY_INSTRUCTION_FILE)
    );
  } catch {
    return false;
  }
}

function replaceCompatSymlink(dir: string): void {
  const compatPath = path.join(dir, COMPAT_INSTRUCTION_FILE);
  if (compatSymlinkPointsToPrimary(dir)) return;
  if (pathExists(compatPath)) {
    fs.rmSync(compatPath, { recursive: true, force: true });
  }
  fs.symlinkSync(PRIMARY_INSTRUCTION_FILE, compatPath);
}

export function ensureInstructionAliases(dir: string): void {
  const primaryPath = path.join(dir, PRIMARY_INSTRUCTION_FILE);
  const compatPath = path.join(dir, COMPAT_INSTRUCTION_FILE);

  if (!pathExists(primaryPath)) {
    if (!pathExists(compatPath)) return;
    try {
      fs.writeFileSync(primaryPath, fs.readFileSync(compatPath, 'utf-8'));
    } catch {
      return;
    }
  }

  replaceCompatSymlink(dir);
}

export function writeInstructionFiles(dir: string, content: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, PRIMARY_INSTRUCTION_FILE), content);
  replaceCompatSymlink(dir);
}
