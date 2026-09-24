/** Every user-visible string in the switcher. Override any subset via the `labels` prop. */
export interface Labels {
  title: string;
  addAccount: string;
  refresh: string;
  noAccounts: string;
  loading: string;
  // lanes
  laneCli: string;
  laneApiKey: string;
  laneOauth: string;
  laneCliHelp: string;
  laneApiKeyHelp: string;
  laneOauthHelp: string;
  // status
  statusActive: string;
  statusReady: string;
  statusParked: string;
  statusResetsIn: string;
  statusNeedsLogin: string;
  statusOff: string;
  statusChecking: string;
  statusSigningIn: string;
  // row actions
  useThis: string;
  inUse: string;
  moveUp: string;
  moveDown: string;
  enabled: string;
  more: string;
  logIn: string;
  logInTerminal: string;
  logOut: string;
  setApiKey: string;
  tryAgainNow: string;
  remove: string;
  confirmRemove: string;
  cancel: string;
  save: string;
  copy: string;
  copied: string;
  rename: string;
  usage: string;
  // add flow
  addStepProvider: string;
  addStepLane: string;
  addStepDetails: string;
  addTitleLabel: string;
  addModelLabel: string;
  addApiKeyLabel: string;
  addBaseUrlLabel: string;
  addBaseUrlHelp: string;
  create: string;
  back: string;
  // existing logins
  foundOnComputer: string;
  foundOnComputerHelp: string;
  useExistingLogin: string;
  existingLogin: string;
  confirmLogoutAdopted: string;
  // login panel
  loginWaiting: string;
  loginOpenUrl: string;
  loginCode: string;
  loginOpenTerminal: string;
  loginRunThis: string;
  loginDone: string;
  loginFailed: string;
  loginRetry: string;
  loginOutput: string;
  // banners
  exhausted: string;
  exhaustedReset: string;
  dismiss: string;
  errorPrefix: string;
  apiKeySaved: string;
  // usage panel
  usageShow: string;
  usageTitle: string;
  usageLoading: string;
  usageEmpty: string;
  usageWindow5h: string;
  usageWindow24h: string;
  usageWindow7d: string;
  usageRequests: string;
  usageTokens: string;
  usageParks: string;
  usageNoParks: string;
  usageEstimate: string;
  usageEstimateRough: string;
}

export const defaultLabels: Labels = {
  title: 'Accounts',
  addAccount: 'Add account',
  refresh: 'Refresh',
  noAccounts: 'No accounts yet. Add one to get started.',
  loading: 'Loading accounts…',
  laneCli: 'Subscription',
  laneApiKey: 'API key',
  laneOauth: 'OAuth',
  laneCliHelp:
    "Uses the vendor's official CLI. You sign in with your browser; nothing is stored by this app.",
  laneApiKeyHelp: 'Pay-as-you-go key, stored encrypted on this device.',
  laneOauthHelp: 'Provided by a plug-in.',
  statusActive: 'Active',
  statusReady: 'Ready',
  statusParked: 'Parked',
  statusResetsIn: 'resets in',
  statusNeedsLogin: 'Needs login',
  statusOff: 'Off',
  statusChecking: 'Checking…',
  statusSigningIn: 'Signing in…',
  useThis: 'Use this',
  inUse: 'In use',
  moveUp: 'Move up',
  moveDown: 'Move down',
  enabled: 'Enabled',
  more: 'More actions',
  logIn: 'Log in',
  logInTerminal: 'Log in in terminal',
  logOut: 'Log out',
  setApiKey: 'Set API key',
  tryAgainNow: 'Try again now',
  remove: 'Remove',
  confirmRemove: 'Remove this account?',
  cancel: 'Cancel',
  save: 'Save',
  copy: 'Copy',
  copied: 'Copied',
  rename: 'Rename',
  usage: 'Usage',
  addStepProvider: 'Which provider?',
  addStepLane: 'How does this account sign in?',
  addStepDetails: 'Name it',
  addTitleLabel: 'Title',
  addModelLabel: 'Default model (optional)',
  addApiKeyLabel: 'API key',
  addBaseUrlLabel: 'Base URL',
  addBaseUrlHelp: 'The /v1 endpoint of an OpenAI-compatible server.',
  create: 'Create',
  back: 'Back',
  foundOnComputer: 'Found on this computer',
  foundOnComputerHelp: 'Already signed in with the official CLI. Use it as-is: no second login.',
  useExistingLogin: 'Use this account',
  existingLogin: 'Existing login',
  confirmLogoutAdopted:
    'This is your existing CLI login. Logging out here signs that CLI out on this computer too.',
  loginWaiting: 'Waiting for the sign-in to finish…',
  loginOpenUrl: 'Open this link to sign in',
  loginCode: 'Enter this code',
  loginOpenTerminal: 'Open in terminal instead',
  loginRunThis: 'Run this in a terminal:',
  loginDone: 'Signed in',
  loginFailed: 'Sign-in did not complete',
  loginRetry: 'Try again',
  loginOutput: 'Show output',
  exhausted: 'All {provider} accounts are parked.',
  exhaustedReset: 'Earliest reset {time}.',
  dismiss: 'Dismiss',
  errorPrefix: 'Something went wrong',
  apiKeySaved: 'API key saved.',
  usageShow: 'Usage',
  usageTitle: 'Usage',
  usageLoading: 'Loading usage…',
  usageEmpty: 'No usage recorded yet.',
  usageWindow5h: '5h',
  usageWindow24h: '24h',
  usageWindow7d: '7d',
  usageRequests: '{count} requests in the last {window}',
  usageTokens: 'This week: {input} tokens in · {output} out',
  usageParks: 'Parked {count}× this week',
  usageNoParks: 'Not parked this week',
  usageEstimate: 'About {minutes} min left at this pace',
  usageEstimateRough: 'rough estimate',
};

export function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '');
}
