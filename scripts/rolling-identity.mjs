import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

export const repository = 'waksana/cockpit-file';
export function rollingIdentity(sequence, sourceSha) {
  assert.match(String(sequence), /^[1-9]\d*$/);
  sequence = Number(sequence);
  assert.ok(Number.isSafeInteger(sequence));
  assert.match(sourceSha, /^[a-f0-9]{40}$/);
  const version = `0.0.0-rolling.${sequence}`;
  return { repository, tag: `v${version}`, sourceSha, version, sequence };
}

export async function buildIdentity(root, env = process.env) {
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const metadata = JSON.parse(await readFile(`${root}/package.json`, 'utf8'));
  if (env.ROLLING_SEQUENCE !== undefined || env.ROLLING_SOURCE_SHA !== undefined) {
    assert.equal(metadata.version, '0.0.0-dev', 'Rolling builds require committed dev source');
    assert.equal(env.ROLLING_SOURCE_SHA, sourceSha, 'Rolling source differs from checkout');
    return { ...rollingIdentity(env.ROLLING_SEQUENCE, sourceSha), displayVersion: `0.0.0-rolling.${env.ROLLING_SEQUENCE}` };
  }
  return { version: metadata.version, sourceSha,
    displayVersion: metadata.version === '0.0.0-dev' ? `dev+${sourceSha.slice(0, 7)}` : metadata.version };
}

export async function deploymentDescriptor(root, identity) {
  const manifest = JSON.parse(await readFile(`${root}/cockpit.module.json`, 'utf8'));
  const frontend = await readFile(`${root}/src/web/index.tsx`, 'utf8');
  const draft = await readFile(`${root}/src/web/file-draft.ts`, 'utf8');
  const storage = await readFile(`${root}/src/server/storage.ts`, 'utf8');
  assert.equal(manifest.apiVersion, 1);
  assert.match(frontend, /context\.apiVersion !== 2/);
  assert.match(frontend, /context\.uiVersion !== 1/);
  assert.match(frontend, /context\.uiSurfaceVersion !== 1/);
  assert.match(draft, /registerDraft/);
  assert.match(draft, /project: state/);
  assert.match(frontend, /onPaste=/);
  assert.match(storage, /version: 2/);
  assert.doesNotMatch(storage, /node:sqlite|CREATE TABLE/);
  const { repository, tag, sourceSha, version, sequence } = identity;
  return {
    format: 2, channel: 'rolling', repository, tag, sourceSha, version, sequence,
    archive: { name: `${manifest.id}-${version}.tgz` },
    product: {
      kind: 'module', id: manifest.id, hostApi: { min: manifest.apiVersion, max: manifest.apiVersion },
      requiresCapabilities: ['module-api.v1', 'frontend-api.v2', 'ui.v1', 'uiSurface.v1',
        'composerInput.v1', 'draftLifecycle.v1', 'draftSubmission.v1'],
      requiredIntents: [], databases: [], migrations: [],
    },
  };
}
