import * as vscode from 'vscode';
import { PromptDatabase, PromptRecord } from './database';
import { collectFormValues, FormSubmission } from './formPanel';
import {
  FormField,
  FormValues,
  FormWorkflow,
  getWorkflowResultType,
  RECORD_TITLE_FIELD
} from './formWorkflows';
import { WorkflowSubmissionStore } from './workflowFormTool';

interface ViewMessage {
  readonly command: string;
  readonly categoryId?: string;
  readonly recordId?: string;
  readonly confirmationTitle?: string;
  readonly content?: string;
  readonly contentZh?: string;
  readonly contentEn?: string;
}

/** Provides an editor-area page for managing saved prompt records. */
export class PromptRecordsViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private categoryView: vscode.Webview | undefined;
  private selectedCategoryId: string | undefined;
  private categoryMessageSubscription: vscode.Disposable | undefined;
  private visibilitySubscription: vscode.Disposable | undefined;
  private panelSubscriptions: vscode.Disposable[] = [];
  private readonly databaseSubscription: vscode.Disposable;

  /**
   * 创建提示词记录视图。
   * @param database 用户级记录数据库。
   * @param workflows 可用的提示词工作流。
   * @param extensionUri 扩展安装目录 URI。
   * @param submissions 供参数工具读取的一次性提交数据存储。
   */
  constructor(
    private readonly database: PromptDatabase,
    private readonly workflows: readonly FormWorkflow[],
    private readonly extensionUri: vscode.Uri,
    private readonly submissions: WorkflowSubmissionStore
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
      this.postState();
    });
  }

  open(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      return;
    }

    const selectedCategoryTitle = this.workflows.find(
      (workflow) => workflow.toolName === this.selectedCategoryId
    )?.title ?? '请选择创作任务';
    const panel = vscode.window.createWebviewPanel(
      'aiVideoCreation.promptRecordsEditor',
      selectedCategoryTitle,
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] }
    );
    this.panel = panel;
    panel.webview.html = createPageHtml(this.workflows);
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
      await this.addRecord(message.categoryId);
      return;
    }

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
    if (message.command === 'select-record') {
      await this.editRecord(message.recordId);
      return;
    }
    if (message.command === 'view-result') {
      this.postGeneratedResult(message.recordId);
      return;
    }
    if (message.command === 'save-generated-result') {
      try {
        this.saveGeneratedResult(message.recordId, message.content, message.contentZh, message.contentEn);
      } catch (error) {
        void this.panel?.webview.postMessage({
          command: 'generated-result-save-error',
          recordId: message.recordId,
          text: errorMessage(error)
        });
      }
      return;
    }
    if (message.command === 'delete-record') {
      try {
        this.deleteRecord(message.recordId, message.confirmationTitle);
      } catch (error) {
        void this.panel?.webview.postMessage({
          command: 'delete-error',
          text: errorMessage(error)
        });
      }
    }
  }

  /** 核对用户输入的标题后删除记录。 */
  private deleteRecord(recordId: string | undefined, confirmationTitle: string | undefined): void {
    if (typeof recordId !== 'string' || typeof confirmationTitle !== 'string') {
      throw new Error('删除记录所需信息缺失。');
    }

    const record = this.database.getRecord(recordId);
    if (!record) {
      throw new Error('记录不存在或已被删除。');
    }

    const expectedTitle = record.title || '旧记录（无标题）';
    if (confirmationTitle !== expectedTitle) {
      throw new Error('输入的标题与记录标题不一致，未删除。');
    }
    if (!this.database.deleteRecord(record.id)) {
      throw new Error('删除记录失败。');
    }

    void this.panel?.webview.postMessage({ command: 'delete-success' });
  }

  /** 按需向记录页面发送指定记录的 Copilot 返回内容。 */
  private postGeneratedResult(recordId: string | undefined): void {
    if (typeof recordId !== 'string') {
      throw new Error('查看生成结果所需的记录标识缺失。');
    }

    const record = this.database.getRecord(recordId);
    if (!record) {
      throw new Error('要查看的提示词记录不存在。');
    }

    const isContent = getWorkflowResultType(record.categoryId) === 'content';
    void this.panel?.webview.postMessage({
      command: 'generated-result',
      recordId: record.id,
      title: record.title || '旧记录（无标题）',
      resultType: isContent ? 'content' : 'prompt',
      ...(isContent
        ? { content: record.generatedResultContent ?? '' }
        : {
            contentZh: record.generatedResultChinese ?? '',
            contentEn: record.generatedResultEnglish ?? ''
          })
    });
  }

  /** 保存用户在结果弹层中修改的作品内容或双语提示词。 */
  private saveGeneratedResult(
    recordId: string | undefined,
    content: string | undefined,
    contentZh: string | undefined,
    contentEn: string | undefined
  ): void {
    if (typeof recordId !== 'string') {
      throw new Error('保存生成结果所需的记录标识缺失。');
    }

    const record = this.database.getRecord(recordId);
    if (!record) {
      throw new Error('要修改的生成结果记录不存在。');
    }

    let updatedRecord: PromptRecord | undefined;
    if (getWorkflowResultType(record.categoryId) === 'content') {
      if (typeof content !== 'string' || contentZh !== undefined || contentEn !== undefined) {
        throw new Error('该工作流只能保存单篇创作内容。');
      }
      updatedRecord = this.database.updateGeneratedContent(recordId, content);
    } else {
      if (typeof content !== 'undefined' || typeof contentZh !== 'string' || typeof contentEn !== 'string') {
        throw new Error('该工作流必须保存中英文提示词。');
      }
      updatedRecord = this.database.updateGeneratedResult(recordId, contentZh, contentEn);
    }

    if (!updatedRecord) {
      throw new Error('要修改的提示词记录不存在。');
    }

    void this.panel?.webview.postMessage({
      command: 'generated-result-saved',
      recordId
    });
  }

  private async addRecord(categoryId: string | undefined): Promise<void> {
    const workflow = this.findWorkflow(categoryId);
    const formWorkflow: FormWorkflow = {
      ...workflow,
      title: `添加${workflow.title}信息`,
      notice: '填写信息后可保存，或保存并运行对应提示词。'
    };
    const submission = await collectViewForm(formWorkflow);
    if (!submission) {
      return;
    }

    const record = this.database.saveRecord({
      title: submission.values.title,
      categoryId: workflow.toolName,
      categoryName: workflow.title,
      schema: workflow.fields,
      data: submission.values
    });
    this.selectedCategoryId = workflow.toolName;
    this.postState();
    if (submission.runPrompt) {
      await this.runSubmittedPrompt(workflow, submission.values, record.id);
    }
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
      title: `选择${workflow.title}信息`,
      notice: '可直接保存当前内容，也可以修改后保存；选择保存并运行时将使用这些参数运行提示词。',
      fields
    };
    const submission = await collectViewForm(editWorkflow, initialValues);
    if (!submission) {
      return;
    }

    const updatedRecord = this.database.updateRecord(record.id, {
      title: submission.values.title,
      schema: fields,
      data: submission.values
    });
    if (!updatedRecord) {
      throw new Error('记录已不存在，无法保存修改。');
    }

    this.selectedCategoryId = record.categoryId;
    this.postState();
    if (submission.runPrompt) {
      await this.runSubmittedPrompt(workflow, submission.values, record.id);
    }
  }

  /** 将已提交参数及其记录标识交给对应的 Prompt 工具并启动提示词。 */
  private async runSubmittedPrompt(
    workflow: FormWorkflow,
    values: FormValues,
    recordId: string
  ): Promise<void> {
    this.submissions.set(workflow.toolName, values, recordId);
    const promptUri = vscode.Uri.joinPath(this.extensionUri, workflow.promptPath);
    try {
      await vscode.commands.executeCommand('workbench.action.chat.run.prompt.current', promptUri);
    } catch (error) {
      this.submissions.clear(workflow.toolName);
      throw error;
    }
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
    const categoryTitle = selectedCategory?.title ?? '请选择创作任务';
    this.panel.title = categoryTitle;
    const records = (this.selectedCategoryId === undefined
      ? []
      : this.database.listRecords(this.selectedCategoryId)).map((record) => ({
      id: record.id,
      title: record.title,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt
    }));

    void this.panel.webview.postMessage({
      command: 'state',
      categoryId: this.selectedCategoryId,
      categoryTitle,
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
): Promise<FormSubmission | undefined> {
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
    main {
      padding: 10px; background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 6px;
    }
    h2 {
      display: flex; align-items: center; gap: 9px;
      margin: 0 0 8px; padding: 2px; font-size: 16px; font-weight: 600;
    }
    h2::before {
      width: 4px; height: 18px; flex: 0 0 auto;
      background: var(--vscode-focusBorder); border-radius: 2px; content: "";
    }
    nav { display: grid; gap: 0; }
    .category-stage + .category-stage { margin-top: 10px; padding-top: 8px; border-top: 2px solid var(--vscode-panel-border); }
    .stage-title {
      margin: 0 2px 4px; padding-left: 7px; border-left: 2px solid var(--vscode-focusBorder);
      color: var(--vscode-descriptionForeground); font-size: 12px; font-weight: 600;
    }
    .category-item {
      display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px; padding: 4px 2px;
      background: transparent; border: 0; border-bottom: 1px solid var(--vscode-panel-border);
    }
    .category-item:last-child { border-bottom-color: transparent; }
    .category-item:hover { background: var(--vscode-list-hoverBackground); }
    .category-item.is-selected {
      color: var(--vscode-list-activeSelectionForeground);
      background: var(--vscode-list-activeSelectionBackground);
      border-bottom-color: var(--vscode-focusBorder);
    }
    button { min-width: 0; min-height: 32px; border: 0; border-radius: 3px; color: inherit; font: inherit; cursor: pointer; }
    .select { padding: 5px 8px; overflow: hidden; text-align: left; text-overflow: ellipsis; white-space: nowrap; background: transparent; }
    .add { padding: 4px 6px; color: var(--vscode-textLink-foreground); background: transparent; }
    button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
    .category-item:focus-within { border-bottom-color: var(--vscode-focusBorder); }
    .category-item button:focus-visible { outline: none; }
  </style>
</head>
<body>
  <main>
    <h2>创作任务</h2>
    <nav id="category-list" aria-label="创作任务"></nav>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const categoryList = document.getElementById('category-list');
    const categoryStages = [
      {
        title: '阶段一 · 故事创作',
        categoryIds: [
          'ai-video-creation-tools_collect_story_parameters',
          'ai-video-creation-tools_collect_image_story_parameters',
          'ai-video-creation-tools_collect_novel_parameters'
        ]
      },
      {
        title: '阶段二 · 视觉资产创作',
        categoryIds: [
          'ai-video-creation-tools_collect_character_parameters',
          'ai-video-creation-tools_collect_scene_parameters',
          'ai-video-creation-tools_collect_prop_parameters',
          'ai-video-creation-tools_collect_effect_parameters'
        ]
      },
      {
        title: '阶段三 · 剧本与拍摄',
        categoryIds: [
          'ai-video-creation-tools_collect_screenplay_parameters',
          'ai-video-creation-tools_collect_shooting_script_parameters'
        ]
      }
    ];

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
      for (const stage of categoryStages) {
        const section = document.createElement('section');
        section.className = 'category-stage';
        const heading = document.createElement('h3');
        heading.className = 'stage-title';
        heading.textContent = stage.title;
        section.append(heading);

        for (const categoryId of stage.categoryIds) {
          const category = state.categories.find((item) => item.id === categoryId);
          if (!category) {
            throw new Error('创作阶段分类缺失：' + categoryId);
          }

          const item = document.createElement('div');
          item.className = 'category-item';
          const isSelected = category.id === state.selectedCategoryId;
          item.classList.toggle('is-selected', isSelected);
          const select = makeButton(category.title, 'select', category.title, () => {
            vscode.postMessage({ command: 'select-category', categoryId: category.id });
          });
          select.setAttribute('aria-pressed', String(isSelected));
          const add = makeButton('+ 添加', 'add', '添加' + category.title + '记录', () => {
            vscode.postMessage({ command: 'add-record', categoryId: category.id });
          });
          item.append(select, add);
          section.append(item);
        }

        categoryList.append(section);
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

function createPageHtml(workflows: readonly FormWorkflow[]): string {
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
    .table { min-width: 0; }
    .table-header, .record-row { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(112px, 1fr) minmax(112px, 1fr) auto; align-items: center; gap: 12px; }
    .table-header { padding: 10px 8px; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--vscode-panel-border); }
    .record-row { min-height: 44px; padding: 5px 8px; border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); }
    .record-cell { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .record-title { font-weight: 500; }
    .record-time { color: var(--vscode-descriptionForeground); font-size: 12px; }
    .edit-button { min-width: 44px; padding: 5px 8px; color: var(--vscode-textLink-foreground); background: transparent; }
    .record-actions { display: flex; align-items: center; gap: 6px; }
    .delete-button {
      min-width: 44px; padding: 5px 8px; border: 0; border-radius: 3px;
      color: var(--vscode-errorForeground); background: transparent;
    }
    .delete-button:hover { background: var(--vscode-toolbar-hoverBackground); }
    .delete-button:focus-visible { outline: none; background: var(--vscode-toolbar-hoverBackground); }
    .empty { padding: 24px 8px; color: var(--vscode-descriptionForeground); text-align: center; }
    button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
    dialog {
      width: min(440px, calc(100vw - 32px)); padding: 20px;
      color: var(--vscode-foreground); background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 4px;
    }
    dialog::backdrop { background: var(--vscode-widget-shadow); opacity: .55; }
    dialog h2 { margin: 0 0 12px; font-size: 16px; }
    dialog p { margin: 0 0 14px; line-height: 1.5; overflow-wrap: anywhere; }
    .delete-title-highlight { padding: 2px 5px; color: var(--vscode-foreground); background: var(--vscode-editor-background); border-radius: 3px; }
    dialog label { display: block; margin-bottom: 6px; }
    dialog input {
      width: 100%; min-height: 34px; padding: 6px 8px;
      color: var(--vscode-input-foreground); background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 3px; font: inherit;
    }
    dialog input:focus { outline: 1px solid var(--vscode-focusBorder); }
    .delete-error { margin-top: 8px; color: var(--vscode-errorForeground); }
    .delete-error[hidden] { display: none; }
    .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
    #confirm-delete:disabled { cursor: default; }
    .result-dialog { width: min(900px, calc(100vw - 32px)); }
    .result-error { margin: 8px 0 0; color: var(--vscode-errorForeground); }
    .result-error[hidden] { display: none; }
    .result-field { display: grid; gap: 6px; margin-top: 12px; }
    .result-field[hidden], #prompt-result-fields[hidden] { display: none; }
    .result-field-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .result-field-heading label { margin: 0; }
    .result-copy-button {
      min-height: 28px; padding: 4px 8px; border: 0; border-radius: 3px;
      color: var(--vscode-textLink-foreground); background: transparent; transition: opacity .3s ease;
    }
    .result-copy-button:hover { background: var(--vscode-toolbar-hoverBackground); }
    .result-copy-button.is-fading { opacity: 0; }
    .result-dialog textarea {
      display: block; width: 100%; max-height: calc(18em + 18px); padding: 8px;
      color: var(--vscode-input-foreground); background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 3px;
      font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); line-height: 1.5;
      resize: none; overflow-y: auto; white-space: pre-wrap; overflow-wrap: anywhere;
    }
    .result-dialog textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
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
      <div class="table">
        <div class="table-header" role="row"><span>标题</span><span>添加时间</span><span>修改时间</span><span></span></div>
        <div id="record-list" role="rowgroup"></div>
      </div>
    </section>
    <dialog id="delete-dialog" aria-labelledby="delete-dialog-title">
      <form id="delete-form">
        <h2 id="delete-dialog-title">确认删除记录</h2>
        <p id="delete-prompt"></p>
        <label for="delete-title">确认标题</label>
        <input id="delete-title" type="text" autocomplete="off" spellcheck="false">
        <p id="delete-error" class="delete-error" role="alert" hidden></p>
        <div class="dialog-actions">
          <button id="cancel-delete" type="button">取消</button>
          <button id="confirm-delete" type="submit" disabled>删除</button>
        </div>
      </form>
    </dialog>
    <dialog id="result-dialog" class="result-dialog" aria-labelledby="result-dialog-title">
      <h2 id="result-dialog-title">查看结果</h2>
      <div id="content-result-field" class="result-field" hidden>
        <div class="result-field-heading">
          <label for="generated-content">生成内容</label>
          <button id="copy-content" class="result-copy-button" type="button" disabled>复制内容</button>
        </div>
        <textarea id="generated-content" aria-label="生成内容" rows="1" placeholder="暂无已保存的生成内容"></textarea>
      </div>
      <div id="prompt-result-fields" hidden>
        <div class="result-field">
          <div class="result-field-heading">
            <label for="generated-result-zh">中文提示词</label>
            <button id="copy-result-zh" class="result-copy-button" type="button" disabled>复制提示词</button>
          </div>
          <textarea id="generated-result-zh" aria-label="中文提示词" rows="1" placeholder="暂无已保存的中文提示词"></textarea>
        </div>
        <div class="result-field">
          <div class="result-field-heading">
            <label for="generated-result-en">English Prompt</label>
            <button id="copy-result-en" class="result-copy-button" type="button" disabled>复制提示词</button>
          </div>
          <textarea id="generated-result-en" aria-label="English Prompt" rows="1" placeholder="No saved English prompt"></textarea>
        </div>
      </div>
      <p id="result-error" class="result-error" role="alert" hidden></p>
      <div class="dialog-actions">
        <button id="close-result" type="button">关闭</button>
        <button id="edit-result" type="button" disabled>保存</button>
      </div>
    </dialog>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
      const contentWorkflowIds = ${JSON.stringify(workflows
        .filter((workflow) => workflow.resultType === 'content')
        .map((workflow) => workflow.toolName))};
    const recordList = document.getElementById('record-list');
    const deleteDialog = document.getElementById('delete-dialog');
    const deleteForm = document.getElementById('delete-form');
    const deletePrompt = document.getElementById('delete-prompt');
    const deleteTitle = document.getElementById('delete-title');
    const deleteError = document.getElementById('delete-error');
    const confirmDelete = document.getElementById('confirm-delete');
    const resultDialog = document.getElementById('result-dialog');
    const resultDialogTitle = document.getElementById('result-dialog-title');
    const contentResultField = document.getElementById('content-result-field');
    const promptResultFields = document.getElementById('prompt-result-fields');
    const generatedContent = document.getElementById('generated-content');
    const generatedResultZh = document.getElementById('generated-result-zh');
    const generatedResultEn = document.getElementById('generated-result-en');
    const copyContentButton = document.getElementById('copy-content');
    const copyResultZhButton = document.getElementById('copy-result-zh');
    const copyResultEnButton = document.getElementById('copy-result-en');
    const resultError = document.getElementById('result-error');
    const editResultButton = document.getElementById('edit-result');
    const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
      year: '2-digit', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    });
    let pendingDelete;
    let viewingResultRecordId;
    let selectedCategoryId;
    let viewingResultType;
    let isResultLoaded = false;
    const copyFeedbackTimers = new WeakMap();

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

    function openDeleteDialog(record) {
      const title = record.title || '旧记录（无标题）';
      pendingDelete = { id: record.id, title };
      const highlightedTitle = document.createElement('span');
      highlightedTitle.className = 'delete-title-highlight';
      highlightedTitle.textContent = title;
      deletePrompt.replaceChildren(
        document.createTextNode('如果要删除请在下方输入标题“'),
        highlightedTitle,
        document.createTextNode('”确定删除')
      );
      deleteTitle.value = '';
      deleteError.hidden = true;
      deleteError.textContent = '';
      confirmDelete.disabled = true;
      deleteDialog.showModal();
      deleteTitle.focus();
    }

    function closeDeleteDialog() {
      deleteDialog.close();
      pendingDelete = undefined;
      deleteTitle.value = '';
      deleteError.hidden = true;
      confirmDelete.disabled = true;
    }

    function openResultDialog(record) {
      const title = record.title || '旧记录（无标题）';
      viewingResultType = contentWorkflowIds.includes(selectedCategoryId) ? 'content' : 'prompt';
      const isContent = viewingResultType === 'content';
      resultDialogTitle.textContent = (isContent ? '查看作品：' : '查看提示词：') + title;
      contentResultField.hidden = !isContent;
      promptResultFields.hidden = isContent;
      generatedContent.value = '';
      generatedResultZh.value = '';
      generatedResultEn.value = '';
      generatedContent.placeholder = '正在读取已保存的生成内容';
      generatedResultZh.placeholder = '正在读取已保存的中文提示词';
      generatedResultEn.placeholder = 'Loading saved English prompt';
      resultError.textContent = '';
      resultError.hidden = true;
      isResultLoaded = false;
      editResultButton.disabled = true;
      copyContentButton.disabled = true;
      copyResultZhButton.disabled = true;
      copyResultEnButton.disabled = true;
      viewingResultRecordId = record.id;
      resultDialog.showModal();
      resizeResultTextareas();
      (isContent ? generatedContent : generatedResultZh).focus();
      vscode.postMessage({ command: 'view-result', recordId: record.id });
    }

    function closeResultDialog() {
      resultDialog.close();
      viewingResultRecordId = undefined;
      viewingResultType = undefined;
      isResultLoaded = false;
    }

    // 按当前结果内容调整文本框高度，保持初始单行显示。
    function resizeResultTextareas() {
      [generatedContent, generatedResultZh, generatedResultEn].forEach((textarea) => {
        textarea.style.height = 'auto';
        textarea.style.height = textarea.scrollHeight + 'px';
      });
    }

    function copyResult(textarea, button, defaultLabel) {
      navigator.clipboard.writeText(textarea.value).then(() => {
        resultError.hidden = true;
        const previousTimers = copyFeedbackTimers.get(button);
        if (previousTimers) {
          window.clearTimeout(previousTimers.fade);
          window.clearTimeout(previousTimers.reset);
        }

        button.classList.remove('is-fading');
        button.textContent = '复制成功';
        const fadeTimer = window.setTimeout(() => button.classList.add('is-fading'), 1000);
        const resetTimer = window.setTimeout(() => {
          button.textContent = defaultLabel;
          button.classList.remove('is-fading');
          copyFeedbackTimers.delete(button);
        }, 1300);
        copyFeedbackTimers.set(button, { fade: fadeTimer, reset: resetTimer });
      }).catch(() => {
        resultError.textContent = '复制内容失败，请检查剪贴板权限。';
        resultError.hidden = false;
      });
    }

    [generatedContent, generatedResultZh, generatedResultEn].forEach((textarea) => {
      textarea.addEventListener('input', resizeResultTextareas);
    });

    function renderState(state) {
      selectedCategoryId = state.categoryId;
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
        const select = makeButton('选择', 'edit-button', '选择' + title.textContent + '并编辑提交', () => {
          vscode.postMessage({ command: 'select-record', recordId: record.id });
        });
        const actions = document.createElement('div');
        actions.className = 'record-actions';
        const isContent = contentWorkflowIds.includes(selectedCategoryId);
        const resultLabel = '查看';
        const viewResult = makeButton(resultLabel, 'edit-button', resultLabel + title.textContent + '的 Copilot 返回内容', () => {
          openResultDialog(record);
        });
        const remove = makeButton('删除', 'delete-button', '删除' + title.textContent, () => {
          openDeleteDialog(record);
        });
        actions.append(select, viewResult, remove);
        row.append(title, makeTime(record.createdAt), makeTime(record.updatedAt), actions);
        recordList.append(row);
      }
    }

    deleteTitle.addEventListener('input', () => {
      confirmDelete.disabled = !pendingDelete || deleteTitle.value !== pendingDelete.title;
      deleteError.hidden = true;
    });

    deleteForm.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!pendingDelete || deleteTitle.value !== pendingDelete.title) {
        deleteError.textContent = '输入的标题与记录标题不一致。';
        deleteError.hidden = false;
        confirmDelete.disabled = true;
        return;
      }

      confirmDelete.disabled = true;
      vscode.postMessage({
        command: 'delete-record',
        recordId: pendingDelete.id,
        confirmationTitle: deleteTitle.value
      });
    });

    document.getElementById('cancel-delete').addEventListener('click', closeDeleteDialog);
    document.getElementById('close-result').addEventListener('click', closeResultDialog);
    copyContentButton.addEventListener('click', () => copyResult(generatedContent, copyContentButton, '复制内容'));
    copyResultZhButton.addEventListener('click', () => copyResult(generatedResultZh, copyResultZhButton, '复制提示词'));
    copyResultEnButton.addEventListener('click', () => copyResult(generatedResultEn, copyResultEnButton, '复制提示词'));
    editResultButton.addEventListener('click', () => {
      if (!viewingResultRecordId || !isResultLoaded) return;
      editResultButton.disabled = true;
      resultError.textContent = '';
      resultError.hidden = true;
      vscode.postMessage({
        command: 'save-generated-result',
        recordId: viewingResultRecordId,
        ...(viewingResultType === 'content'
          ? { content: generatedContent.value }
          : { contentZh: generatedResultZh.value, contentEn: generatedResultEn.value })
      });
    });
    resultDialog.addEventListener('cancel', () => {
      viewingResultRecordId = undefined;
      viewingResultType = undefined;
      isResultLoaded = false;
    });
    deleteDialog.addEventListener('cancel', () => {
      pendingDelete = undefined;
      deleteTitle.value = '';
      confirmDelete.disabled = true;
    });

    window.addEventListener('message', (event) => {
      if (event.data.command === 'state') renderState(event.data);
      if (event.data.command === 'delete-success') closeDeleteDialog();
      if (event.data.command === 'generated-result' && event.data.recordId === viewingResultRecordId) {
        viewingResultType = event.data.resultType;
        const isContent = viewingResultType === 'content';
        contentResultField.hidden = !isContent;
        promptResultFields.hidden = isContent;
        resultDialogTitle.textContent = (isContent ? '查看作品：' : '查看提示词：') + event.data.title;
        generatedContent.value = event.data.content ?? '';
        generatedResultZh.value = event.data.contentZh ?? '';
        generatedResultEn.value = event.data.contentEn ?? '';
        resizeResultTextareas();
        generatedContent.placeholder = '暂无已保存的生成内容';
        generatedResultZh.placeholder = '暂无已保存的中文提示词';
        generatedResultEn.placeholder = 'No saved English prompt';
        isResultLoaded = true;
        editResultButton.disabled = false;
        copyContentButton.disabled = false;
        copyResultZhButton.disabled = false;
        copyResultEnButton.disabled = false;
      }
      if (event.data.command === 'generated-result-saved' && event.data.recordId === viewingResultRecordId) {
        editResultButton.disabled = false;
        resultError.hidden = true;
      }
      if (event.data.command === 'generated-result-save-error' && event.data.recordId === viewingResultRecordId) {
        resultError.textContent = event.data.text;
        resultError.hidden = false;
        editResultButton.disabled = false;
      }
      if (event.data.command === 'delete-error') {
        deleteError.textContent = event.data.text;
        deleteError.hidden = false;
        confirmDelete.disabled = !pendingDelete || deleteTitle.value !== pendingDelete.title;
      }
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
