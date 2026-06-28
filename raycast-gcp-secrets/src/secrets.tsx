import {
  List,
  ActionPanel,
  Action,
  showToast,
  Toast,
  Alert,
  confirmAlert,
  Clipboard,
  useNavigation,
  Detail,
  Form,
  Icon,
} from "@raycast/api";
import { useState, useEffect } from "react";
import {
  listSecrets,
  getSecretValue,
  deleteSecret,
  addSecretVersion,
  addIamBinding,
  getIamPolicy,
  extractGcloudError,
  suggestedRecipients,
  mergeSuggestionsAndHistory,
  Secret,
  IamBinding,
} from "./utils/gcloud";
import { getEmailHistory, addEmailsToHistory } from "./utils/emailHistory";
import { AccessList } from "./components/AccessList";

// ─── Main command ─────────────────────────────────────────────────────────

export default function SecretsCommand() {
  const [secrets, setSecrets] = useState<Secret[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  function loadSecrets() {
    setIsLoading(true);
    try {
      setSecrets(listSecrets());
    } catch (err) {
      showToast({
        style: Toast.Style.Failure,
        title: "Failed to load secrets",
        message: extractGcloudError(err),
      });
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    loadSecrets();
  }, []);

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search secrets...">
      {secrets.map((secret) => (
        <SecretListItem
          key={secret.name}
          secret={secret}
          onRefresh={loadSecrets}
        />
      ))}
    </List>
  );
}

// ─── List item ────────────────────────────────────────────────────────────

function SecretListItem({
  secret,
  onRefresh,
}: {
  secret: Secret;
  onRefresh: () => void;
}) {
  const { push } = useNavigation();
  const date = new Date(secret.createTime).toLocaleDateString();

  async function copyValue() {
    try {
      const value = getSecretValue(secret.name);
      await Clipboard.copy(value);
      showToast({ style: Toast.Style.Success, title: "Copied to clipboard" });
    } catch (err) {
      showToast({
        style: Toast.Style.Failure,
        title: "Failed to copy",
        message: extractGcloudError(err),
      });
    }
  }

  function openDetail() {
    push(<SecretDetail secretName={secret.name} onRefresh={onRefresh} />);
  }

  function editValue() {
    push(<EditForm secretName={secret.name} onDone={onRefresh} />);
  }

  function shareSecret() {
    push(<ShareForm secretName={secret.name} />);
  }

  function viewAccess() {
    push(<AccessList secretName={secret.name} />);
  }

  async function deleteThisSecret() {
    const confirmed = await confirmAlert({
      title: `Delete "${secret.name}"?`,
      message:
        "This permanently deletes the secret and all its versions. This cannot be undone.",
      primaryAction: { title: "Delete", style: Alert.ActionStyle.Destructive },
    });
    if (!confirmed) return;
    try {
      deleteSecret(secret.name);
      showToast({ style: Toast.Style.Success, title: "Secret deleted" });
      onRefresh();
    } catch (err) {
      showToast({
        style: Toast.Style.Failure,
        title: "Delete failed",
        message: extractGcloudError(err),
      });
    }
  }

  return (
    <List.Item
      title={secret.name}
      subtitle={`Created ${date}`}
      actions={
        <ActionPanel>
          <ActionPanel.Section>
            <Action title="View Secret" icon={Icon.Eye} onAction={openDetail} />
            <Action
              title="Copy Value"
              icon={Icon.Clipboard}
              onAction={copyValue}
            />
          </ActionPanel.Section>
          <ActionPanel.Section>
            <Action
              title="Share Secret"
              icon={Icon.AddPerson}
              onAction={shareSecret}
              shortcut={{ modifiers: ["cmd"], key: "s" }}
            />
            <Action
              title="Edit Value"
              icon={Icon.Pencil}
              onAction={editValue}
              shortcut={{ modifiers: ["cmd"], key: "e" }}
            />
            <Action
              title="View Access"
              icon={Icon.TwoPeople}
              onAction={viewAccess}
              shortcut={{ modifiers: ["cmd"], key: "i" }}
            />
          </ActionPanel.Section>
          <ActionPanel.Section>
            <Action
              title="Delete Secret"
              onAction={deleteThisSecret}
              shortcut={{ modifiers: ["cmd", "opt"], key: "delete" }}
              style={Action.Style.Destructive}
            />
          </ActionPanel.Section>
        </ActionPanel>
      }
    />
  );
}

// ─── Secret detail view (drill-down on Enter) ────────────────────────────

function SecretDetail({
  secretName,
  onRefresh,
}: {
  secretName: string;
  onRefresh: () => void;
}) {
  const { push } = useNavigation();
  const [value, setValue] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [bindings, setBindings] = useState<IamBinding[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    try {
      setValue(getSecretValue(secretName));
    } catch (err) {
      showToast({
        style: Toast.Style.Failure,
        title: "Failed to load value",
        message: extractGcloudError(err),
      });
    }
    try {
      setBindings(getIamPolicy(secretName));
    } catch {
      // non-critical — just won't show access info
    }
    setIsLoading(false);
  }, []);

  const display =
    value === null ? "" : revealed ? value : value.replace(/./g, "\u2022");

  const accessSection =
    bindings.length > 0
      ? `\n\n---\n\n### Shared with\n\n${bindings.map((b) => `- **${b.email}** _(${b.role.split("/").pop()})_`).join("\n")}`
      : "\n\n---\n\n_Not shared with anyone._";

  return (
    <Detail
      navigationTitle={secretName}
      isLoading={isLoading}
      markdown={`# ${secretName}\n\n\`\`\`\n${display}\n\`\`\`${accessSection}`}
      actions={
        <ActionPanel>
          <ActionPanel.Section>
            <Action
              title={revealed ? "Hide Value" : "Reveal Value"}
              icon={revealed ? Icon.EyeDisabled : Icon.Eye}
              onAction={() => setRevealed((r) => !r)}
            />
            <Action
              title="Copy to Clipboard"
              icon={Icon.Clipboard}
              shortcut={{ modifiers: ["cmd"], key: "c" }}
              onAction={async () => {
                if (value !== null) {
                  await Clipboard.copy(value);
                  showToast({ style: Toast.Style.Success, title: "Copied" });
                }
              }}
            />
          </ActionPanel.Section>
          <ActionPanel.Section>
            <Action
              title="Share Secret"
              icon={Icon.AddPerson}
              shortcut={{ modifiers: ["cmd"], key: "s" }}
              onAction={() => push(<ShareForm secretName={secretName} />)}
            />
            <Action
              title="Edit Value"
              icon={Icon.Pencil}
              shortcut={{ modifiers: ["cmd"], key: "e" }}
              onAction={() =>
                push(<EditForm secretName={secretName} onDone={onRefresh} />)
              }
            />
            <Action
              title="View Access"
              icon={Icon.TwoPeople}
              shortcut={{ modifiers: ["cmd"], key: "i" }}
              onAction={() => push(<AccessList secretName={secretName} />)}
            />
          </ActionPanel.Section>
        </ActionPanel>
      }
    />
  );
}

// ─── Edit value form ──────────────────────────────────────────────────────

function EditForm({
  secretName,
  onDone,
}: {
  secretName: string;
  onDone: () => void;
}) {
  const { pop } = useNavigation();

  function handleSubmit(values: { value: string }) {
    try {
      addSecretVersion(secretName, values.value);
      showToast({ style: Toast.Style.Success, title: "New version saved" });
      pop();
      onDone();
    } catch (err) {
      showToast({
        style: Toast.Style.Failure,
        title: "Failed to update",
        message: extractGcloudError(err),
      });
    }
  }

  return (
    <Form
      navigationTitle={`Edit: ${secretName}`}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Save New Version" onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.PasswordField
        id="value"
        title="New Value"
        placeholder="Enter replacement secret value"
      />
    </Form>
  );
}

// ─── Share secret form (multi-email with history + current access) ───────

function ShareForm({ secretName }: { secretName: string }) {
  const { pop } = useNavigation();
  const [knownEmails, setKnownEmails] = useState<string[]>([]);
  const [currentAccess, setCurrentAccess] = useState<IamBinding[]>([]);
  const [newEmail, setNewEmail] = useState("");
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const [history, bindings] = await Promise.all([
          getEmailHistory(),
          Promise.resolve(getIamPolicy(secretName)),
        ]);
        setKnownEmails(mergeSuggestionsAndHistory(history));
        setCurrentAccess(bindings);
      } catch {
        try {
          setKnownEmails(mergeSuggestionsAndHistory(await getEmailHistory()));
        } catch {
          setKnownEmails([...suggestedRecipients()]);
        }
      } finally {
        setIsLoading(false);
      }
    })();
  }, []);

  // Filter out emails that already have access
  const alreadyShared = new Set(
    currentAccess.map((b) => b.email.toLowerCase()),
  );
  const availableEmails = knownEmails.filter(
    (e) => !alreadyShared.has(e.toLowerCase()),
  );

  async function handleSubmit(values: { selectedEmails: string[] }) {
    const emails: string[] = [...values.selectedEmails];

    // Add any manually typed new email
    const typed = newEmail.trim().toLowerCase();
    if (typed && !emails.includes(typed)) {
      emails.push(typed);
    }

    if (emails.length === 0) {
      showToast({ style: Toast.Style.Failure, title: "No emails specified" });
      return;
    }

    const succeeded: string[] = [];
    const failed: string[] = [];

    for (const email of emails) {
      try {
        addIamBinding(secretName, email);
        succeeded.push(email);
      } catch (err) {
        failed.push(`${email}: ${extractGcloudError(err)}`);
      }
    }

    // Save all emails to history for future autocomplete
    await addEmailsToHistory(emails);

    if (failed.length === 0) {
      showToast({
        style: Toast.Style.Success,
        title: `Shared with ${succeeded.length} ${succeeded.length === 1 ? "person" : "people"}`,
        message: succeeded.join(", "),
      });
    } else {
      showToast({
        style: Toast.Style.Failure,
        title: `${succeeded.length} shared, ${failed.length} failed`,
        message: failed.join("; "),
      });
    }
    pop();
  }

  return (
    <Form
      navigationTitle={`Share: ${secretName}`}
      isLoading={isLoading}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Grant Access" onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      {currentAccess.length > 0 && (
        <Form.Description
          title="Already Shared With"
          text={currentAccess.map((b) => b.email).join(", ")}
        />
      )}
      {currentAccess.length > 0 && <Form.Separator />}

      {availableEmails.length > 0 && (
        <Form.TagPicker
          id="selectedEmails"
          title="Select Recipients"
          info="Pick from previously used emails"
        >
          {availableEmails.map((email) => (
            <Form.TagPicker.Item key={email} value={email} title={email} />
          ))}
        </Form.TagPicker>
      )}
      {availableEmails.length === 0 && (
        <Form.TagPicker id="selectedEmails" title="Select Recipients">
          {[]}
        </Form.TagPicker>
      )}

      <Form.TextField
        id="newEmail"
        title="Add New Email"
        placeholder="user@example.com"
        info="Type a new email not in the list above"
        value={newEmail}
        onChange={setNewEmail}
      />
    </Form>
  );
}
