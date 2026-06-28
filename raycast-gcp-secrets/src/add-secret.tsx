import {
  Form,
  ActionPanel,
  Action,
  showToast,
  Toast,
  useNavigation,
  confirmAlert,
  Alert,
} from "@raycast/api";
import { useState, useEffect } from "react";
import {
  createSecret,
  addSecretVersion,
  secretExists,
  addIamBinding,
  extractGcloudError,
  suggestedRecipients,
  mergeSuggestionsAndHistory,
} from "./utils/gcloud";
import { getEmailHistory, addEmailsToHistory } from "./utils/emailHistory";

export default function AddSecretCommand() {
  const { pop } = useNavigation();
  const [knownEmails, setKnownEmails] = useState<string[]>([
    ...suggestedRecipients(),
  ]);
  const [newEmail, setNewEmail] = useState("");

  useEffect(() => {
    getEmailHistory()
      .then((history) => setKnownEmails(mergeSuggestionsAndHistory(history)))
      .catch(() => {});
  }, []);

  async function handleSubmit(values: {
    name: string;
    value: string;
    selectedEmails: string[];
  }) {
    const name = values.name.trim();

    if (!name) {
      showToast({
        style: Toast.Style.Failure,
        title: "Secret name is required",
      });
      return;
    }
    if (!values.value) {
      showToast({
        style: Toast.Style.Failure,
        title: "Secret value is required",
      });
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      showToast({
        style: Toast.Style.Failure,
        title: "Invalid name",
        message: "Use only letters, numbers, hyphens, and underscores",
      });
      return;
    }

    let exists: boolean;
    try {
      exists = secretExists(name);
    } catch (err) {
      showToast({
        style: Toast.Style.Failure,
        title: "Couldn't check if secret exists",
        message: extractGcloudError(err),
      });
      return;
    }

    if (exists) {
      const confirmed = await confirmAlert({
        title: `"${name}" already exists`,
        message:
          "Add a new version with this value? The previous version will still be accessible by version number, " +
          "and 'latest' will return your new value.",
        primaryAction: {
          title: "Add New Version",
          style: Alert.ActionStyle.Default,
        },
        dismissAction: { title: "Cancel" },
      });
      if (!confirmed) return;
      try {
        addSecretVersion(name, values.value);
      } catch (err) {
        showToast({
          style: Toast.Style.Failure,
          title: "Failed to add new version",
          message: extractGcloudError(err),
        });
        return;
      }
    } else {
      try {
        createSecret(name, values.value);
      } catch (err) {
        showToast({
          style: Toast.Style.Failure,
          title: "Failed to create secret",
          message: extractGcloudError(err),
        });
        return;
      }
    }

    // Collect all emails to share with
    const emails: string[] = [...values.selectedEmails];
    const typed = newEmail.trim().toLowerCase();
    if (typed && !emails.includes(typed)) {
      emails.push(typed);
    }

    if (emails.length > 0) {
      await addEmailsToHistory(emails);
      const failed: string[] = [];
      for (const email of emails) {
        try {
          addIamBinding(name, email);
        } catch (err) {
          failed.push(`${email}: ${extractGcloudError(err)}`);
        }
      }
      if (failed.length > 0) {
        showToast({
          style: Toast.Style.Failure,
          title: exists
            ? "Version added, but some shares failed"
            : "Secret created, but some shares failed",
          message: failed.join("; "),
        });
        pop();
        return;
      }
    }

    showToast({
      style: Toast.Style.Success,
      title: exists ? "New version added" : "Secret created",
      message:
        emails.length > 0 ? `Shared with ${emails.join(", ")}` : undefined,
    });
    pop();
  }

  return (
    <Form
      navigationTitle="Add Secret"
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Create Secret" onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="name"
        title="Secret Name"
        placeholder="my-api-key"
        info="Letters, numbers, hyphens, and underscores only"
      />
      <Form.PasswordField
        id="value"
        title="Value"
        placeholder="Enter the secret value"
      />
      <Form.Separator />
      {knownEmails.length > 0 ? (
        <Form.TagPicker
          id="selectedEmails"
          title="Share With"
          info="Pick from previously used emails"
        >
          {knownEmails.map((email) => (
            <Form.TagPicker.Item key={email} value={email} title={email} />
          ))}
        </Form.TagPicker>
      ) : (
        <Form.TagPicker id="selectedEmails" title="Share With">
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
