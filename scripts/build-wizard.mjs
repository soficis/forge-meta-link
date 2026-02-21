#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const stateDir = path.join(repoRoot, ".build-wizard");
const stateFile = path.join(stateDir, "state.json");
const logFile = path.join(
    stateDir,
    `wizard-${new Date().toISOString().replace(/[:.]/g, "-")}.log`,
);

const ARM64_DOCKERFILE_PATH = path.join(
    repoRoot,
    "scripts",
    "Dockerfile.arm64-deb",
);
const ARM64_DIST_PATH = path.join(repoRoot, "dist-arm64");

const TARGETS = [
    {
        id: "host-default",
        label: "Host platform default build (recommended)",
        description:
            "Build default bundles for your current OS (Linux/macOS/Windows).",
        isAvailable: () => true,
    },
    {
        id: "linux-x64",
        label: "Linux x64 (.deb + .AppImage)",
        description: "Build Linux x64 bundles.",
        isAvailable: (env) => env.isLinux || env.isWsl,
    },
    {
        id: "linux-arm64",
        label: "Linux ARM64 (.deb via Docker) [Completely Untested]",
        description:
            "Build Linux ARM64 local .deb in Docker with QEMU emulation.",
        isAvailable: (env) => env.isLinux || env.isWsl,
    },
    {
        id: "windows-x64",
        label: "Windows x64 (.msi + setup.exe)",
        description: "Build Windows x64 installers (native Windows or WSL bridge).",
        isAvailable: (env) => env.isWindows || env.hasWindowsBridge,
    },
    {
        id: "windows-arm64",
        label: "Windows ARM64 (.msi + setup.exe) [Completely Untested]",
        description: "Build Windows ARM64 installers (native Windows or WSL bridge).",
        isAvailable: (env) => env.isWindows || env.hasWindowsBridge,
    },
    {
        id: "macos-x64",
        label: "macOS x64 (.app + .dmg)",
        description: "Build macOS x64 bundles.",
        isAvailable: (env) => env.isMac,
    },
    {
        id: "macos-arm64",
        label: "macOS ARM64 (.app + .dmg)",
        description: "Build macOS ARM64 bundles.",
        isAvailable: (env) => env.isMac,
    },
];

const DEFAULT_STATE = {
    version: 1,
    createdAt: null,
    updatedAt: null,
    currentStep: null,
    selectedTargets: [],
    steps: {},
};

let state = { ...DEFAULT_STATE };
let hasWrittenSignalState = false;

const args = process.argv.slice(2);
const options = parseArgs(args);
const envInfo = detectEnvironment();

bootstrapState();
registerSignalHandlers();

if (options.help) {
    printHelp();
    process.exit(0);
}

await runWizard();

async function runWizard() {
    logBanner();

    if (options.resetState) {
        resetState();
        log("State reset requested. Previous resumable progress cleared.");
    }

    const availableTargets = TARGETS.filter((target) => target.isAvailable(envInfo));
    if (availableTargets.length === 0) {
        fatal(
            "No build targets are available in this environment. Run from Linux/WSL or Windows.",
        );
    }

    const selectedTargets = await resolveSelectedTargets(availableTargets);
    state.selectedTargets = selectedTargets;
    saveState();

    log(`Selected targets: ${selectedTargets.join(", ")}`);
    if (state.currentStep) {
        log(
            `Resuming from previous interrupted run. Last in-progress step: ${state.currentStep}`,
        );
    }

    for (const targetId of selectedTargets) {
        if (targetId === "host-default") {
            await runHostDefaultBuild();
        } else if (targetId === "linux-x64") {
            await runLinuxX64Build();
        } else if (targetId === "linux-arm64") {
            await runLinuxArm64Build();
        } else if (targetId === "windows-x64") {
            await runWindowsX64Build();
        } else if (targetId === "windows-arm64") {
            await runWindowsArm64Build();
        } else if (targetId === "macos-x64") {
            await runMacosX64Build();
        } else if (targetId === "macos-arm64") {
            await runMacosArm64Build();
        }
    }

    const builtArtifacts = collectArtifactsForTargets(selectedTargets);
    log("");
    log("Build wizard completed.");
    if (builtArtifacts.length > 0) {
        log("Artifacts found:");
        for (const artifactPath of builtArtifacts) {
            log(`- ${path.relative(repoRoot, artifactPath)}`);
        }
    } else {
        log("No artifacts found in expected locations.");
    }
    log(`Run log: ${path.relative(repoRoot, logFile)}`);
}

function parseArgs(rawArgs) {
    const parsed = {
        targets: null,
        nonInteractive: false,
        yes: false,
        resetState: false,
        help: false,
    };

    for (const arg of rawArgs) {
        if (arg === "--help" || arg === "-h") {
            parsed.help = true;
        } else if (arg === "--non-interactive") {
            parsed.nonInteractive = true;
        } else if (arg === "--yes" || arg === "-y") {
            parsed.yes = true;
            parsed.nonInteractive = true;
        } else if (arg === "--reset-state") {
            parsed.resetState = true;
        } else if (arg.startsWith("--targets=")) {
            const value = arg.split("=", 2)[1] ?? "";
            parsed.targets = value
                .split(",")
                .map((entry) => entry.trim())
                .filter(Boolean);
        } else {
            fatal(`Unknown argument: ${arg}`);
        }
    }

    return parsed;
}

function detectEnvironment() {
    const isWindows = process.platform === "win32";
    const isLinux = process.platform === "linux";
    const isMac = process.platform === "darwin";
    const releaseText = os.release().toLowerCase();
    const procVersion = fs.existsSync("/proc/version")
        ? fs.readFileSync("/proc/version", "utf8").toLowerCase()
        : "";
    const isWsl =
        isLinux &&
        (releaseText.includes("microsoft") ||
            procVersion.includes("microsoft") ||
            fs.existsSync("/proc/sys/fs/binfmt_misc/WSLInterop"));
    const hasWindowsBridge = isWsl && commandWorks("cmd.exe", ["/c", "echo", "ok"]);

    return { isWindows, isLinux, isMac, isWsl, hasWindowsBridge };
}

function bootstrapState() {
    fs.mkdirSync(stateDir, { recursive: true });
    if (!fs.existsSync(stateFile)) {
        state = {
            ...DEFAULT_STATE,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        saveState();
        return;
    }

    try {
        const raw = fs.readFileSync(stateFile, "utf8");
        const parsed = JSON.parse(raw);
        state = {
            ...DEFAULT_STATE,
            ...parsed,
            steps: parsed.steps ?? {},
        };
    } catch (error) {
        fatal(`Failed to parse ${stateFile}: ${String(error)}`);
    }
}

function resetState() {
    state = {
        ...DEFAULT_STATE,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
    saveState();
}

function saveState() {
    state.updatedAt = new Date().toISOString();
    fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function registerSignalHandlers() {
    const onSignal = (signalName) => {
        if (hasWrittenSignalState) {
            process.exit(130);
        }
        hasWrittenSignalState = true;
        log(`Received ${signalName}. Persisting wizard state for resume.`);
        if (state.currentStep) {
            state.steps[state.currentStep] = {
                ...(state.steps[state.currentStep] ?? {}),
                status: "interrupted",
                finishedAt: new Date().toISOString(),
                error: `${signalName} interruption`,
            };
            state.currentStep = null;
        }
        saveState();
        process.exit(130);
    };

    process.on("SIGINT", () => onSignal("SIGINT"));
    process.on("SIGTERM", () => onSignal("SIGTERM"));
}

function logBanner() {
    log("ForgeMetaLink Build Wizard");
    log("One-command, resumable multi-target build helper.");
    log(
        `Environment: ${envInfo.isWsl ? "WSL" : process.platform} (${os.arch()})`,
    );
    log(`State file: ${path.relative(repoRoot, stateFile)}`);
}

async function resolveSelectedTargets(availableTargets) {
    if (options.targets?.length) {
        const validIds = new Set(TARGETS.map((entry) => entry.id));
        for (const target of options.targets) {
            if (!validIds.has(target)) {
                fatal(`Unknown target "${target}". Use --help for valid values.`);
            }
        }
        for (const target of options.targets) {
            const definition = TARGETS.find((entry) => entry.id === target);
            if (!definition?.isAvailable(envInfo)) {
                fatal(
                    `Target "${target}" is not available in this environment.`,
                );
            }
        }
        return options.targets;
    }

    if (options.nonInteractive) {
        return availableTargets.map((target) => target.id);
    }

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    try {
        log("");
        log("Available targets:");
        availableTargets.forEach((target, index) => {
            log(`  ${index + 1}. ${target.label}`);
            log(`     ${target.description}`);
        });

        log("");
        log(
            "Enter target numbers separated by commas (blank = all available):",
        );
        const answer = (await rl.question("> ")).trim();
        if (!answer) {
            return availableTargets.map((target) => target.id);
        }

        const selected = answer
            .split(",")
            .map((value) => Number.parseInt(value.trim(), 10))
            .filter((value) => Number.isInteger(value) && value > 0)
            .map((value) => availableTargets[value - 1])
            .filter(Boolean);

        if (selected.length === 0) {
            fatal("No valid target selection received.");
        }

        if (!options.yes) {
            const confirmation = (
                await rl.question(
                    `Proceed with ${selected
                        .map((target) => target.id)
                        .join(", ")} ? [Y/n] `,
                )
            )
                .trim()
                .toLowerCase();
            if (confirmation === "n" || confirmation === "no") {
                fatal("Build cancelled by user.");
            }
        }

        return selected.map((target) => target.id);
    } finally {
        rl.close();
    }
}

async function runHostDefaultBuild() {
    const stepId = "host-default:build";
    await runStep(stepId, "Build host platform default bundles", async () => {
        await runTauriBuild(["build"]);
    });
}

async function runLinuxX64Build() {
    const stepId = "linux-x64:build";
    await runStep(stepId, "Build Linux x64 bundles", async () => {
        await runTauriBuild([
            "build",
            "--target",
            "x86_64-unknown-linux-gnu",
            "--bundles",
            "deb,appimage",
        ]);

        const bundleRoot = path.join(
            repoRoot,
            "src-tauri/target/x86_64-unknown-linux-gnu/release/bundle",
        );
        ensureFilesExist(
            findFilesByExtension(bundleRoot, ".deb"),
            "Linux x64 .deb artifact",
        );
        ensureFilesExist(
            findFilesByExtension(bundleRoot, ".AppImage"),
            "Linux x64 .AppImage artifact",
        );
    });
}

async function runWindowsX64Build() {
    const stepId = "windows-x64:build";
    await runStep(stepId, "Build Windows x64 bundles", async () => {
        if (envInfo.isWindows) {
            await runCommand("npm.cmd", [
                "run",
                "tauri",
                "--",
                "build",
                "--bundles",
                "msi,nsis",
            ]);
        } else if (envInfo.hasWindowsBridge) {
            await runWindowsBuildFromWsl(["build", "--bundles", "msi,nsis"]);
        } else {
            throw new Error(
                "Windows x64 build is available only on Windows or WSL with cmd.exe bridge.",
            );
        }

        const bundleRoot = path.join(repoRoot, "src-tauri/target/release/bundle");
        ensureFilesExist(
            findFilesByExtension(path.join(bundleRoot, "msi"), ".msi"),
            "Windows x64 .msi artifact",
        );
        ensureFilesExist(
            findFilesByExtension(path.join(bundleRoot, "nsis"), ".exe"),
            "Windows x64 setup .exe artifact",
        );
    });
}

async function runWindowsArm64Build() {
    const stepId = "windows-arm64:build";
    await runStep(stepId, "Build Windows ARM64 bundles", async () => {
        if (envInfo.isWindows) {
            await runCommand("npm.cmd", [
                "run",
                "tauri",
                "--",
                "build",
                "--target",
                "aarch64-pc-windows-msvc",
                "--bundles",
                "msi,nsis",
            ]);
        } else if (envInfo.hasWindowsBridge) {
            await runWindowsBuildFromWsl([
                "build",
                "--target",
                "aarch64-pc-windows-msvc",
                "--bundles",
                "msi,nsis",
            ]);
        } else {
            throw new Error(
                "Windows ARM64 build is available only on Windows or WSL with cmd.exe bridge.",
            );
        }

        const bundleRoot = path.join(
            repoRoot,
            "src-tauri/target/aarch64-pc-windows-msvc/release/bundle",
        );
        ensureFilesExist(
            findFilesByExtension(path.join(bundleRoot, "msi"), ".msi"),
            "Windows ARM64 .msi artifact",
        );
        ensureFilesExist(
            findFilesByExtension(path.join(bundleRoot, "nsis"), ".exe"),
            "Windows ARM64 setup .exe artifact",
        );
    });
}

async function runMacosX64Build() {
    const stepId = "macos-x64:build";
    await runStep(stepId, "Build macOS x64 bundles", async () => {
        await runTauriBuild([
            "build",
            "--target",
            "x86_64-apple-darwin",
            "--bundles",
            "app,dmg",
        ]);

        const bundleRoot = path.join(
            repoRoot,
            "src-tauri/target/x86_64-apple-darwin/release/bundle",
        );
        ensureFilesExist(
            findFilesByExtension(bundleRoot, ".dmg"),
            "macOS x64 .dmg artifact",
        );
    });
}

async function runMacosArm64Build() {
    const stepId = "macos-arm64:build";
    await runStep(stepId, "Build macOS ARM64 bundles", async () => {
        await runTauriBuild([
            "build",
            "--target",
            "aarch64-apple-darwin",
            "--bundles",
            "app,dmg",
        ]);

        const bundleRoot = path.join(
            repoRoot,
            "src-tauri/target/aarch64-apple-darwin/release/bundle",
        );
        ensureFilesExist(
            findFilesByExtension(bundleRoot, ".dmg"),
            "macOS ARM64 .dmg artifact",
        );
    });
}

async function runLinuxArm64Build() {
    await runStep(
        "linux-arm64:docker-install",
        "Install Docker dependencies (if missing)",
        async () => {
            if (commandWorks("docker", ["--version"])) {
                log("Docker already installed.");
                return;
            }

            if (!envInfo.isLinux && !envInfo.isWsl) {
                throw new Error(
                    "Automatic Docker install is supported only on Linux/WSL. Install Docker manually and rerun.",
                );
            }

            if (!isDebianLike()) {
                throw new Error(
                    "Automatic Docker install currently supports Debian/Ubuntu. Install Docker manually and rerun.",
                );
            }

            await runCommand("sudo", ["apt-get", "update"]);
            await runCommand("sudo", [
                "apt-get",
                "install",
                "-y",
                "docker.io",
                "qemu-user-static",
            ]);
            await runCommand("sudo", [
                "apt-get",
                "install",
                "-y",
                "docker-buildx-plugin",
            ], { allowFailure: true });
        },
    );

    await runStep(
        "linux-arm64:docker-ready",
        "Ensure Docker daemon is running",
        async () => {
            if (!commandWorks("docker", ["info"])) {
                await runCommand("sudo", ["service", "docker", "start"], {
                    allowFailure: true,
                });
            }
            if (!commandWorks("docker", ["info"])) {
                await runCommand("sudo", ["systemctl", "start", "docker"], {
                    allowFailure: true,
                });
            }

            if (!commandWorks("docker", ["info"]) && !commandWorks("sudo", ["docker", "info"])) {
                throw new Error(
                    "Docker daemon is not reachable. Start Docker manually and rerun.",
                );
            }
        },
    );

    await runStep(
        "linux-arm64:binfmt",
        "Enable ARM64 binfmt in Docker",
        async () => {
            await runDockerCommand([
                "run",
                "--privileged",
                "--rm",
                "tonistiigi/binfmt",
                "--install",
                "arm64",
            ]);
        },
    );

    await runStep(
        "linux-arm64:buildx",
        "Prepare Docker buildx builder",
        async () => {
            await runDockerCommand(["buildx", "create", "--name", "forgemetalink-arm64", "--use"], {
                allowFailure: true,
            });
            await runDockerCommand(["buildx", "use", "forgemetalink-arm64"], {
                allowFailure: true,
            });
            await runDockerCommand(["buildx", "inspect", "--bootstrap"]);
        },
    );

    await runStep(
        "linux-arm64:build",
        "Build Linux ARM64 .deb with Docker",
        async () => {
            if (!fs.existsSync(ARM64_DOCKERFILE_PATH)) {
                throw new Error(
                    `Missing Dockerfile template: ${ARM64_DOCKERFILE_PATH}`,
                );
            }
            fs.mkdirSync(ARM64_DIST_PATH, { recursive: true });
            await runDockerCommand([
                "buildx",
                "build",
                "--platform",
                "linux/arm64",
                "-f",
                ARM64_DOCKERFILE_PATH,
                "-o",
                `type=local,dest=${ARM64_DIST_PATH}`,
                ".",
            ]);

            const arm64Debs = findFilesByExtension(ARM64_DIST_PATH, ".deb");
            if (arm64Debs.length === 0) {
                throw new Error(
                    `No ARM64 .deb found in ${ARM64_DIST_PATH} after Docker build.`,
                );
            }
        },
    );
}

async function runTauriBuild(tauriArgs) {
    if (envInfo.isWindows) {
        await runCommand("npm.cmd", ["run", "tauri", "--", ...tauriArgs]);
        return;
    }
    await runCommand("npm", ["run", "tauri", "--", ...tauriArgs]);
}

async function runWindowsBuildFromWsl(tauriArgs) {
    const winRepoPath = getWindowsPathFromWsl(repoRoot);
    const cmdLine = `cd /d "${winRepoPath}" && npm.cmd run tauri -- ${tauriArgs.join(" ")}`;
    await runCommand("cmd.exe", ["/c", cmdLine]);
}

function getWindowsPathFromWsl(posixPath) {
    const result = spawnSync("wslpath", ["-w", posixPath], {
        encoding: "utf8",
    });
    if (result.status !== 0) {
        throw new Error(
            `Failed to resolve Windows path via wslpath: ${result.stderr ?? ""}`,
        );
    }
    return result.stdout.trim();
}

async function runDockerCommand(args, options = {}) {
    if (commandWorks("docker", ["info"])) {
        await runCommand("docker", args, options);
        return;
    }
    await runCommand("sudo", ["docker", ...args], options);
}

function findFilesByExtension(rootDir, extension) {
    if (!fs.existsSync(rootDir)) return [];
    const out = [];
    const stack = [rootDir];
    while (stack.length > 0) {
        const currentDir = stack.pop();
        if (!currentDir) continue;
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);
            if (entry.isDirectory()) {
                stack.push(fullPath);
                continue;
            }
            if (entry.isFile() && fullPath.endsWith(extension)) {
                out.push(fullPath);
            }
        }
    }
    return out.sort();
}

function findFilesByPrefix(rootDir, prefix) {
    if (!fs.existsSync(rootDir)) return [];
    const out = [];
    const stack = [rootDir];
    while (stack.length > 0) {
        const currentDir = stack.pop();
        if (!currentDir) continue;
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);
            if (entry.isDirectory()) {
                stack.push(fullPath);
                continue;
            }
            if (entry.isFile() && entry.name.startsWith(prefix)) {
                out.push(fullPath);
            }
        }
    }
    return out.sort();
}

function collectArtifactsForTargets(selectedTargets) {
    const files = [];

    if (selectedTargets.includes("host-default")) {
        const hostBundleRoot = path.join(
            repoRoot,
            "src-tauri/target/release/bundle",
        );
        files.push(...findFilesByPrefix(hostBundleRoot, "forge-meta-link"));
    }
    if (selectedTargets.includes("linux-x64")) {
        const bundleRoot = path.join(
            repoRoot,
            "src-tauri/target/x86_64-unknown-linux-gnu/release/bundle",
        );
        files.push(...findFilesByPrefix(bundleRoot, "forge-meta-link"));
    }
    if (selectedTargets.includes("windows-x64")) {
        const bundleRoot = path.join(repoRoot, "src-tauri/target/release/bundle");
        files.push(...findFilesByPrefix(bundleRoot, "forge-meta-link"));
    }
    if (selectedTargets.includes("windows-arm64")) {
        const bundleRoot = path.join(
            repoRoot,
            "src-tauri/target/aarch64-pc-windows-msvc/release/bundle",
        );
        files.push(...findFilesByPrefix(bundleRoot, "forge-meta-link"));
    }
    if (selectedTargets.includes("macos-x64")) {
        const bundleRoot = path.join(
            repoRoot,
            "src-tauri/target/x86_64-apple-darwin/release/bundle",
        );
        files.push(...findFilesByPrefix(bundleRoot, "forge-meta-link"));
    }
    if (selectedTargets.includes("macos-arm64")) {
        const bundleRoot = path.join(
            repoRoot,
            "src-tauri/target/aarch64-apple-darwin/release/bundle",
        );
        files.push(...findFilesByPrefix(bundleRoot, "forge-meta-link"));
    }
    if (selectedTargets.includes("linux-arm64")) {
        files.push(...findFilesByExtension(ARM64_DIST_PATH, ".deb"));
    }

    return Array.from(
        new Set(files.filter((filePath) => fs.existsSync(filePath))),
    );
}

async function runStep(stepId, title, action) {
    const existing = state.steps[stepId];
    if (existing?.status === "done") {
        log(`Skipping completed step: ${title}`);
        return;
    }

    log("");
    log(`Step: ${title}`);
    state.currentStep = stepId;
    state.steps[stepId] = {
        status: "in_progress",
        startedAt: new Date().toISOString(),
        finishedAt: null,
        error: null,
    };
    saveState();

    try {
        await action();
        state.steps[stepId] = {
            ...state.steps[stepId],
            status: "done",
            finishedAt: new Date().toISOString(),
            error: null,
        };
        state.currentStep = null;
        saveState();
    } catch (error) {
        state.steps[stepId] = {
            ...state.steps[stepId],
            status: "failed",
            finishedAt: new Date().toISOString(),
            error: String(error),
        };
        state.currentStep = null;
        saveState();
        throw error;
    }
}

function commandWorks(command, args = []) {
    const result = spawnSync(command, args, {
        stdio: "ignore",
        shell: false,
    });
    return result.status === 0;
}

async function runCommand(command, args, options = {}) {
    const { cwd = repoRoot, env = process.env, allowFailure = false } = options;

    const printable = `${command} ${args.join(" ")}`.trim();
    log(`$ ${printable}`);

    await new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd,
            env,
            stdio: ["inherit", "pipe", "pipe"],
            shell: false,
        });

        child.stdout.on("data", (chunk) => {
            process.stdout.write(chunk);
            fs.appendFileSync(logFile, chunk);
        });

        child.stderr.on("data", (chunk) => {
            process.stderr.write(chunk);
            fs.appendFileSync(logFile, chunk);
        });

        child.on("error", (error) => {
            reject(error);
        });

        child.on("close", (code) => {
            if (code === 0 || allowFailure) {
                resolve();
                return;
            }
            reject(new Error(`Command failed with exit code ${code}: ${printable}`));
        });
    });
}

function ensureFilesExist(filePaths, artifactLabel) {
    if (!Array.isArray(filePaths) || filePaths.length === 0) {
        throw new Error(`Missing expected artifact: ${artifactLabel}`);
    }
    const missing = filePaths.filter((filePath) => !fs.existsSync(filePath));
    if (missing.length > 0) {
        throw new Error(
            `Missing expected artifact(s) for ${artifactLabel}: ${missing.join(", ")}`,
        );
    }
}

function isDebianLike() {
    return fs.existsSync("/etc/debian_version");
}

function log(message) {
    const line = `[${new Date().toISOString()}] ${message}`;
    console.log(line);
    fs.appendFileSync(logFile, `${line}\n`, "utf8");
}

function fatal(message) {
    console.error(`ERROR: ${message}`);
    process.exit(1);
}

function printHelp() {
    const available = TARGETS.map((target) => target.id).join(", ");
    console.log(`ForgeMetaLink Build Wizard

Usage:
  node scripts/build-wizard.mjs
  node scripts/build-wizard.mjs --targets=host-default --yes
  node scripts/build-wizard.mjs --targets=linux-arm64 --yes

Options:
  --targets=<comma-list>   Target IDs: ${available}
  --non-interactive        Use all available targets unless --targets is provided
  --yes, -y                Skip confirmation prompts
  --reset-state            Clear resumable wizard state before running
  --help, -h               Show this help

Examples:
  npm run build:wizard
  npm run build:wizard -- --targets=host-default --yes
  npm run build:wizard -- --targets=linux-x64,windows-x64 --yes
  npm run build:wizard -- --targets=macos-arm64 --yes
  ./scripts/build-wizard.sh --targets=linux-arm64 --yes
  .\\scripts\\build-wizard.ps1 --targets=windows-x64,windows-arm64

Notes:
  - Target IDs align with release workflow matrix labels in .github/workflows/release.yml:
    linux-x64, linux-arm64, windows-x64, windows-arm64, macos-x64, macos-arm64
  - Local linux-arm64 target currently produces .deb via Docker/QEMU.
`);
}
