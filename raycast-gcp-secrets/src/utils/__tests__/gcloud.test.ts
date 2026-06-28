import { execSync } from "child_process";
import {
  listSecrets,
  getSecretValue,
  createSecret,
  addSecretVersion,
  deleteSecret,
  getIamPolicy,
  addIamBinding,
  removeIamBinding,
  mergeSuggestionsAndHistory,
  suggestedRecipients,
} from "../gcloud";

jest.mock("child_process");

const mockExecSync = execSync as jest.MockedFunction<typeof execSync>;

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── listSecrets ───────────────────────────────────────────────────────────

describe("listSecrets", () => {
  it("extracts secret name from full resource path", () => {
    mockExecSync.mockReturnValue(
      JSON.stringify([
        { name: "projects/123/secrets/my-api-key", createTime: "2026-01-01T00:00:00Z" },
        { name: "projects/123/secrets/coda-api-key", createTime: "2026-02-01T00:00:00Z", labels: { env: "prod" } },
      ]) as any
    );
    const result = listSecrets();
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("my-api-key");
    expect(result[0].createTime).toBe("2026-01-01T00:00:00Z");
    expect(result[1].name).toBe("coda-api-key");
    expect(result[1].labels).toEqual({ env: "prod" });
  });

  it("returns empty array when no secrets exist", () => {
    mockExecSync.mockReturnValue("[]" as any);
    expect(listSecrets()).toEqual([]);
  });

  it("calls gcloud with correct project and format args", () => {
    mockExecSync.mockReturnValue("[]" as any);
    listSecrets();
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("secrets list --project=test-project --format=json"),
      expect.any(Object)
    );
  });
});

// ─── getSecretValue ────────────────────────────────────────────────────────

describe("getSecretValue", () => {
  it("returns trimmed secret value", () => {
    mockExecSync.mockReturnValue("super-secret-value\n" as any);
    expect(getSecretValue("my-api-key")).toBe("super-secret-value");
  });

  it("calls gcloud with correct secret name and project", () => {
    mockExecSync.mockReturnValue("val" as any);
    getSecretValue("coda-api-key");
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("secrets versions access latest --secret=coda-api-key --project=test-project"),
      expect.any(Object)
    );
  });
});

// ─── createSecret ──────────────────────────────────────────────────────────

describe("createSecret", () => {
  it("calls gcloud secrets create with correct name and project", () => {
    mockExecSync.mockReturnValue("" as any);
    createSecret("new-key", "my-value");
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("secrets create new-key"),
      expect.any(Object)
    );
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("--project=test-project"),
      expect.any(Object)
    );
  });

  it("quotes the --data-file path so spaces (e.g. Application Support) don't break the command", () => {
    mockExecSync.mockReturnValue("" as any);
    createSecret("new-key", "my-value");
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining('--data-file="'),
      expect.any(Object)
    );
  });
});

// ─── addSecretVersion ──────────────────────────────────────────────────────

describe("addSecretVersion", () => {
  it("calls gcloud secrets versions add with correct secret name", () => {
    mockExecSync.mockReturnValue("" as any);
    addSecretVersion("existing-key", "new-value");
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("secrets versions add existing-key"),
      expect.any(Object)
    );
  });

  it("quotes the --data-file path", () => {
    mockExecSync.mockReturnValue("" as any);
    addSecretVersion("existing-key", "new-value");
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining('--data-file="'),
      expect.any(Object)
    );
  });
});

// ─── deleteSecret ──────────────────────────────────────────────────────────

describe("deleteSecret", () => {
  it("calls gcloud with --quiet flag to avoid interactive prompt", () => {
    mockExecSync.mockReturnValue("" as any);
    deleteSecret("old-key");
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("secrets delete old-key --project=test-project --quiet"),
      expect.any(Object)
    );
  });
});

// ─── getIamPolicy ─────────────────────────────────────────────────────────

describe("getIamPolicy", () => {
  it("parses user bindings into email + role + memberType", () => {
    mockExecSync.mockReturnValue(
      JSON.stringify({
        bindings: [
          {
            role: "roles/secretmanager.admin",
            members: ["user:joel@example.com", "user:mike@example.com"],
          },
        ],
      }) as any
    );
    const result = getIamPolicy("my-key");
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      email: "joel@example.com",
      role: "roles/secretmanager.admin",
      memberType: "user",
    });
    expect(result[1]).toEqual({
      email: "mike@example.com",
      role: "roles/secretmanager.admin",
      memberType: "user",
    });
  });

  it("parses group bindings", () => {
    mockExecSync.mockReturnValue(
      JSON.stringify({
        bindings: [
          {
            role: "roles/secretmanager.admin",
            members: ["group:team-group@example.com"],
          },
        ],
      }) as any
    );
    const result = getIamPolicy("my-key");
    expect(result[0]).toEqual({
      email: "team-group@example.com",
      role: "roles/secretmanager.admin",
      memberType: "group",
    });
  });

  it("returns empty array when no bindings exist", () => {
    mockExecSync.mockReturnValue(JSON.stringify({}) as any);
    expect(getIamPolicy("my-key")).toEqual([]);
  });

  it("includes serviceAccount members", () => {
    mockExecSync.mockReturnValue(
      JSON.stringify({
        bindings: [
          {
            role: "roles/secretmanager.admin",
            members: ["serviceAccount:robot@project.iam.gserviceaccount.com"],
          },
        ],
      }) as any
    );
    const result = getIamPolicy("my-key");
    expect(result[0].email).toBe("robot@project.iam.gserviceaccount.com");
    expect(result[0].memberType).toBe("serviceAccount");
  });
});

// ─── addIamBinding ────────────────────────────────────────────────────────

describe("addIamBinding", () => {
  it("uses user: prefix and admin role for individual emails", () => {
    mockExecSync.mockReturnValue("" as any);
    addIamBinding("my-key", "joel@example.com");
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("--member=user:joel@example.com"),
      expect.any(Object)
    );
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("--role=roles/secretmanager.admin"),
      expect.any(Object)
    );
  });

  it("uses group: prefix for emails listed in the Share Groups preference", () => {
    mockExecSync.mockReturnValue("" as any);
    addIamBinding("my-key", "team-group@example.com");
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("--member=group:team-group@example.com"),
      expect.any(Object)
    );
  });
});

// ─── removeIamBinding ─────────────────────────────────────────────────────

describe("removeIamBinding", () => {
  it("uses user: prefix and default admin role when no role specified", () => {
    mockExecSync.mockReturnValue("" as any);
    removeIamBinding("my-key", "joel@example.com");
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("remove-iam-policy-binding my-key"),
      expect.any(Object)
    );
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("--member=user:joel@example.com"),
      expect.any(Object)
    );
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("--role=roles/secretmanager.admin"),
      expect.any(Object)
    );
  });

  it("respects role argument when removing legacy bindings", () => {
    mockExecSync.mockReturnValue("" as any);
    removeIamBinding("my-key", "joel@example.com", "roles/secretmanager.secretAccessor");
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("--role=roles/secretmanager.secretAccessor"),
      expect.any(Object)
    );
  });

  it("uses group: prefix when removing an email listed in Share Groups", () => {
    mockExecSync.mockReturnValue("" as any);
    removeIamBinding("my-key", "team-group@example.com");
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("--member=group:team-group@example.com"),
      expect.any(Object)
    );
  });
});

// ─── mergeSuggestionsAndHistory ───────────────────────────────────────────

describe("mergeSuggestionsAndHistory", () => {
  it("puts suggestions first, then history", () => {
    const result = mergeSuggestionsAndHistory(["joel@example.com", "heather@example.com"]);
    expect(result[0]).toBe("team-group@example.com");
    expect(result.slice(1)).toEqual(["joel@example.com", "heather@example.com"]);
  });

  it("dedupes case-insensitively", () => {
    const result = mergeSuggestionsAndHistory(["Team-Group@example.com", "joel@example.com"]);
    expect(result).toHaveLength(2);
    expect(result).toEqual(["team-group@example.com", "joel@example.com"]);
  });

  it("returns suggestions when history is empty", () => {
    expect(mergeSuggestionsAndHistory([])).toEqual([...suggestedRecipients()]);
  });
});
