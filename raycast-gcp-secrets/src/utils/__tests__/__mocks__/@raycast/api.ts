export const getPreferenceValues = jest.fn(() => ({
  gcloudPath: "/fake/gcloud",
  gcpProject: "test-project",
  shareGroups: "team-group@example.com",
}));

export const environment = {
  supportPath: "/tmp/raycast-gcp-secrets-test",
};

export const LocalStorage = {
  getItem: jest.fn(),
  setItem: jest.fn(),
};
