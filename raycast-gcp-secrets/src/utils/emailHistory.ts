import { LocalStorage } from "@raycast/api";

const STORAGE_KEY = "email-history";

export async function getEmailHistory(): Promise<string[]> {
  const raw = await LocalStorage.getItem<string>(STORAGE_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as string[];
  } catch {
    return [];
  }
}

export async function addEmailsToHistory(emails: string[]): Promise<void> {
  const existing = await getEmailHistory();
  const set = new Set(existing);
  for (const e of emails) {
    const trimmed = e.trim().toLowerCase();
    if (trimmed) set.add(trimmed);
  }
  await LocalStorage.setItem(STORAGE_KEY, JSON.stringify([...set].sort()));
}
