import {
  List,
  ActionPanel,
  Action,
  showToast,
  Toast,
  Alert,
  confirmAlert,
} from "@raycast/api";
import { useState, useEffect } from "react";
import {
  getIamPolicy,
  removeIamBinding,
  extractGcloudError,
  IamBinding,
} from "../utils/gcloud";

export function AccessList({ secretName }: { secretName: string }) {
  const [bindings, setBindings] = useState<IamBinding[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  function loadPolicy() {
    setIsLoading(true);
    try {
      setBindings(getIamPolicy(secretName));
    } catch (err) {
      showToast({
        style: Toast.Style.Failure,
        title: "Failed to load access list",
        message: extractGcloudError(err),
      });
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    loadPolicy();
  }, []);

  async function removeAccess(binding: IamBinding) {
    const confirmed = await confirmAlert({
      title: `Remove access for ${binding.email}?`,
      message: `They will no longer be able to read "${secretName}".`,
      primaryAction: {
        title: "Remove Access",
        style: Alert.ActionStyle.Destructive,
      },
    });
    if (!confirmed) return;
    try {
      removeIamBinding(secretName, binding.email, binding.role);
      showToast({
        style: Toast.Style.Success,
        title: `Removed access for ${binding.email}`,
      });
      loadPolicy();
    } catch (err) {
      showToast({
        style: Toast.Style.Failure,
        title: "Failed to remove access",
        message: extractGcloudError(err),
      });
    }
  }

  const roleLabel = (role: string) =>
    role
      .replace("roles/secretmanager.", "")
      .replace(/([A-Z])/g, " $1")
      .trim();

  return (
    <List
      isLoading={isLoading}
      navigationTitle={`Access: ${secretName}`}
      searchBarPlaceholder="Search by email..."
    >
      {!isLoading && bindings.length === 0 && (
        <List.EmptyView
          title="No shared access"
          description="Only you (project owner) have access to this secret."
        />
      )}
      {bindings.map((b) => (
        <List.Item
          key={`${b.email}:${b.role}`}
          title={b.email}
          subtitle={roleLabel(b.role)}
          actions={
            <ActionPanel>
              <Action
                title="Remove Access"
                onAction={() => removeAccess(b)}
                style={Action.Style.Destructive}
              />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
