import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { stringify } from 'yaml';
import { sourceIdentity, writeBuildReceipt } from '../build-identity.mjs';

export function commitFixture(root) {
  execFileSync('git', ['add', '.'], { cwd: root, stdio: 'pipe' });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm',
    'Synthetic release fixture\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>'], { cwd: root, stdio: 'pipe' });
}

export async function releaseFixture(t) {
  const root = await mkdtemp(new URL('../../node_modules/release-fixture-', import.meta.url));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of ['dist', 'tooling', 'docs', 'node_modules/@waksana/cockpit-module-sdk']) {
    await mkdir(join(root, path), { recursive: true });
  }
  const pin = {
    name: '@waksana/cockpit-module-sdk', version: '0.2.0', registry: 'https://npm.pkg.github.com',
    resolved: `https://npm.pkg.github.com/download/@waksana/cockpit-module-sdk/0.2.0/${'a'.repeat(40)}`,
    integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
  };
  const lock = {
    lockfileVersion: '9.0',
    importers: { '.': { devDependencies: { [pin.name]: { specifier: pin.version, version: pin.version } } } },
    packages: { [`${pin.name}@${pin.version}`]: { resolution: { integrity: pin.integrity, tarball: pin.resolved } } },
  };
  await writeFile(join(root, 'pnpm-lock.yaml'), stringify(lock));
  await writeFile(join(root, 'tooling/host-integration.json'), JSON.stringify({
    repository: 'waksana/cockpit', commit: 'a'.repeat(40),
  }));
  await writeFile(join(root, 'cockpit.module.json'), JSON.stringify({
    apiVersion: 1, id: 'cockpit-file', version: '0.1.0', backend: 'dist/server.js',
    frontend: { entry: 'dist/web.js', styles: ['dist/web.css'], assets: ['dist'] },
  }));
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.1.0', devDependencies: { [pin.name]: pin.version } }));
  await writeFile(join(root, '.node-version'), process.versions.node);
  await writeFile(join(root, '.gitignore'), 'dist/\nnode_modules/\n.module-build.json\n*.tgz\n*.sha256\n');
  await writeFile(join(root, 'LICENSE'), 'Synthetic fixture license');
  await writeFile(join(root, 'node_modules', pin.name, 'package.json'), JSON.stringify({ name: pin.name, version: pin.version }));
  for (const file of ['server.js', 'web.js', 'web.css']) await writeFile(join(root, 'dist', file), 'Synthetic build input');
  await writeFile(join(root, 'private-fixture.txt'), 'Must not ship');
  await writeFile(join(root, 'docs/release-notes.md'), '# Cockpit File 0.1.0\n');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, stdio: 'pipe' });
  commitFixture(root);
  const receipt = () => writeBuildReceipt(root, sourceIdentity(root));
  await receipt();
  return { root, pin, lock, output: join(root, 'output'), receipt, sha: sourceIdentity(root) };
}
