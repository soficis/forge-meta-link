#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { applyOps, expandSweep, changedOverrides } from '../src/utils/mutations.ts';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const DOCS_DIR = path.resolve(REPO_ROOT, 'docs');
const REPORT_PATH = path.resolve(DOCS_DIR, 'forge-gate-report.md');

const BASE_URL = (process.env.FORGE_API_URL || 'http://127.0.0.1:7860').replace(/\/+$/, '');

function parseInfotext(infotext) {
    if (!infotext || typeof infotext !== 'string') return {};
    const lines = infotext.split('\n');
    const paramsLine = lines.find(l => l.includes('Steps:') && l.includes('Sampler:')) || lines[lines.length - 1] || '';
    const result = {
        prompt: lines[0] || '',
        raw: infotext
    };
    const parts = paramsLine.split(',').map(s => s.trim());
    for (const part of parts) {
        const colon = part.indexOf(':');
        if (colon !== -1) {
            const k = part.slice(0, colon).trim();
            const v = part.slice(colon + 1).trim();
            result[k] = v;
        }
    }
    return result;
}

async function main() {
    console.log(`[verify-forge-roundtrip] Target API: ${BASE_URL}`);
    
    // 1. Fetch samplers and schedulers
    let samplers = [];
    let schedulers = [];
    try {
        const sRes = await fetch(`${BASE_URL}/sdapi/v1/samplers`);
        samplers = await sRes.json();
        const scRes = await fetch(`${BASE_URL}/sdapi/v1/schedulers`);
        schedulers = await scRes.json();
    } catch (err) {
        console.error(`[verify-forge-roundtrip] Failed to connect to Forge API at ${BASE_URL}:`, err.message);
        process.exit(1);
    }

    console.log(`Found ${samplers.length} samplers and ${schedulers.length} schedulers.`);

    // 2. App payload paths. Runs the real Rust payload builders + PNG parser + DB against this
    // Forge (tests/forge_live_gate.rs): Send-to, requeue, per-variant params, ADetailer, LoRA,
    // 64-bit seed. This replaces the earlier hand-copied JS builder, which proved nothing about the app.
    console.log(`Running app payload-path gate (cargo test --test forge_live_gate)...`);
    const jsonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-gate-'));

    // Mutation sweep fixture, computed by the app's real operator code (src/utils/mutations.ts),
    // exactly as MutationPopover does: base holds only what the record carries (no scheduler),
    // and only the fields an operator changed are sent as overrides.
    const SOURCE_BASE = { steps: '4', sampler: 'Euler a', schedule_type: 'exponential', cfg_scale: '5.5', seed: '4294967299', width: 64, height: 64 };
    const uiBase = {
        prompt: '', negative_prompt: '', steps: SOURCE_BASE.steps, sampler: SOURCE_BASE.sampler,
        schedule_type: null, cfg_scale: SOURCE_BASE.cfg_scale, seed: SOURCE_BASE.seed,
        width: SOURCE_BASE.width, height: SOURCE_BASE.height, model_hash: null, model_name: null,
        generation_type: null, extra_params: {}, raw_metadata: '',
    };
    const sweepVariants = expandSweep({
        seedSteps: [1, 2, 4],
        cfgDeltas: [1],
        stepsDeltas: [2],
        swaps: [{ sampler: 'Euler' }, { scheduler: 'karras' }, { sampler: 'DPM++ 2M', scheduler: 'simple' }],
    }).map(ops => {
        const mutated = applyOps(uiBase, ops);
        const overrides = changedOverrides(uiBase, mutated);
        return {
            ops,
            overrides,
            expected: {
                steps: mutated.steps,
                sampler: mutated.sampler,
                scheduler: mutated.schedule_type ?? SOURCE_BASE.schedule_type,
                cfg_scale: mutated.cfg_scale,
                seed: mutated.seed,
            },
        };
    });
    const sweepFixture = path.join(jsonDir, 'sweep-fixture.in');
    fs.writeFileSync(sweepFixture, JSON.stringify({ base: SOURCE_BASE, variants: sweepVariants }, null, 2));
    console.log(`  sweep fixture: ${sweepVariants.length} variants from real operator code`);
    const cargo = spawnSync(
        'cargo',
        ['test', '--manifest-path', path.join(REPO_ROOT, 'src-tauri', 'Cargo.toml'),
         '--test', 'forge_live_gate', '--', '--nocapture', '--test-threads=1'],
        {
            env: { ...process.env, FORGE_LIVE_URL: BASE_URL, FORGE_GATE_JSON: jsonDir, FORGE_SWEEP_JSON: sweepFixture },
            encoding: 'utf-8',
        }
    );
    const gateChecks = [];
    for (const f of fs.readdirSync(jsonDir).filter(n => n.endsWith('.json')).sort()) {
        gateChecks.push(...JSON.parse(fs.readFileSync(path.join(jsonDir, f), 'utf-8')));
    }
    const gateFailures = gateChecks.filter(c => !c.ok);
    const gatePassed = cargo.status === 0 && gateChecks.length > 0 && gateFailures.length === 0;
    for (const note of `${cargo.stdout}${cargo.stderr}`.split('\n').filter(l => /skipping/i.test(l))) {
        console.log(`  note: ${note.trim()}`);
    }
    console.log(`  ${gateChecks.length} field checks, ${gateFailures.length} mismatch(es); cargo exit ${cargo.status}`);
    if (!gatePassed) {
        console.error(`${cargo.stdout}\n${cargo.stderr}`.split('\n').slice(-40).join('\n'));
    }

    // 3. Matrix test: test all schedulers with a reliable sampler ('Euler')
    console.log(`\nTesting scheduler compatibility matrix...`);
    const schedulerResults = [];
    for (const sc of schedulers) {
        const scName = sc.name;
        try {
            const scPayload = {
                prompt: 'test',
                steps: 1,
                width: 64,
                height: 64,
                sampler_name: 'Euler',
                scheduler: scName,
                seed: 100
            };
            const res = await fetch(`${BASE_URL}/sdapi/v1/txt2img`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(scPayload)
            });
            if (res.ok) {
                const data = await res.json();
                const info = data.info ? JSON.parse(data.info) : {};
                const parsed = parseInfotext(info.infotexts?.[0] || '');
                const returnedSched = parsed['Schedule type'] || info.extra_generation_params?.['Schedule type'] || 'Unknown';
                schedulerResults.push({
                    name: scName,
                    label: sc.label,
                    status: 'Accepted',
                    returnedName: returnedSched
                });
            } else {
                schedulerResults.push({
                    name: scName,
                    label: sc.label,
                    status: `Rejected (${res.status})`,
                    returnedName: 'N/A'
                });
            }
        } catch (e) {
            schedulerResults.push({
                name: scName,
                label: sc.label,
                status: `Error: ${e.message}`,
                returnedName: 'N/A'
            });
        }
    }

    // 4. Matrix test: test sample of top samplers
    console.log(`\nTesting sampler compatibility matrix...`);
    const samplerResults = [];
    for (const s of samplers) {
        const sName = s.name;
        try {
            const sPayload = {
                prompt: 'test',
                steps: 1,
                width: 64,
                height: 64,
                sampler_name: sName,
                scheduler: 'karras',
                seed: 100
            };
            const res = await fetch(`${BASE_URL}/sdapi/v1/txt2img`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(sPayload)
            });
            if (res.ok) {
                const data = await res.json();
                const info = data.info ? JSON.parse(data.info) : {};
                const parsed = parseInfotext(info.infotexts?.[0] || '');
                const returnedSampler = parsed['Sampler'] || info.sampler_name || 'Unknown';
                samplerResults.push({
                    name: sName,
                    status: 'Accepted',
                    returnedName: returnedSampler
                });
            } else {
                samplerResults.push({
                    name: sName,
                    status: `Rejected (${res.status})`,
                    returnedName: 'N/A'
                });
            }
        } catch (e) {
            samplerResults.push({
                name: sName,
                status: `Error: ${e.message}`,
                returnedName: 'N/A'
            });
        }
    }

    // 5. Generate Markdown Report
    if (!fs.existsSync(DOCS_DIR)) {
        fs.mkdirSync(DOCS_DIR, { recursive: true });
    }

    const reportContent = `# Forge Neo Ship-Gate & API Roundtrip Report

Date: ${new Date().toISOString()}
Target: \`${BASE_URL}\`

## Executive Summary
- **Ship Gate Status**: **${gatePassed ? 'PASSED' : 'FAILED'}** for G9 requeue round-trip (${gateChecks.length} field checks across the app's real payload paths, ${gateFailures.length} mismatch(es)).
- **Scope**: Send-to/batch path, requeue path, three per-variant requests with distinct seed/CFG, a mutation sweep (${sweepVariants.length} variants from the real operator code: seed step, CFG and steps deltas, sampler/scheduler swaps), ADetailer variant, LoRA, and a 64-bit seed (above 2^32). Built by the app's own Rust builders from a real ingested PNG, not a copy.
- **Scheduler Round-Trip**: Forge reports display labels (e.g. \`karras\` -> \`Karras\`); comparison is case-insensitive.
- **Matrices below** only show which names Forge accepts for a trivial request; they do not prove the app preserves them.

## App Payload Path Checks
| Scenario | Field | Expected | Returned | Status |
|----------|-------|----------|----------|--------|
${gateChecks.map(c => `| ${c.scenario} | ${c.field} | \`${c.expected}\` | \`${c.actual}\` | ${c.ok ? '✅ MATCH' : '❌ MISMATCH'} |`).join('\n')}

## Schedulers Matrix (${schedulers.length} total)
| API Name | Label | Status | Returned Infotext Name |
|----------|-------|--------|------------------------|
${schedulerResults.map(r => `| \`${r.name}\` | ${r.label} | ${r.status} | \`${r.returnedName}\` |`).join('\n')}

## Samplers Matrix (${samplers.length} total)
| Sampler Name | Status | Returned In Infotext |
|--------------|--------|----------------------|
${samplerResults.map(r => `| \`${r.name}\` | ${r.status} | \`${r.returnedName}\` |`).join('\n')}

## Operator Recommendations for G8 Sweep
1. **Schedulers**: \`automatic\`, \`karras\`, \`exponential\`, \`simple\`, \`normal\`, \`sgm_uniform\`, \`ddim\`, \`align_your_steps\`, \`beta\`, \`turbo\`.
2. **Samplers**: \`Euler\`, \`Euler a\`, \`DPM++ 2M\`, \`DPM++ SDE\`, \`DPM++ 2M SDE\`, \`UniPC\`, \`DDIM\`.
3. **Casing Normalization**: When matching infotext back to dropdown keys, use case-insensitive match (e.g., \`Karras\` <-> \`karras\`).
`;

    fs.writeFileSync(REPORT_PATH, reportContent, 'utf-8');
    console.log(`\nReport successfully written to ${REPORT_PATH}`);
}

main().catch(err => {
    console.error('Fatal error in verify-forge-roundtrip:', err);
    process.exit(1);
});
