#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeSkillFingerprint } from './automation-consent.mjs';

const currentFile = fileURLToPath(import.meta.url);
const defaultSkillRoot = dirname(dirname(currentFile));
const minimumNodeMajor = 18;

const requiredFiles = [
  ['skill', 'SKILL.md'],
  ['interface', 'agents/openai.yaml'],
  ['validator', 'scripts/validate-handoff.mjs'],
  ['automation_consent', 'scripts/automation-consent.mjs'],
  ['browser_transport', 'references/browser-transport.md'],
  ['context_packet', 'references/context-packet.md'],
  ['reasoning_request', 'references/reasoning-request.md'],
  ['run_receipt', 'references/run-receipt.md'],
  ['doctor_guide', 'references/doctor.md'],
];

async function fileCheck(skillRoot, id, relativePath) {
  try {
    const metadata = await lstat(join(skillRoot, relativePath));
    return { id, path: relativePath, ok: metadata.isFile() && !metadata.isSymbolicLink() };
  } catch {
    return { id, path: relativePath, ok: false };
  }
}

async function securityContractCheck(skillRoot) {
  try {
    const [skill, transport, reasoning] = await Promise.all([
      readFile(join(skillRoot, 'SKILL.md'), 'utf8'),
      readFile(join(skillRoot, 'references/browser-transport.md'), 'utf8'),
      readFile(join(skillRoot, 'references/reasoning-request.md'), 'utf8'),
    ]);
    const requiresNoRetry = /do not retry/i.test(`${skill}\n${transport}`);
    const reasoningStops = /invalid.*stop|stop.*invalid/i.test(reasoning);
    const reasoningRetries = /repair turn|send one repair|second invalid|resubmit.*again/i.test(reasoning);
    return requiresNoRetry && reasoningStops && !reasoningRetries;
  } catch {
    return false;
  }
}

export async function inspectInstallation(skillRoot = defaultSkillRoot) {
  const normalizedRoot = resolve(skillRoot);
  const checks = await Promise.all(
    requiredFiles.map(([id, relativePath]) => fileCheck(normalizedRoot, id, relativePath)),
  );

  let skillName = null;
  if (checks.find((check) => check.id === 'skill')?.ok) {
    const skill = await readFile(join(normalizedRoot, 'SKILL.md'), 'utf8');
    skillName = skill.match(/^name:\s*([a-z0-9-]+)$/m)?.[1] ?? null;
  }

  checks.push({
    id: 'skill_name',
    path: 'SKILL.md#name',
    ok: skillName === 'codex-bridge-chatgpt',
  });

  checks.push({
    id: 'security_contract_consistency',
    path: 'SKILL.md + references/browser-transport.md + references/reasoning-request.md',
    ok: await securityContractCheck(normalizedRoot),
  });

  let skillFingerprint = null;
  try {
    skillFingerprint = await computeSkillFingerprint(normalizedRoot);
  } catch {
    // Required-file checks and the fingerprint check below will fail closed.
  }
  checks.push({
    id: 'skill_fingerprint',
    path: 'security-relevant Skill files',
    ok: typeof skillFingerprint === 'string' && /^[a-f0-9]{64}$/.test(skillFingerprint),
  });

  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
  const runtimeReady = Number.isInteger(nodeMajor) && nodeMajor >= minimumNodeMajor;
  checks.push({
    id: 'node_runtime',
    path: `node>=${minimumNodeMajor}`,
    ok: runtimeReady,
  });

  const status = !runtimeReady
    ? 'MISSING_RUNTIME'
    : checks.every((check) => check.ok)
      ? 'READY'
      : 'INVALID_INSTALLATION';

  return {
    schema_version: 2,
    status,
    skill_name: skillName,
    skill_fingerprint_sha256: skillFingerprint,
    platform: process.platform,
    node: process.versions.node,
    minimum_node_major: minimumNodeMajor,
    checks,
  };
}

function parseArgs(argv) {
  const options = { json: false, skillRoot: defaultSkillRoot };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') {
      options.json = true;
      continue;
    }
    if (argument === '--skill-root' && argv[index + 1]) {
      options.skillRoot = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`unknown or incomplete argument: ${argument}`);
  }
  return options;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`usage: doctor.mjs [--json] [--skill-root <path>]\n${error.message}`);
    process.exitCode = 2;
    return;
  }

  const result = await inspectInstallation(options.skillRoot);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Codex bridge Doctor: ${result.status}`);
    for (const check of result.checks) {
      console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.id}: ${check.path}`);
    }
    if (result.skill_fingerprint_sha256) {
      console.log(`Skill fingerprint: ${result.skill_fingerprint_sha256}`);
    }
  }
  process.exitCode = result.status === 'READY' ? 0 : 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(currentFile)) {
  await main();
}
