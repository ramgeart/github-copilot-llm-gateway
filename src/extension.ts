import * as vscode from 'vscode';
import { GatewayProvider, RequestStateEvent } from './provider';
import {
  StatusBarState,
  TokenUsage,
  extractHost,
  renderStatusBar,
} from './statusBarController';
import { StatusSnapshot } from './statusSnapshot';
import { renderStatusTooltipHtml } from './statusTooltip';

const STATUS_BAR_PROBE_DELAY_MS = 1500;
/** How long the "responded" pulse stays in the bar before reverting to idle. */
const RESPONDED_DISPLAY_MS = 10_000;

/**
 * Drives the LLM Gateway status bar. Pure rendering lives in
 * `statusBarController.ts`; this class only handles the VS Code-side state
 * machine: timers, in-flight counting, mapping events onto state transitions.
 */
class StatusBarManager implements vscode.Disposable {
  private state: StatusBarState;
  private respondedRevertTimer?: NodeJS.Timeout;
  private activeRequestCount = 0;
  private cachedIdle: { host: string; modelIds: readonly string[] } = {
    host: '',
    modelIds: [],
  };

  constructor(
    private readonly item: vscode.StatusBarItem,
    private readonly getServerUrl: () => string,
    private readonly getSnapshot: () => StatusSnapshot
  ) {
    this.state = { kind: 'probing', host: extractHost(this.getServerUrl()) };
    this.render();
  }

  /**
   * Called from outside whenever the provider's snapshot changes (session
   * totals, last request, models, connection state). The tooltip is rebuilt
   * from the snapshot, so any new data shows up the next time the user hovers
   * the status bar — even if the bar's icon state hasn't changed.
   */
  refreshTooltip(): void {
    this.render();
  }

  dispose(): void {
    this.cancelRespondedRevert();
  }

  setIdle(modelIds: readonly string[]): void {
    this.cachedIdle = { host: this.host(), modelIds };
    this.cancelRespondedRevert();
    this.applyIdle();
  }

  setNoModels(): void {
    this.cancelRespondedRevert();
    this.state = { kind: 'noModels', host: this.host() };
    this.render();
  }

  setError(errorMessage: string): void {
    this.cancelRespondedRevert();
    this.state = { kind: 'error', host: this.host(), errorMessage };
    this.render();
  }

  onRequest(event: RequestStateEvent): void {
    switch (event.kind) {
      case 'start':
        this.onRequestStart(event);
        return;
      case 'complete':
        this.onRequestComplete(event);
        return;
      case 'error':
        this.onRequestError(event);
        return;
      default: {
        const _never: never = event;
        throw new Error(`Unexpected request state kind: ${String(_never)}`);
      }
    }
  }

  private onRequestStart(event: Extract<RequestStateEvent, { kind: 'start' }>): void {
    this.cancelRespondedRevert();
    this.activeRequestCount++;
    this.state = {
      kind: 'streaming',
      host: this.host(),
      modelId: event.modelId,
      modelName: event.modelName,
      activeCount: this.activeRequestCount,
    };
    this.render();
  }

  private onRequestComplete(
    event: Extract<RequestStateEvent, { kind: 'complete' }>
  ): void {
    this.activeRequestCount = Math.max(0, this.activeRequestCount - 1);
    if (this.activeRequestCount > 0) {
      // Other requests still streaming — keep the bar in streaming state with
      // an updated count rather than briefly flashing "responded".
      this.state = {
        kind: 'streaming',
        host: this.host(),
        modelId: event.modelId,
        modelName: event.modelName,
        activeCount: this.activeRequestCount,
      };
      this.render();
      return;
    }
    this.state = {
      kind: 'responded',
      host: this.host(),
      modelId: event.modelId,
      modelName: event.modelName,
      ...(event.usage ? { usage: this.toUsage(event.usage) } : {}),
    };
    this.render();
    this.scheduleRespondedRevert();
  }

  private onRequestError(event: Extract<RequestStateEvent, { kind: 'error' }>): void {
    this.activeRequestCount = Math.max(0, this.activeRequestCount - 1);
    this.setError(event.errorMessage);
  }

  private toUsage(usage: TokenUsage): TokenUsage {
    return { prompt: usage.prompt, completion: usage.completion, total: usage.total };
  }

  private applyIdle(): void {
    this.state = {
      kind: 'idle',
      host: this.cachedIdle.host,
      modelCount: this.cachedIdle.modelIds.length,
      modelIds: this.cachedIdle.modelIds,
    };
    this.render();
  }

  private scheduleRespondedRevert(): void {
    this.cancelRespondedRevert();
    this.respondedRevertTimer = setTimeout(() => {
      this.respondedRevertTimer = undefined;
      this.applyIdle();
    }, RESPONDED_DISPLAY_MS);
  }

  private cancelRespondedRevert(): void {
    if (this.respondedRevertTimer) {
      clearTimeout(this.respondedRevertTimer);
      this.respondedRevertTimer = undefined;
    }
  }

  private host(): string {
    return extractHost(this.getServerUrl());
  }

  private render(): void {
    // Bar text stays minimal (vm-active/vm-disconnect + host) — that's the
    // "is the gateway up" signal. All the rich data goes into the hover
    // tooltip, which is the closest stable-API approximation to GHCP's
    // floating popup (`chatStatusItem` is proposed-API-only).
    const { text } = renderStatusBar(this.state);
    this.item.text = text;
    // Tooltip renders as the GHCP-style popup: HTML card with theme icons,
    // section headers, and command-link buttons. MarkdownString runs the value
    // through VS Code's hover renderer, which is the closest stable-API path
    // to a click-triggered floating popup (`chatStatusItem` is proposed-only).
    const tooltipHtml = renderStatusTooltipHtml(this.getSnapshot());
    const md = new vscode.MarkdownString(tooltipHtml);
    md.isTrusted = true;
    md.supportThemeIcons = true;
    md.supportHtml = true;
    this.item.tooltip = md;
  }
}

/**
 * Extension activation. Async so we can pull the API key + custom headers
 * out of SecretStorage (and migrate legacy plain-text settings, issue #28)
 * before registering the provider — otherwise the first model fetch races
 * the secret load and is sent unauthenticated.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const suffixes = ['', '2', '3', '4', '5'];
  for (const suffix of suffixes) {
    await activateProvider(context, suffix);
  }
}

async function activateProvider(context: vscode.ExtensionContext, suffix: string): Promise<void> {
  const providerId = `copilot-llm-gateway${suffix ? `-${suffix}` : ''}`;
  const provider = new GatewayProvider(context, suffix);
  await provider.loadSecrets();

  const disposable = vscode.lm.registerLanguageModelChatProvider(
    providerId,
    provider
  );
  context.subscriptions.push(disposable);

  const configSection = `github.copilot.llm-gateway${suffix ? `-${suffix}` : ''}`;
  const commandPrefix = `github.copilot.llm-gateway${suffix ? `-${suffix}` : ''}`;

  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBar.name = `LLM Gateway ${suffix || '1'}`;
  statusBar.command = `${commandPrefix}.refreshModels`;
  
  if (suffix === '') {
    statusBar.show();
  } else {
    // Show only if configured with non-default serverUrl or apiKey
    const config = vscode.workspace.getConfiguration(configSection);
    const serverUrl = config.get<string>('serverUrl', '');
    if (serverUrl && serverUrl !== 'http://localhost:8000') {
      statusBar.show();
    }
  }
  context.subscriptions.push(statusBar);

  const statusManager = new StatusBarManager(
    statusBar,
    () =>
      vscode.workspace
        .getConfiguration(configSection)
        .get<string>('serverUrl', 'http://localhost:8000'),
    () => provider.getStatusSnapshot()
  );
  context.subscriptions.push(statusManager);

  context.subscriptions.push(
    provider.onDidChangeRequestState((event) => statusManager.onRequest(event))
  );

  context.subscriptions.push(
    provider.onDidChangeStatusSnapshot(() => {
      // If configured later, show status bar
      if (suffix !== '') {
        const config = vscode.workspace.getConfiguration(configSection);
        const serverUrl = config.get<string>('serverUrl', '');
        if (serverUrl && serverUrl !== 'http://localhost:8000') {
          statusBar.show();
        }
      }
      statusManager.refreshTooltip();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(`${commandPrefix}.showOutput`, () =>
      provider.showOutput()
    )
  );

  const refreshStatusBar = async (): Promise<void> => {
    const cts = new vscode.CancellationTokenSource();
    try {
      const models = await provider.provideLanguageModelChatInformation(
        { silent: true },
        cts.token
      );
      if (models.length > 0) {
        statusManager.setIdle(models.map((m) => m.id));
        if (suffix !== '') {
          statusBar.show();
        }
      } else {
        statusManager.setNoModels();
      }
    } catch (error) {
      statusManager.setError(error instanceof Error ? error.message : String(error));
    } finally {
      cts.dispose();
    }
  };

  const initialProbeTimer = setTimeout(() => {
    void refreshStatusBar();
  }, STATUS_BAR_PROBE_DELAY_MS);
  context.subscriptions.push({ dispose: () => clearTimeout(initialProbeTimer) });

  const testCommand = vscode.commands.registerCommand(
    `${commandPrefix}.testConnection`,
    async () => {
      const cts = new vscode.CancellationTokenSource();
      try {
        const models = await provider.provideLanguageModelChatInformation(
          { silent: false },
          cts.token
        );

        if (models.length > 0) {
          statusManager.setIdle(models.map((m) => m.id));
          if (suffix !== '') {
            statusBar.show();
          }
          vscode.window.showInformationMessage(
            `LLM Gateway ${suffix || '1'}: Successfully connected! Found ${models.length} model(s): ${models.map((m) => m.name).join(', ')}`
          );
        } else {
          statusManager.setNoModels();
          vscode.window.showWarningMessage(
            `LLM Gateway ${suffix || '1'}: Connected but no models found.`
          );
        }
      } catch (error) {
        statusManager.setError(error instanceof Error ? error.message : String(error));
        vscode.window.showErrorMessage(
          `LLM Gateway ${suffix || '1'}: Connection test failed. ${error instanceof Error ? error.message : String(error)}`
        );
      } finally {
        cts.dispose();
      }
    }
  );
  context.subscriptions.push(testCommand);

  const manageCommand = vscode.commands.registerCommand(
    `${commandPrefix}.manage`,
    async () => {
      const config = vscode.workspace.getConfiguration(configSection);
      const currentUrl = config.get<string>('serverUrl', 'http://localhost:8000');

      const url = await vscode.window.showInputBox({
        title: `LLM Gateway ${suffix || '1'} — Server URL`,
        prompt: 'Enter the inference server URL (OpenAI-compatible endpoint)',
        value: currentUrl,
        placeHolder: 'http://localhost:8000',
        ignoreFocusOut: true,
        validateInput: (value) => {
          try {
            new URL(value);
            return undefined;
          } catch {
            return 'Please enter a valid URL';
          }
        },
      });
      if (url === undefined) { return; }

      const apiKey = await vscode.window.showInputBox({
        title: `LLM Gateway ${suffix || '1'} — API Key`,
        prompt: 'Enter the API key — saved to VS Code\'s secret storage. Leave empty to clear.',
        password: true,
        placeHolder: 'Optional',
        ignoreFocusOut: true,
      });
      if (apiKey === undefined) { return; }

      const target = await pickConfigurationTarget(config);
      if (target === undefined) { return; }

      await config.update('serverUrl', url, target);
      await provider.setApiKey(apiKey);

      provider.invalidateModelCache();
      provider.refreshModels();
      await refreshStatusBar();

      await offerAdvancedSettings(provider);
    }
  );
  context.subscriptions.push(manageCommand);

  const editHeadersCommand = vscode.commands.registerCommand(
    `${commandPrefix}.editCustomHeaders`,
    async () => {
      await editCustomHeadersFlow(provider);
      provider.invalidateModelCache();
      provider.refreshModels();
      await refreshStatusBar();
    }
  );
  context.subscriptions.push(editHeadersCommand);

  const refreshCommand = vscode.commands.registerCommand(
    `${commandPrefix}.refreshModels`,
    async () => {
      provider.invalidateModelCache();
      provider.refreshModels();
      await refreshStatusBar();
    }
  );
  context.subscriptions.push(refreshCommand);
}

/**
 * Extension deactivation
 */
export function deactivate(): void {
  // no-op
}

/**
 * After the basic Configure Server flow, offer the user a chance to edit
 * custom headers (kept in SecretStorage, issue #28) or jump to the Settings
 * UI for the remaining non-secret options.
 */
async function offerAdvancedSettings(provider: GatewayProvider): Promise<void> {
  const completePick: vscode.QuickPickItem = {
    label: 'Complete',
    description: 'Finish configuration',
  };
  const headersPick: vscode.QuickPickItem = {
    label: 'Edit custom headers...',
    description: 'Add or remove HTTP headers (stored in secret storage)',
  };
  const advancedPick: vscode.QuickPickItem = {
    label: 'Edit advanced settings...',
    description: 'Extra model options, timeouts, logging',
  };

  const pick = await vscode.window.showQuickPick(
    [completePick, headersPick, advancedPick],
    {
      title: 'LLM Gateway — Configuration saved',
      placeHolder: 'Done, or continue to advanced options?',
      ignoreFocusOut: true,
    }
  );
  if (pick === headersPick) {
    await editCustomHeadersFlow(provider);
  } else if (pick === advancedPick) {
    const configSection = `github.copilot.llm-gateway${provider.getSuffix() ? `-${provider.getSuffix()}` : ''}`;
    await vscode.commands.executeCommand(
      'workbench.action.openSettings',
      configSection
    );
  }
}

interface HeaderQuickPickItem extends vscode.QuickPickItem {
  action: 'add' | 'edit' | 'clear' | 'done';
  headerName?: string;
}

/**
 * Quick-pick driven editor for custom headers persisted in SecretStorage.
 * Shows only header names (not values) so peeking at someone else's screen
 * doesn't leak credentials, and supports add / edit / delete / clear-all.
 */
async function editCustomHeadersFlow(provider: GatewayProvider): Promise<void> {
  while (true) {
    const headers = provider.getCustomHeadersSnapshot();
    const headerNames = Object.keys(headers).sort((a, b) => a.localeCompare(b));
    const items = buildHeaderQuickPickItems(headerNames);

    const pick = await vscode.window.showQuickPick(items, {
      title: `LLM Gateway — Custom Headers (${headerNames.length})`,
      placeHolder:
        headerNames.length === 0
          ? 'No custom headers yet. Add one or close.'
          : 'Select a header to edit, or add a new one',
      ignoreFocusOut: true,
    });
    if (!pick || pick.action === 'done') { return; }

    if (pick.action === 'add') {
      await addHeader(provider, headers);
    } else if (pick.action === 'clear') {
      await confirmAndClearHeaders(provider, headerNames.length);
    } else if (pick.action === 'edit' && pick.headerName) {
      await editOrDeleteHeader(provider, headers, pick.headerName);
    }
  }
}

/**
 * Build the quick-pick items for the custom-headers editor. Pulled out so
 * `editCustomHeadersFlow` stays under SonarCloud's cognitive-complexity
 * budget — and so the item shape lives next to its uses.
 */
function buildHeaderQuickPickItems(headerNames: readonly string[]): HeaderQuickPickItem[] {
  const items: HeaderQuickPickItem[] = [
    { label: 'Done', description: 'Save and close', action: 'done' },
    { label: '$(add) Add header...', description: 'Add a new header', action: 'add' },
  ];
  if (headerNames.length === 0) {
    return items;
  }
  items.push(
    {
      label: '$(trash) Clear all headers',
      description: 'Remove every custom header',
      action: 'clear',
    },
    {
      label: '',
      kind: vscode.QuickPickItemKind.Separator,
      action: 'done',
    },
    ...headerNames.map<HeaderQuickPickItem>((name) => ({
      label: name,
      description: 'Edit or remove (value hidden)',
      action: 'edit',
      headerName: name,
    }))
  );
  return items;
}

async function confirmAndClearHeaders(provider: GatewayProvider, count: number): Promise<void> {
  const confirm = await vscode.window.showWarningMessage(
    `Remove all ${count} custom header(s)?`,
    { modal: true },
    'Remove'
  );
  if (confirm === 'Remove') {
    await provider.setCustomHeaders({});
  }
}

async function addHeader(
  provider: GatewayProvider,
  current: Record<string, string>
): Promise<void> {
  const name = await vscode.window.showInputBox({
    title: 'LLM Gateway — New header name',
    prompt: 'e.g. Authorization, Anthropic-Version, HTTP-Referer',
    ignoreFocusOut: true,
    validateInput: (value) => {
      if (value.trim().length === 0) { return 'Header name cannot be empty'; }
      if (/[^\w-]/.test(value)) { return 'Header names typically only contain letters, digits, and dashes'; }
      return undefined;
    },
  });
  if (!name) { return; }
  const value = await vscode.window.showInputBox({
    title: `LLM Gateway — Value for ${name}`,
    prompt: 'Saved to VS Code\'s secret storage',
    password: true,
    ignoreFocusOut: true,
  });
  if (value === undefined) { return; }
  await provider.setCustomHeaders({ ...current, [name.trim()]: value });
}

async function editOrDeleteHeader(
  provider: GatewayProvider,
  current: Record<string, string>,
  name: string
): Promise<void> {
  const action = await vscode.window.showQuickPick(
    [
      { label: 'Edit value', description: 'Replace the current value' },
      { label: 'Remove header', description: 'Delete this header entirely' },
    ],
    {
      title: `LLM Gateway — ${name}`,
      placeHolder: 'Choose an action',
      ignoreFocusOut: true,
    }
  );
  if (!action) { return; }

  if (action.label === 'Remove header') {
    const next = { ...current };
    delete next[name];
    await provider.setCustomHeaders(next);
    return;
  }

  const value = await vscode.window.showInputBox({
    title: `LLM Gateway — New value for ${name}`,
    prompt: 'Saved to VS Code\'s secret storage',
    password: true,
    ignoreFocusOut: true,
  });
  if (value === undefined) { return; }
  await provider.setCustomHeaders({ ...current, [name]: value });
}

/**
 * Asks the user whether to save settings to Workspace or User (Global) scope.
 * Returns undefined if cancelled, or skips the prompt and returns Global when
 * no workspace folder is open (the only meaningful scope in that case).
 *
 * Defaults the highlighted option to whichever scope already has a value, and
 * otherwise prefers Workspace when a folder is open — most users hitting this
 * picker want per-window configuration (issue #23).
 */
async function pickConfigurationTarget(
  config: vscode.WorkspaceConfiguration
): Promise<vscode.ConfigurationTarget | undefined> {
  const hasWorkspaceFolder = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
  if (!hasWorkspaceFolder) {
    return vscode.ConfigurationTarget.Global;
  }

  const inspection = config.inspect('serverUrl');
  const workspacePick: vscode.QuickPickItem = {
    label: 'Workspace Settings',
    description: inspection?.workspaceValue === undefined ? undefined : '(currently set)',
    detail: 'Apply to this workspace only — different VS Code windows can use different servers.',
  };
  const globalPick: vscode.QuickPickItem = {
    label: 'User Settings (Global)',
    description: inspection?.globalValue === undefined ? undefined : '(currently set)',
    detail: 'Apply to all VS Code windows.',
  };

  const items = inspection?.globalValue !== undefined && inspection?.workspaceValue === undefined
    ? [globalPick, workspacePick]
    : [workspacePick, globalPick];

  const pick = await vscode.window.showQuickPick(items, {
    title: 'LLM Gateway — Save settings to',
    placeHolder: 'Choose where these settings should apply',
    ignoreFocusOut: true,
  });
  if (!pick) { return undefined; }

  return pick === workspacePick
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
}
