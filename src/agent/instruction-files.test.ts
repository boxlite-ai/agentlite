import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  COMPAT_INSTRUCTION_FILE,
  ensureInstructionAliases,
  PRIMARY_INSTRUCTION_FILE,
  writeInstructionFiles,
} from './instruction-files.js';

let tmpDir: string;

function expectCompatSymlink(dir: string): void {
  const compatPath = path.join(dir, COMPAT_INSTRUCTION_FILE);
  expect(fs.lstatSync(compatPath).isSymbolicLink()).toBe(true);
  expect(fs.readlinkSync(compatPath)).toBe(PRIMARY_INSTRUCTION_FILE);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlite-instructions-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('writeInstructionFiles', () => {
  it('creates the destination directory', () => {
    const nested = path.join(tmpDir, 'nested', 'agent');

    writeInstructionFiles(nested, 'Nested instructions');

    expect(fs.readFileSync(path.join(nested, 'CLAUDE.md'), 'utf-8')).toBe(
      'Nested instructions',
    );
    expectCompatSymlink(nested);
  });

  it('writes the primary instruction file and compat symlink', () => {
    writeInstructionFiles(tmpDir, 'Follow the instructions.');

    expect(
      fs.readFileSync(path.join(tmpDir, PRIMARY_INSTRUCTION_FILE), 'utf-8'),
    ).toBe('Follow the instructions.');
    expect(
      fs.readFileSync(path.join(tmpDir, COMPAT_INSTRUCTION_FILE), 'utf-8'),
    ).toBe('Follow the instructions.');
    expectCompatSymlink(tmpDir);
  });

  it('replaces an existing compat file when instructions change', () => {
    fs.writeFileSync(
      path.join(tmpDir, COMPAT_INSTRUCTION_FILE),
      'Old instructions',
    );

    writeInstructionFiles(tmpDir, 'New instructions');

    expect(
      fs.readFileSync(path.join(tmpDir, PRIMARY_INSTRUCTION_FILE), 'utf-8'),
    ).toBe('New instructions');
    expect(
      fs.readFileSync(path.join(tmpDir, COMPAT_INSTRUCTION_FILE), 'utf-8'),
    ).toBe('New instructions');
    expectCompatSymlink(tmpDir);
  });
});

describe('ensureInstructionAliases', () => {
  it('backfills the primary instruction file from compat memory', () => {
    fs.writeFileSync(path.join(tmpDir, COMPAT_INSTRUCTION_FILE), 'Compat');

    ensureInstructionAliases(tmpDir);

    expect(
      fs.readFileSync(path.join(tmpDir, PRIMARY_INSTRUCTION_FILE), 'utf-8'),
    ).toBe('Compat');
    expectCompatSymlink(tmpDir);
  });

  it('backfills the compat instruction symlink from primary memory', () => {
    fs.writeFileSync(path.join(tmpDir, PRIMARY_INSTRUCTION_FILE), 'Primary');

    ensureInstructionAliases(tmpDir);

    expect(
      fs.readFileSync(path.join(tmpDir, COMPAT_INSTRUCTION_FILE), 'utf-8'),
    ).toBe('Primary');
    expectCompatSymlink(tmpDir);
  });

  it('replaces an existing compat file with a symlink to primary', () => {
    fs.writeFileSync(path.join(tmpDir, PRIMARY_INSTRUCTION_FILE), 'Primary');
    fs.writeFileSync(path.join(tmpDir, COMPAT_INSTRUCTION_FILE), 'Compat');

    ensureInstructionAliases(tmpDir);

    expect(
      fs.readFileSync(path.join(tmpDir, PRIMARY_INSTRUCTION_FILE), 'utf-8'),
    ).toBe('Primary');
    expect(
      fs.readFileSync(path.join(tmpDir, COMPAT_INSTRUCTION_FILE), 'utf-8'),
    ).toBe('Primary');
    expectCompatSymlink(tmpDir);
  });

  it('does nothing when neither instruction file exists', () => {
    ensureInstructionAliases(tmpDir);

    expect(fs.existsSync(path.join(tmpDir, PRIMARY_INSTRUCTION_FILE))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(tmpDir, COMPAT_INSTRUCTION_FILE))).toBe(
      false,
    );
  });

  it('creates aliases readable through either instruction filename', () => {
    fs.writeFileSync(
      path.join(tmpDir, PRIMARY_INSTRUCTION_FILE),
      'Shared instructions',
    );

    ensureInstructionAliases(tmpDir);

    expect(
      fs.readFileSync(path.join(tmpDir, PRIMARY_INSTRUCTION_FILE), 'utf-8'),
    ).toBe('Shared instructions');
    expect(
      fs.readFileSync(path.join(tmpDir, COMPAT_INSTRUCTION_FILE), 'utf-8'),
    ).toBe('Shared instructions');
    expectCompatSymlink(tmpDir);
  });
});
