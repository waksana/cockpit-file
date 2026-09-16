import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { inventory, sourceIdentity, writeBuildReceipt } from '../build-identity.mjs';

export function commitFixture(root) {
  execFileSync('git', ['add', '.'], { cwd: root, stdio: 'pipe' });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm',
    'Synthetic release fixture\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>'], { cwd: root, stdio: 'pipe' });
}

export async function releaseFixture(t) {
  const root = await mkdtemp(new URL('../../node_modules/release-fixture-', import.meta.url));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of ['dist', 'tooling', 'docs', '.cockpit-sdk/module-api', '.cockpit-sdk/protocol']) {
    await mkdir(join(root, path), { recursive: true });
  }
  const pin = { repository: 'waksana/cockpit', commit: 'a'.repeat(40), version: '0.2.0', apiVersion: 1 };
  await writeFile(join(root, 'tooling/host-sdk.json'), JSON.stringify(pin));
  await writeFile(join(root, 'cockpit.module.json'), JSON.stringify({
    apiVersion: 1, id: 'cockpit-file', version: '0.1.0', backend: 'dist/server.js',
    frontend: { entry: 'dist/web.js', styles: ['dist/web.css'], assets: ['dist'] },
  }));
  await writeFile(join(root, 'package.json'), '{"version":"0.1.0"}');
  await writeFile(join(root, '.node-version'), process.versions.node);
  await writeFile(join(root, '.gitignore'), 'dist/\n.cockpit-sdk/\n.module-build.json\n*.tgz\n*.sha256\n');
  await writeFile(join(root, 'LICENSE'), 'Synthetic fixture license');
  await writeFile(join(root, '.cockpit-sdk/LICENSE'), 'Synthetic SDK license');
  for (const name of ['module-api', 'protocol']) {
    await writeFile(join(root, '.cockpit-sdk', name, 'package.json'), JSON.stringify({ name: `@cockpit/${name}`, version: pin.version }));
  }
  const files = await inventory(join(root, '.cockpit-sdk'), ['module-api', 'protocol', 'LICENSE']);
  await writeFile(join(root, '.cockpit-sdk/pin.json'), JSON.stringify({ pin, files }));
  for (const file of ['server.js', 'web.js', 'web.css']) await writeFile(join(root, 'dist', file), 'Synthetic build input');
  await writeFile(join(root, 'private-fixture.txt'), 'Must not ship');
  await writeFile(join(root, 'docs/release-notes.md'), '# Cockpit File 0.1.0\n');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, stdio: 'pipe' });
  commitFixture(root);
  const receipt = () => writeBuildReceipt(root, sourceIdentity(root));
  await receipt();
  return { root, pin, output: join(root, 'output'), receipt, sha: sourceIdentity(root) };
}
