import { execSync } from "child_process";
import { writeFileSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import { getPreferenceValues, environment } from "@raycast/api";

// ─── Types ────────────────────────────────────────────────────────────────

export interface Secret {
  name: string;
  createTime: string;
  labels?: Record<string, string>;
}

export interface IamBinding {
  email: string;
  role: string;
  memberType: "user" | "group" | "serviceAccount" | "domain";
}

interface Preferences {
  gcloudPath: string;
  gcpProject: string;
  shareGroups: string;
}

// ─── Config (all sourced from Raycast preferences — nothing hardcoded) ──────

function prefs(): Preferences {
  try {
    return getPreferenceValues<Preferences>();
  } catch {
    return { gcloudPath: "gcloud", gcpProject: "", shareGroups: "" };
  }
}

function gcloudPath(): string {
  return prefs().gcloudPath || "gcloud";
}

function project(): string {
  const p = prefs().gcpProject;
  if (!p) {
    throw new Error(
      "GCP Project ID is not configured. Set it in the extension preferences.",
    );
  }
  return p;
}

// Google Groups listed in the "Share Groups" preference (comma-separated).
// Used both as picker suggestions and to decide --member=group: vs --member=user:.
function shareGroups(): string[] {
  return (prefs().shareGroups || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// Pre-loaded into the share picker even before they're in history.
export function suggestedRecipients(): string[] {
  return shareGroups();
}

// "admin" gives read + write. We never grant viewer-only.
const SHARE_ROLE = "roles/secretmanager.admin";

// Merge suggested recipients + history, dedupe (case-insensitive),
// suggestions first.
export function mergeSuggestionsAndHistory(history: string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const e of [...suggestedRecipients(), ...history]) {
    const k = e.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      merged.push(e);
    }
  }
  return merged;
}

function memberType(email: string): "user" | "group" {
  return shareGroups().includes(email.toLowerCase()) ? "group" : "user";
}

function buildEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: [
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/opt/homebrew/bin",
      process.env.HOME ? `${process.env.HOME}/google-cloud-sdk/bin` : "",
      process.env.PATH ?? "",
    ].join(":"),
  };
}

function run(args: string): string {
  const bin = gcloudPath();
  const result = execSync(`"${bin}" ${args}`, {
    encoding: "utf8",
    env: buildEnv(),
  });
  return result.trim();
}

function withTempFile(value: string, fn: (tmpPath: string) => void): void {
  // User-scoped per-extension dir, not /tmp. mode 0o600 = owner read/write only.
  const tmpDir = join(environment.supportPath, "tmp");
  mkdirSync(tmpDir, { recursive: true });
  const tmpPath = join(
    tmpDir,
    `gcloud-secret-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  writeFileSync(tmpPath, value, { encoding: "utf8", mode: 0o600 });
  try {
    fn(tmpPath);
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* ignore cleanup errors */
    }
  }
}

// Pulls the actual gcloud error line out of an execSync error.
// Default String(err) shows "Command failed: <huge command>" which Raycast toasts truncate.
export function extractGcloudError(err: unknown): string {
  if (err && typeof err === "object" && "stderr" in err) {
    const stderr = (err as { stderr?: Buffer | string }).stderr;
    const text = typeof stderr === "string" ? stderr : stderr?.toString("utf8");
    if (text && text.trim()) {
      const lines = text
        .trim()
        .split("\n")
        .filter((l) => l.trim());
      return lines[lines.length - 1] || text.trim();
    }
  }
  return err instanceof Error ? err.message : String(err);
}

function validateName(name: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(
      `Invalid secret name: "${name}". Use only letters, numbers, hyphens, and underscores.`,
    );
  }
}

function validateEmail(email: string): void {
  if (!/^[a-zA-Z0-9._%+@-]+$/.test(email)) {
    throw new Error(`Invalid email address: "${email}"`);
  }
}

// ─── Secret operations ────────────────────────────────────────────────────

export function listSecrets(): Secret[] {
  const output = run(`secrets list --project=${project()} --format=json`);
  const raw = JSON.parse(output) as Array<{
    name: string;
    createTime: string;
    labels?: Record<string, string>;
  }>;
  return raw.map((s) => ({
    name: s.name.split("/").pop() ?? s.name,
    createTime: s.createTime,
    labels: s.labels,
  }));
}

export function getSecretValue(secretName: string): string {
  validateName(secretName);
  return run(
    `secrets versions access latest --secret=${secretName} --project=${project()}`,
  );
}

// Returns true if the secret exists. Returns false on NOT_FOUND.
// Other errors (auth, network) propagate so the caller doesn't silently mis-create.
export function secretExists(name: string): boolean {
  validateName(name);
  try {
    execSync(
      `"${gcloudPath()}" secrets describe ${name} --project=${project()}`,
      {
        encoding: "utf8",
        env: buildEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return true;
  } catch (err: unknown) {
    const stderr = (err as { stderr?: Buffer | string }).stderr;
    const text =
      typeof stderr === "string" ? stderr : (stderr?.toString("utf8") ?? "");
    if (text.includes("NOT_FOUND") || text.includes("was not found")) {
      return false;
    }
    throw err;
  }
}

export function createSecret(name: string, value: string): void {
  validateName(name);
  const bin = gcloudPath();
  withTempFile(value, (tmpPath) => {
    execSync(
      `"${bin}" secrets create ${name} --data-file="${tmpPath}" --project=${project()}`,
      {
        encoding: "utf8",
        env: buildEnv(),
      },
    );
  });
}

export function addSecretVersion(name: string, value: string): void {
  validateName(name);
  const bin = gcloudPath();
  withTempFile(value, (tmpPath) => {
    execSync(
      `"${bin}" secrets versions add ${name} --data-file="${tmpPath}" --project=${project()}`,
      {
        encoding: "utf8",
        env: buildEnv(),
      },
    );
  });
}

export function deleteSecret(name: string): void {
  validateName(name);
  run(`secrets delete ${name} --project=${project()} --quiet`);
}

// ─── IAM operations ───────────────────────────────────────────────────────

export function getIamPolicy(secretName: string): IamBinding[] {
  validateName(secretName);
  const output = run(
    `secrets get-iam-policy ${secretName} --project=${project()} --format=json`,
  );
  const policy = JSON.parse(output) as {
    bindings?: Array<{ role: string; members: string[] }>;
  };

  const bindings: IamBinding[] = [];
  for (const binding of policy.bindings ?? []) {
    for (const member of binding.members) {
      if (!member.includes(":")) continue;
      const [type, email] = member.split(":");
      if (
        type === "user" ||
        type === "group" ||
        type === "serviceAccount" ||
        type === "domain"
      ) {
        bindings.push({ email, role: binding.role, memberType: type });
      }
    }
  }
  return bindings;
}

export function addIamBinding(secretName: string, email: string): void {
  validateName(secretName);
  validateEmail(email);
  const type = memberType(email);
  run(
    `secrets add-iam-policy-binding ${secretName} ` +
      `--member=${type}:${email} ` +
      `--role=${SHARE_ROLE} ` +
      `--project=${project()}`,
  );
}

export function removeIamBinding(
  secretName: string,
  email: string,
  role?: string,
): void {
  validateName(secretName);
  validateEmail(email);
  const type = memberType(email);
  const targetRole = role ?? SHARE_ROLE;
  run(
    `secrets remove-iam-policy-binding ${secretName} ` +
      `--member=${type}:${email} ` +
      `--role=${targetRole} ` +
      `--project=${project()}`,
  );
}
