import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPrivateText, requestJson } from '../../../packages/web-host/src/myagent/io';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
describe('private credential file boundary', () => {
  it('reads private files without altering them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aionui-w3-private-')); dirs.push(dir);
    const file = join(dir, 'fixture'); await writeFile(file, 'synthetic-test-value\n', { mode: 0o600 });
    expect(await readPrivateText(file)).toBe('synthetic-test-value');
  });
  it('rejects world-readable files and symlinks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aionui-w3-private-')); dirs.push(dir);
    const file = join(dir, 'fixture'); await writeFile(file, 'synthetic-test-value', { mode: 0o644 });
    await expect(readPrivateText(file)).rejects.toThrow('PRIVATE_CREDENTIAL_UNAVAILABLE');
    await symlink(file, join(dir, 'link'));
    await expect(readPrivateText(join(dir, 'link'))).rejects.toThrow('PRIVATE_CREDENTIAL_UNAVAILABLE');
  });
  it('does not expose the path or transport details on a failed connection', async () => {
    await expect(requestJson('http://127.0.0.1:1')).rejects.toThrow('UPSTREAM_UNAVAILABLE');
  });
});
