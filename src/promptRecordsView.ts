import * as vscode from 'vscode';
import { PromptDatabase } from './database';
import { collectFormValues } from './formPanel';
import {
  FormField,
  FormValues,
  FormWorkflow,
  formWorkflows,
  RECORD_TITLE_FIELD
} from './formWorkflows';

interface ViewMessage {
  readonly command: string;
  readonly categoryId?: string;
  readonly recordId?: string;
}

/** Provides an editor-area page for managing saved prompt records. */
export class PromptRecordsViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private categoryView: vscode.Webview | undefined;
  private selectedCategoryId = formWorkflows[0].toolName;
  private categoryMessageSubscription: vscode.Disposable | undefined;
  private visibilitySubscription: vscode.Disposable | undefined;
  private panelSubscriptions: vscode.Disposable[] = [];
  private readonly databaseSubscription: vscode.Disposable;

  constructor(
    private readonly database: PromptDatabase,
    private readonly workflows: readonly FormWorkflow[],
    private readonly extensionUri: vscode.Uri
  ) {
    this.databaseSubscription = database.onDidChangeRecords(() => this.postState());
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    this.categoryView = view.webview;
    view.webview.html = createCategoryHtml();
    this.categoryMessageSubscription = view.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleCategoryMessage(message).catch((error: unknown) => {
        void vscode.window.showErrorMessage(errorMessage(error));
      });
    });
    this.visibilitySubscription = view.onDidChangeVisibility(() => {
      if (view.visible) {
        this.open();
      }
    });
    if (view.visible) {
      this.open();
    }
  }

  open(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'aiVideoCreation.promptRecordsEditor',
      '提示词数据',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] }
    );
    this.panel = panel;
    panel.webview.html = createPageHtml();
    this.panelSubscriptions = [
      panel.webview.onDidReceiveMessage((message: unknown) => {
        void this.handlePanelMessage(message).catch((error: unknown) => {
          void vscode.window.showErrorMessage(errorMessage(error));
        });
      }),
      panel.onDidDispose(() => {
        if (this.panel === panel) {
          this.panel = undefined;
        }
        this.disposePanelSubscriptions();
      })
    ];
  }

  dispose(): void {
    this.categoryMessageSubscription?.dispose();
    this.visibilitySubscription?.dispose();
    this.databaseSubscription.dispose();
    this.panel?.dispose();
    this.panel = undefined;
    this.categoryView = undefined;
    this.disposePanelSubscriptions();
  }

  private disposePanelSubscriptions(): void {
    for (const subscription of this.panelSubscriptions.splice(0)) {
      subscription.dispose();
    }
  }

  private async handleCategoryMessage(value: unknown): Promise<void> {
    if (!isRecord(value) || typeof value.command !== 'string') {
      return;
    }

    const message = value as unknown as ViewMessage;
    if (message.command === 'ready') {
      this.postState();
      return;
    }

    if (message.command === 'select-category') {
      if (typeof message.categoryId !== 'string' ||
          !this.workflows.some((workflow) => workflow.toolName === message.categoryId)) {
        throw new Error('提示词分类标识无效。');
      }
      this.selectedCategoryId = message.categoryId;
      this.open();
      this.postState();
      return;
    }

    if (message.command === 'add-record') {
      this.open();
      await this.addRecord(message.categoryId);
      return;
    }

    if (message.command === 'send-prompt') {
      await this.sendPrompt(message.categoryId);
    }
  }

  private async sendPrompt(categoryId: string | undefined): Promise<void> {
    const workflow = this.findWorkflow(categoryId);
    const promptUri = vscode.Uri.joinPath(this.extensionUri, workflow.promptPath);
    await vscode.commands.executeCommand('workbench.action.chat.run.prompt.current', promptUri);
  }

  private async handlePanelMessage(value: unknown): Promise<void> {
    if (!isRecord(value) || typeof value.command !== 'string') {
      return;
    }

    const message = value as unknown as ViewMessage;
    if (message.command === 'ready') {
      this.postState();
      return;
    }
    if (message.command === 'edit-record') {
      await this.editRecord(message.recordId);
    }
  }

  private async addRecord(categoryId: string | undefined): Promise<void> {
    const workflow = this.findWorkflow(categoryId);
    const values = await collectViewForm(workflow);
    if (!values) {
      return;
    }

    this.database.saveRecord({
      title: values.title,
      categoryId: workflow.toolName,
      categoryName: workflow.title,
      schema: workflow.fields,
      data: values
    });
    this.selectedCategoryId = workflow.toolName;
    this.postState();
  }

  private async editRecord(recordId: string | undefined): Promise<void> {
    if (typeof recordId !== 'string') {
      throw new Error('记录标识缺失。');
    }

    const record = this.database.getRecord(recordId);
    if (!record) {
      throw new Error('要修改的记录不存在。');
    }

    const workflow = this.findWorkflow(record.categoryId);
    const savedFields = readFormFields(record.schema);
    const fields = savedFields.some((field) => field.name === 'title')
      ? savedFields
      : [RECORD_TITLE_FIELD, ...savedFields];
    const recordValues = readFormValues(record.data);
    const initialValues = {
      ...recordValues,
      title: record.title ?? recordValues.title ?? ''
    };
    const editWorkflow: FormWorkflow = {
      ...workflow,
      title: `修改${workflow.title}记录`,
      notice: '正在修改已保存的记录；字段结构来自该记录保存时的模板。',
      fields
    };
    const values = await collectViewForm(editWorkflow, initialValues);
    if (!values) {
      return;
    }

    const updatedRecord = this.database.updateRecord(record.id, {
      title: values.title,
      schema: fields,
      data: values
    });
    if (!updatedRecord) {
      throw new Error('记录已不存在，无法保存修改。');
    }

    this.selectedCategoryId = record.categoryId;
    this.postState();
  }

  private findWorkflow(categoryId: string | undefined): FormWorkflow {
    const workflow = this.workflows.find((item) => item.toolName === categoryId);
    if (!workflow) {
      throw new Error('提示词分类标识无效。');
    }
    return workflow;
  }

  private postState(): void {
    const categories = this.workflows.map((workflow) => ({
      id: workflow.toolName,
      title: workflow.title
    }));
    if (this.categoryView) {
      void this.categoryView.postMessage({
        command: 'categories',
        categories,
        selectedCategoryId: this.selectedCategoryId
      });
    }

    if (!this.panel) {
      return;
    }

    const selectedCategory = this.workflows.find((workflow) => workflow.toolName === this.selectedCategoryId);
    const records = this.database.listRecords(this.selectedCategoryId).map((record) => ({
      id: record.id,
      title: record.title,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt
    }));

    void this.panel.webview.postMessage({
      command: 'state',
      categoryTitle: selectedCategory?.title ?? '提示词数据',
      records
    });
  }
}

function readFormFields(value: unknown): readonly FormField[] {
  if (!Array.isArray(value) || value.some((field) =>
    !isRecord(field) ||
    typeof field.name !== 'string' ||
    typeof field.label !== 'string' ||
    typeof field.description !== 'string'
  )) {
    throw new Error('记录中保存的字段模板无效。');
  }
  return value as readonly FormField[];
}

function readFormValues(value: unknown): FormValues {
  if (!isRecord(value) || Object.values(value).some((fieldValue) => typeof fieldValue !== 'string')) {
    throw new Error('记录中保存的表单数据无效。');
  }
  return value as FormValues;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function collectViewForm(
  workflow: FormWorkflow,
  initialValues?: FormValues
): Promise<FormValues | undefined> {
  const cancellationSource = new vscode.CancellationTokenSource();
  try {
    return await collectFormValues(workflow, cancellationSource.token, initialValues);
  } finally {
    cancellationSource.dispose();
  }
}

function createCategoryHtml(): string {
  const nonce = createNonce();
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">
    * { box-sizing: border-box; }
    body { margin: 0; padding: 12px 8px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
    h2 { margin: 0 0 10px 8px; font-size: 13px; font-weight: 600; }
    nav { display: grid; gap: 4px; }
    .category-item { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 4px; }
    button { min-width: 0; min-height: 32px; border: 0; border-radius: 3px; color: inherit; font: inherit; cursor: pointer; }
    .select { padding: 5px 8px; overflow: hidden; text-align: left; text-overflow: ellipsis; white-space: nowrap; background: transparent; }
    .select:hover, .add:hover, .send:hover { background: var(--vscode-toolbar-hoverBackground); }
    .select[aria-pressed="true"] { color: var(--vscode-list-activeSelectionForeground); background: var(--vscode-list-activeSelectionBackground); outline: 1px solid var(--vscode-focusBorder); }
    .add { padding: 4px 6px; color: var(--vscode-textLink-foreground); background: transparent; }
    .send { padding: 4px 6px; color: var(--vscode-textLink-foreground); background: transparent; }
    button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  </style>
</head>
<body>
  <h2>提示词分类</h2>
  <nav id="category-list" aria-label="提示词分类"></nav>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const categoryList = document.getElementById('category-list');

    function makeButton(text, className, label, onClick) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = className;
      button.textContent = text;
      button.title = label;
      button.setAttribute('aria-label', label);
      button.addEventListener('click', onClick);
      return button;
    }

    function renderCategories(state) {
      categoryList.replaceChildren();
      for (const category of state.categories) {
        const item = document.createElement('div');
        item.className = 'category-item';
        const select = makeButton(category.title, 'select', category.title, () => {
          vscode.postMessage({ command: 'select-category', categoryId: category.id });
        });
        select.setAttribute('aria-pressed', String(category.id === state.selectedCategoryId));
        const add = makeButton('+ 添加', 'add', '添加' + category.title + '记录', () => {
          vscode.postMessage({ command: 'add-record', categoryId: category.id });
        });
        const send = makeButton('运行', 'send', '运行' + category.title + '提示词', () => {
          vscode.postMessage({ command: 'send-prompt', categoryId: category.id });
        });
        item.append(select, add, send);
        categoryList.append(item);
      }
    }

    window.addEventListener('message', (event) => {
      if (event.data.command === 'categories') renderCategories(event.data);
    });
    vscode.postMessage({ command: 'ready' });
  </script>
</body>
</html>`;
}

function createPageHtml(): string {
  const nonce = createNonce();
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">
    :root {
      color-scheme: light dark;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-width: 0; }
    main { min-height: 100vh; padding: 24px 28px; }
    button { font: inherit; color: inherit; cursor: pointer; }
    .edit-button { min-height: 30px; border: 0; border-radius: 3px; }
    .edit-button:hover { background: var(--vscode-toolbar-hoverBackground); }
    section { min-width: 0; }
    .heading { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 16px; }
    h1 { min-width: 0; margin: 0; font-size: 20px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .count { color: var(--vscode-descriptionForeground); font-size: 12px; }
    .table { min-width: 0; }
    .table-header, .record-row { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(112px, 1fr) minmax(112px, 1fr) auto; align-items: center; gap: 12px; }
    .table-header { padding: 10px 8px; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--vscode-panel-border); }
    .record-row { min-height: 44px; padding: 5px 8px; border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); }
    .record-cell { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .record-title { font-weight: 500; }
    .record-time { color: var(--vscode-descriptionForeground); font-size: 12px; }
    .edit-button { min-width: 44px; padding: 5px 8px; color: var(--vscode-textLink-foreground); background: transparent; }
    .empty { padding: 24px 8px; color: var(--vscode-descriptionForeground); text-align: center; }
    button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
    @media (max-width: 720px) {
      main { padding: 16px 12px; }
      .table-header, .record-row { grid-template-columns: minmax(0, 1fr) 86px 86px auto; gap: 5px; }
      .record-time { font-size: 10px; }
    }
  </style>
</head>
<body>
  <main>
    <section aria-live="polite">
      <div class="heading"><h1 id="category-title">提示词数据</h1><span id="record-count" class="count"></span></div>
      <div class="table">
        <div class="table-header" role="row"><span>标题</span><span>添加时间</span><span>修改时间</span><span></span></div>
        <div id="record-list" role="rowgroup"></div>
      </div>
    </section>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const categoryTitle = document.getElementById('category-title');
    const recordCount = document.getElementById('record-count');
    const recordList = document.getElementById('record-list');
    const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
      year: '2-digit', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    });

    function makeButton(text, className, label, onClick) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = className;
      button.textContent = text;
      button.title = label;
      button.setAttribute('aria-label', label);
      button.addEventListener('click', onClick);
      return button;
    }

    function makeTime(value) {
      const time = document.createElement('span');
      time.className = 'record-cell record-time';
      time.textContent = dateFormatter.format(new Date(value));
      time.title = new Date(value).toLocaleString();
      return time;
    }

    function renderState(state) {
      categoryTitle.textContent = state.categoryTitle;
      recordCount.textContent = state.records.length ? String(state.records.length) : '';
      recordList.replaceChildren();
      if (!state.records.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = '暂无保存的数据';
        recordList.append(empty);
        return;
      }

      for (const record of state.records) {
        const row = document.createElement('div');
        row.className = 'record-row';
        row.setAttribute('role', 'row');
        const title = document.createElement('span');
        title.className = 'record-cell record-title';
        title.textContent = record.title || '旧记录（无标题）';
        title.title = title.textContent;
        const edit = makeButton('修改', 'edit-button', '修改' + title.textContent, () => {
          vscode.postMessage({ command: 'edit-record', recordId: record.id });
        });
        row.append(title, makeTime(record.createdAt), makeTime(record.updatedAt), edit);
        recordList.append(row);
      }
    }

    window.addEventListener('message', (event) => {
      if (event.data.command === 'state') renderState(event.data);
    });
    vscode.postMessage({ command: 'ready' });
  </script>
</body>
</html>`;
}

function createNonce(): string {
  const values = new Uint8Array(24);
  globalThis.crypto.getRandomValues(values);
  return Array.from(values, (value) => value.toString(16).padStart(2, '0')).join('');
}
