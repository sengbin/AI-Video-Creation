import * as vscode from 'vscode';
import { GeneratedContentTask, WorkProject } from './database';
import { FormField, FormValues, FormWorkflow, IMAGE_ATTACHMENTS_FIELD } from './formWorkflows';

const CUSTOM_OPTION_VALUE = '__custom__';
// 限制附件体积，避免表单消息和本地记录因图片过大而膨胀。
const MAX_IMAGE_COUNT = 20;
const MAX_IMAGE_FILE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_TOTAL_BYTES = 25 * 1024 * 1024;
const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg'] as const;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** 表示已校验的 PNG 或 JPEG 图片附件。 */
export interface FormImageAttachment {
  readonly mimeType: typeof IMAGE_MIME_TYPES[number];
  readonly data: string;
}

/** 表示表单参数及用户选择的保存行为。 */
export interface FormSubmission {
  readonly values: FormValues;
  readonly runPrompt: boolean;
  /** 表单所选项目；'0' 表示未归属项目。 */
  readonly projectId: string;
}

/**
 * 解析并校验表单中序列化的图片附件。
 * @param value 图片附件的 JSON 字符串；未提供时表示没有图片。
 * @returns 按用户添加顺序排列的图片附件。
 * @throws 图片数据格式、内容签名或大小不符合要求时抛出错误。
 */
export function parseImageAttachments(value: string | undefined): FormImageAttachment[] {
  if (value === undefined) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('图片附件数据不是有效的 JSON。');
  }

  if (!Array.isArray(parsed) || parsed.length > MAX_IMAGE_COUNT) {
    throw new Error(`图片数量不能超过 ${MAX_IMAGE_COUNT} 张。`);
  }

  let totalBytes = 0;
  return parsed.map((attachment): FormImageAttachment => {
    if (typeof attachment !== 'object' || attachment === null || Array.isArray(attachment) ||
        Object.keys(attachment).length !== 2 ||
        !('mimeType' in attachment) || !IMAGE_MIME_TYPES.includes(attachment.mimeType as typeof IMAGE_MIME_TYPES[number]) ||
        !('data' in attachment) || typeof attachment.data !== 'string' ||
        !BASE64_PATTERN.test(attachment.data)) {
      throw new Error('图片附件必须是有效的 PNG 或 JPEG 图片数据。');
    }

    const imageBytes = Buffer.from(attachment.data, 'base64');
    if (imageBytes.toString('base64') !== attachment.data || imageBytes.byteLength === 0 ||
        imageBytes.byteLength > MAX_IMAGE_FILE_BYTES) {
      throw new Error('图片数据为空、超出单张大小限制或编码无效。');
    }

    const isPng = attachment.mimeType === 'image/png' &&
      imageBytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const isJpeg = attachment.mimeType === 'image/jpeg' &&
      imageBytes[0] === 255 && imageBytes[1] === 216 && imageBytes[2] === 255;
    if (!isPng && !isJpeg) {
      throw new Error('图片内容与声明的 PNG 或 JPEG 格式不匹配。');
    }

    totalBytes += imageBytes.byteLength;
    if (totalBytes > MAX_IMAGE_TOTAL_BYTES) {
      throw new Error('图片附件总大小不能超过 25 MB。');
    }

    return { mimeType: attachment.mimeType as FormImageAttachment['mimeType'], data: attachment.data };
  });
}

/**
 * 打开工作流参数表单并等待用户提交。
 * @param workflow 当前工作流及其字段定义。
 * @param token 用于在调用取消时关闭表单。
 * @param initialValues 可选的表单初始值。
 * @returns 保存操作及表单参数；取消或关闭表单时返回 undefined。
 */
export function collectFormValues(
  workflow: FormWorkflow,
  token: vscode.CancellationToken,
  initialValues: FormValues = {},
  projects: readonly WorkProject[] = [],
  generatedContentTasks: readonly GeneratedContentTask[] = []
): Promise<FormSubmission | undefined> {
  if (token.isCancellationRequested) {
    return Promise.resolve(undefined);
  }

  const panel = vscode.window.createWebviewPanel(
    'aiVideoCreation.parameterForm',
    `${workflow.title}参数`,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      localResourceRoots: []
    }
  );

  panel.webview.html = createFormHtml(workflow, initialValues, projects, generatedContentTasks);

  return new Promise((resolve) => {
    let settled = false;
    const subscriptions: vscode.Disposable[] = [];

    const finish = (submission: FormSubmission | undefined): void => {
      if (settled) {
        return;
      }

      settled = true;
      subscriptions.forEach((subscription) => subscription.dispose());
      panel.dispose();
      resolve(submission);
    };

    subscriptions.push(panel.onDidDispose(() => finish(undefined)));
    subscriptions.push(token.onCancellationRequested(() => finish(undefined)));
    subscriptions.push(panel.webview.onDidReceiveMessage((message: unknown) => {
      if (!isRecord(message)) {
        return;
      }

      if (message.command === 'cancel') {
        finish(undefined);
        return;
      }

      if (message.command !== 'save' && message.command !== 'submit') {
        return;
      }

      const values = validateWorkflowFormValues(message.values, workflow);
      const projectId = message.projectId;
      const sourceTaskField = workflow.fields.find((field) => field.projectContentTask);
      const invalidSourceTask = sourceTaskField && values !== undefined &&
        !generatedContentTasks.some((task) =>
          task.id === values[sourceTaskField.name] && task.projectId === projectId
        );
      if (!values || typeof projectId !== 'string' ||
          (workflow.requiresProject && projectId === '0') ||
          (projectId !== '0' && !projects.some((project) => project.id === projectId)) ||
          invalidSourceTask) {
        void panel.webview.postMessage({
          command: 'validation-error',
          text: '表单数据无效，请检查后重新提交。'
        });
        return;
      }

      if (message.command === 'submit' && workflow.supportsImageAttachments &&
          parseImageAttachments(values[IMAGE_ATTACHMENTS_FIELD]).length === 0) {
        void panel.webview.postMessage({
          command: 'validation-error',
          text: '图片灵感写作至少需要添加一张图片。'
        });
        return;
      }

      finish({ values, runPrompt: message.command === 'submit', projectId });
    }));
  });
}

/** 校验工作流表单字段和工作流专用的附件数据。 */
export function validateWorkflowFormValues(value: unknown, workflow: FormWorkflow): FormValues | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const fields = workflow.fields;
  const expectedNames = fields.map((field) => field.name);
  if (workflow.supportsImageAttachments) {
    expectedNames.push(IMAGE_ATTACHMENTS_FIELD);
  }
  const invalidNumberField = workflow.fields.some((field) => {
    if (field.inputType !== 'number') {
      return false;
    }
    const rawValue = value[field.name];
    if (typeof rawValue !== 'string' || !/^[0-9]+$/.test(rawValue)) {
      return true;
    }
    const numericValue = Number(rawValue);
    return !Number.isSafeInteger(numericValue) ||
      (field.min !== undefined && numericValue < field.min) ||
      (field.max !== undefined && numericValue > field.max);
  });
  const invalidChapterWordRange = workflow.supportsChapterContent === true &&
    Number(value.chapterMinWords) >= Number(value.chapterMaxWords);
  const actualNames = Object.keys(value);
  if (actualNames.length !== expectedNames.length ||
      expectedNames.some((name) => typeof value[name] !== 'string') ||
      actualNames.some((name) => !expectedNames.includes(name)) ||
      fields.some((field) => field.required && !(value[field.name] as string).trim()) ||
      invalidNumberField ||
      invalidChapterWordRange ||
      fields.some((field) => field.options && !field.allowCustom && value[field.name] !== '' && !field.options.includes(value[field.name] as string)) ||
      fields.some((field) => field.allowCustom && value[field.name] === CUSTOM_OPTION_VALUE)) {
    return undefined;
  }

  if (workflow.supportsImageAttachments) {
    try {
      parseImageAttachments(value[IMAGE_ATTACHMENTS_FIELD] as string);
    } catch {
      return undefined;
    }
  }

  return Object.fromEntries(expectedNames.map((name) => [name, value[name] as string]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 生成带有工作流字段和操作按钮的表单页面。 */
function createFormHtml(
  workflow: FormWorkflow,
  initialValues: FormValues,
  projects: readonly WorkProject[],
  generatedContentTasks: readonly GeneratedContentTask[]
): string {
  const nonce = createNonce();
  const imageAttachments = workflow.supportsImageAttachments
    ? parseImageAttachments(initialValues[IMAGE_ATTACHMENTS_FIELD])
    : [];
  const imageAttachmentField = workflow.supportsImageAttachments
    ? `<section class="image-attachment-area" id="image-attachment-area" data-initial-images="${escapeHtml(JSON.stringify(imageAttachments))}" aria-label="图片附件">
        <h2 class="attachment-title">图片附件</h2>
        <div class="image-grid" id="image-grid"></div>
        <input class="image-file-input" id="image-file-input" type="file" accept="image/png,image/jpeg" multiple>
        <p class="image-status" id="image-status" role="status" aria-live="polite"></p>
      </section>`
    : '';
  const defaultProjectId = workflow.requiresProject ? projects[0]?.id ?? '' : '0';
  const selectedProjectId = initialValues.projectId ?? defaultProjectId;
  const renderWorkflowField = (field: FormField): string => {
    const renderedField = renderField(field, initialValues[field.name] ?? field.defaultValue ?? '', generatedContentTasks, selectedProjectId);
    return field.name === 'taskName' ? renderedField + imageAttachmentField : renderedField;
  };
  const projectContentTaskField = workflow.fields
    .filter((field) => field.projectContentTask)
    .map(renderWorkflowField)
    .join('');
  const fields = workflow.fields.filter((field) => !field.projectContentTask).map((field) =>
    renderWorkflowField(field)
  ).join('');
  const trailingImageAttachmentField = workflow.supportsImageAttachments &&
    !workflow.fields.some((field) => field.name === 'taskName') ? imageAttachmentField : '';
  const projectField = renderWorkProjectField(projects, initialValues.projectId ?? defaultProjectId, workflow.requiresProject === true);
  const runButton = workflow.showRunButton === false
    ? ''
    : '<button class="primary" id="submit" type="submit">保存并运行</button>';

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <title>${escapeHtml(workflow.title)}参数</title>
  <style nonce="${nonce}">
    :root {
      color-scheme: light dark;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 28px; }
    main { max-width: 1080px; margin: 0 auto; }
    h1 { margin: 0 0 8px; font-size: 22px; font-weight: 600; }
    .notice { margin: 0 0 22px; color: var(--vscode-descriptionForeground); line-height: 1.55; }
    form { display: grid; grid-template-columns: minmax(0, 1fr); gap: 18px; }
    .image-attachment-area {
      min-width: 0; padding: 10px; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 4px;
    }
    .attachment-title { margin: 0 0 8px; font-size: 13px; font-weight: 600; }
    .image-grid { display: flex; min-width: 0; flex-wrap: wrap; gap: 8px; }
    .image-card, .image-add {
      position: relative; width: 88px; height: 88px; flex: 0 0 88px; overflow: hidden;
      border: 1px solid var(--vscode-panel-border); border-radius: 3px;
    }
    .image-card img { display: block; width: 100%; height: 100%; object-fit: cover; }
    .image-remove {
      position: absolute; top: 3px; right: 3px; min-width: 24px; min-height: 24px;
      padding: 0; color: var(--vscode-button-foreground); background: var(--vscode-button-background);
      font-size: 18px; line-height: 1;
    }
    .image-add {
      display: grid; place-items: center; padding: 0; color: var(--vscode-descriptionForeground);
      background: var(--vscode-input-background); border-style: dashed;
    }
    .image-add:hover { color: var(--vscode-foreground); background: var(--vscode-list-hoverBackground); }
    .image-add-symbol { font-size: 36px; font-weight: 300; line-height: 1; }
    .image-file-input { display: none; }
    .image-status { min-height: 0; margin: 6px 0 0; color: var(--vscode-errorForeground); font-size: 12px; }
    .image-status:empty { display: none; }
    .field { display: flex; min-width: 0; flex-direction: column; gap: 7px; }
    .field[hidden] { display: none; }
    .field-heading { display: flex; min-width: 0; align-items: baseline; flex-wrap: wrap; gap: 4px 10px; }
    label { font-size: 13px; font-weight: 600; }
    .field-label { font-size: 13px; font-weight: 600; }
    .field-description { color: var(--vscode-foreground); opacity: .82; font-size: 12px; }
    textarea, select {
      width: 100%; resize: none; padding: 9px 10px;
      color: var(--vscode-input-foreground); background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 3px; font: inherit; line-height: 1.45;
    }
    input[type="number"] {
      width: 100%; min-height: 38px; padding: 9px 10px;
      color: var(--vscode-input-foreground); background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 3px; font: inherit; line-height: 1.45;
    }
    input[type="number"]:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    textarea { max-height: calc(17.4em + 20px); overflow-y: auto; }
    select { min-height: 38px; resize: none; }
    .project-picker { position: relative; width: 100%; }
    .project-picker-trigger {
      display: flex; width: 100%; min-height: 38px; align-items: center; justify-content: space-between;
      gap: 12px; padding: 9px 10px; color: var(--vscode-input-foreground);
      background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 3px; font: inherit; line-height: 1.45; text-align: left;
    }
    .project-picker-trigger.is-scope-option { color: var(--vscode-textLink-foreground); }
    .project-picker-trigger:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
    .project-picker-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .project-picker-chevron {
      width: 8px; height: 8px; flex: 0 0 auto; margin: -4px 2px 0 0;
      border-right: 1px solid currentColor; border-bottom: 1px solid currentColor; transform: rotate(45deg);
    }
    .project-picker-menu {
      position: absolute; z-index: 5; top: calc(100% + 2px); right: 0; left: 0;
      max-height: min(240px, 50vh); overflow-y: auto; padding: 3px;
      background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      border-radius: 3px; box-shadow: 0 3px 8px var(--vscode-widget-shadow);
    }
    .project-picker-menu[hidden] { display: none; }
    .project-picker-option {
      display: block; width: 100%; min-height: 32px; padding: 5px 9px; overflow: hidden;
      color: var(--vscode-input-foreground); background: transparent; border: 0;
      font: inherit; line-height: 1.45; text-align: left; text-overflow: ellipsis; white-space: nowrap;
    }
    .project-picker-option.is-scope-option { color: var(--vscode-textLink-foreground); }
    .project-picker-option:hover,
    .project-picker-option:focus-visible {
      background: var(--vscode-list-hoverBackground);
      background: color-mix(in srgb, var(--vscode-list-hoverBackground) 90%, #FFFFFF);
      outline: none;
    }
    .project-picker-option[aria-selected="true"] {
      color: var(--vscode-list-inactiveSelectionForeground, var(--vscode-input-foreground));
      background: var(--vscode-list-inactiveSelectionBackground);
    }
    .project-picker-option.is-scope-option[aria-selected="true"] { color: var(--vscode-textLink-foreground); }
    .select-with-custom { display: flex; width: 100%; min-width: 0; gap: 8px; }
    .select-with-custom select { flex: 1 1 100%; min-width: 0; }
    .select-with-custom.has-custom select { flex: 0 1 auto; max-width: 55%; }
    .select-with-custom.custom-input-below { flex-direction: column; align-items: stretch; }
    .select-with-custom.custom-input-below select { flex: none; width: 100%; max-width: none; }
    .select-with-custom.custom-input-below .custom-option { width: 100%; box-sizing: border-box; }
    .custom-option {
      flex: 1 1 0; min-width: 0; padding: 9px 10px;
      color: var(--vscode-input-foreground); background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 3px; font: inherit; line-height: 1.45;
    }
    .custom-option[hidden] { display: none; }
    textarea:focus, select:focus, .custom-option:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    textarea::placeholder { color: var(--vscode-input-placeholderForeground); }
    .actions { display: flex; align-items: center; justify-content: flex-end; gap: 24px; padding-top: 4px; }
    .secondary-actions { display: flex; align-items: center; gap: 8px; }
    button { min-height: 30px; padding: 5px 13px; border: 0; border-radius: 3px; font: inherit; cursor: pointer; }
    button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
    button:disabled { opacity: .65; cursor: wait; }
    .secondary { color: #273746; background: #E8EDF2; }
    .secondary:hover { background: #DDE4EA; }
    .secondary-actions #save { color: var(--vscode-button-foreground); background: var(--vscode-button-background); font-weight: 600; }
    .secondary-actions #save:hover { background: var(--vscode-button-hoverBackground); }
    .primary { color: #18374A; background: #D7EAF5; }
    .primary:hover { background: #C8E0EE; }
    #status { min-height: 20px; color: var(--vscode-errorForeground); }
    @media (max-width: 680px) {
      body { padding: 18px; }
      form { gap: 15px; }
    }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(workflow.title)}</h1>
    <p class="notice">${escapeHtml(workflow.notice)}选择“保存并运行”后，Copilot 将使用表单内容继续执行。</p>
    <form id="parameter-form">
      ${projectField}
      ${projectContentTaskField}
      ${fields}
      ${trailingImageAttachmentField}
      <div id="status" role="status" aria-live="polite"></div>
      <div class="actions">
        <div class="secondary-actions">
          <button class="secondary" id="cancel" type="button">取消</button>
          <button class="secondary" id="save" type="button">保存</button>
        </div>
        ${runButton}
      </div>
    </form>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const form = document.getElementById('parameter-form');
    const saveButton = document.getElementById('save');
    const submitButton = document.getElementById('submit');
    const canRunPrompt = ${workflow.showRunButton !== false};
    const status = document.getElementById('status');
    const imageAttachmentArea = document.getElementById('image-attachment-area');
    const projectSelect = document.getElementById('projectId');
    const projectPicker = document.getElementById('project-picker');
    const projectPickerTrigger = document.getElementById('project-picker-trigger');
    const projectPickerLabel = document.getElementById('project-picker-label');
    const projectPickerMenu = document.getElementById('project-picker-menu');
    const projectPickerOptions = Array.from(projectPickerMenu.querySelectorAll('[role="option"]'));
    function updateProjectContentTaskOptions() {
      document.querySelectorAll('[data-project-content-task]').forEach((select) => {
        Array.from(select.options).forEach((option) => {
          if (option.dataset.projectId) option.hidden = option.dataset.projectId !== projectSelect.value;
        });
        if (select.selectedOptions[0]?.dataset.projectId !== projectSelect.value) select.value = '';
      });
    }
    projectSelect.addEventListener('change', updateProjectContentTaskOptions);
    updateProjectContentTaskOptions();
    function closeProjectPicker(returnFocus = false) {
      projectPickerMenu.hidden = true;
      projectPickerTrigger.setAttribute('aria-expanded', 'false');
      if (returnFocus) projectPickerTrigger.focus();
    }

    function openProjectPicker(focusIndex) {
      projectPickerMenu.hidden = false;
      projectPickerTrigger.setAttribute('aria-expanded', 'true');
      const selectedIndex = projectPickerOptions.findIndex((option) => option.getAttribute('aria-selected') === 'true');
      projectPickerOptions[Math.max(0, Math.min(focusIndex ?? selectedIndex, projectPickerOptions.length - 1))]?.focus();
    }

    projectPickerTrigger.addEventListener('click', () => {
      if (projectPickerMenu.hidden) openProjectPicker();
      else closeProjectPicker();
    });
    projectPickerTrigger.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openProjectPicker();
      }
    });
    projectPickerOptions.forEach((option, index) => {
      option.addEventListener('click', () => {
        projectSelect.value = option.dataset.value;
        projectPickerLabel.textContent = option.textContent;
        projectPickerTrigger.classList.toggle('is-scope-option', option.classList.contains('is-scope-option'));
        projectPickerOptions.forEach((candidate) => {
          candidate.setAttribute('aria-selected', String(candidate === option));
        });
        projectSelect.dispatchEvent(new Event('change', { bubbles: true }));
        closeProjectPicker(true);
      });
      option.addEventListener('keydown', (event) => {
        let nextIndex;
        if (event.key === 'ArrowDown') nextIndex = Math.min(index + 1, projectPickerOptions.length - 1);
        else if (event.key === 'ArrowUp') nextIndex = Math.max(index - 1, 0);
        else if (event.key === 'Home') nextIndex = 0;
        else if (event.key === 'End') nextIndex = projectPickerOptions.length - 1;
        else if (event.key === 'Escape') {
          event.preventDefault();
          closeProjectPicker(true);
          return;
        } else if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          option.click();
          return;
        } else return;
        event.preventDefault();
        projectPickerOptions[nextIndex].focus();
      });
    });
    projectPicker.addEventListener('focusout', (event) => {
      if (!projectPicker.contains(event.relatedTarget)) closeProjectPicker();
    });
    document.addEventListener('pointerdown', (event) => {
      if (!projectPicker.contains(event.target)) closeProjectPicker();
    });
    let imageAttachments = imageAttachmentArea
      ? JSON.parse(imageAttachmentArea.dataset.initialImages)
      : [];

    // 绘制缩略图，并将添加入口保持在图片列表末尾。
    function renderImageAttachments() {
      if (!imageAttachmentArea) {
        return;
      }

      const imageGrid = document.getElementById('image-grid');
      const fileInput = document.getElementById('image-file-input');
      imageGrid.replaceChildren();
      imageAttachments.forEach((attachment, index) => {
        const card = document.createElement('div');
        card.className = 'image-card';
        const image = document.createElement('img');
        image.src = 'data:' + attachment.mimeType + ';base64,' + attachment.data;
        image.alt = '图片 ' + (index + 1);
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'image-remove';
        remove.textContent = '×';
        remove.title = '移除图片';
        remove.setAttribute('aria-label', '移除第 ' + (index + 1) + ' 张图片');
        remove.addEventListener('click', () => {
          imageAttachments.splice(index, 1);
          renderImageAttachments();
        });
        card.append(image, remove);
        imageGrid.append(card);
      });

      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'image-add';
      add.title = '添加图片';
      add.setAttribute('aria-label', '添加图片');
      const plus = document.createElement('span');
      plus.className = 'image-add-symbol';
      plus.textContent = '+';
      add.append(plus);
      add.addEventListener('click', () => fileInput.click());
      imageGrid.append(add);
    }

    // 将上传或粘贴的文件读取为可传递的图片数据。
    function readImageFile(file) {
      return new Promise((resolve, reject) => {
        if (file.type !== 'image/png' && file.type !== 'image/jpeg') {
          reject(new Error('仅支持 PNG 和 JPEG 图片。'));
          return;
        }
        if (file.size > ${MAX_IMAGE_FILE_BYTES}) {
          reject(new Error('单张图片不能超过 10 MB。'));
          return;
        }

        const reader = new FileReader();
        reader.onerror = () => reject(new Error('读取图片失败，请重新选择。'));
        reader.onload = () => {
          if (typeof reader.result !== 'string') {
            reject(new Error('读取图片失败，请重新选择。'));
            return;
          }
          const dataUrl = /^data:(image\\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(reader.result);
          if (!dataUrl) {
            reject(new Error('图片内容不是有效的 PNG 或 JPEG 数据。'));
            return;
          }
          resolve({ mimeType: dataUrl[1], data: dataUrl[2] });
        };
        reader.readAsDataURL(file);
      });
    }

    // 校验并静默去重后，将新图片追加到当前列表。
    async function addImageFiles(fileList) {
      const files = Array.from(fileList);
      if (files.length === 0) {
        return;
      }

      const imageStatus = document.getElementById('image-status');
      try {
        const addedImages = await Promise.all(files.map(readImageFile));
        const knownImageData = new Set(imageAttachments.map((attachment) => attachment.data));
        const uniqueImages = addedImages.filter((attachment) => {
          if (knownImageData.has(attachment.data)) {
            return false;
          }
          knownImageData.add(attachment.data);
          return true;
        });
        if (uniqueImages.length === 0) {
          return;
        }

        if (imageAttachments.length + uniqueImages.length > ${MAX_IMAGE_COUNT}) {
          imageStatus.textContent = '图片最多添加 ${MAX_IMAGE_COUNT} 张。';
          return;
        }

        const totalBytes = [...imageAttachments, ...uniqueImages]
          .reduce((total, attachment) => total + Math.ceil(attachment.data.length * 3 / 4), 0);
        if (totalBytes > ${MAX_IMAGE_TOTAL_BYTES}) {
          throw new Error('图片附件总大小不能超过 25 MB。');
        }
        imageAttachments.push(...uniqueImages);
        imageStatus.textContent = '';
        renderImageAttachments();
      } catch (error) {
        imageStatus.textContent = error instanceof Error ? error.message : String(error);
      }
    }

    if (imageAttachmentArea) {
      const fileInput = document.getElementById('image-file-input');
      fileInput.addEventListener('change', () => {
        void addImageFiles(fileInput.files);
        fileInput.value = '';
      });
      window.addEventListener('paste', (event) => {
        if (!imageAttachmentArea.matches(':hover') && !imageAttachmentArea.contains(document.activeElement)) {
          return;
        }

        const pastedImages = Array.from(event.clipboardData?.items ?? [])
          .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
          .map((item) => item.getAsFile())
          .filter((file) => file !== null);
        if (pastedImages.length > 0) {
          event.preventDefault();
          void addImageFiles(pastedImages);
        }
      });
      renderImageAttachments();
    }

    // 表单文本框随内容增高，避免手动拖动尺寸。
    document.querySelectorAll('textarea').forEach((textarea) => {
      const resizeTextarea = () => {
        textarea.style.height = 'auto';
        textarea.style.height = textarea.scrollHeight + 'px';
      };
      textarea.addEventListener('input', resizeTextarea);
      resizeTextarea();
    });

    function sendFormValues(runPrompt) {
      if (runPrompt && !canRunPrompt) return;
      const projectId = projectSelect.value;
      if (${workflow.requiresProject === true} && !projectId) {
        status.textContent = '请先选择所属项目。';
        return;
      }
      if (!form.reportValidity()) {
        return;
      }
      const formData = new FormData(form);
      const values = Object.fromEntries(
        [...formData.entries()].filter(([name]) => name !== 'projectId' && !name.endsWith('__custom'))
      );
      document.querySelectorAll('[data-custom-input]').forEach((select) => {
        if (select.value === '${CUSTOM_OPTION_VALUE}') {
          const customInput = document.getElementById(select.dataset.customInput);
          values[select.name] = customInput.value;
        }
      });
      if (imageAttachmentArea) {
        values['${IMAGE_ATTACHMENTS_FIELD}'] = JSON.stringify(imageAttachments);
      }
      saveButton.disabled = true;
      if (submitButton) submitButton.disabled = true;
      status.textContent = '';
      vscode.postMessage({
        command: runPrompt ? 'submit' : 'save',
        values,
        projectId
      });
    }

    document.querySelectorAll('[data-custom-input]').forEach((select) => {
      const customInput = document.getElementById(select.dataset.customInput);
      const wrapper = select.closest('.select-with-custom');
      const updateCustomInput = () => {
        const isCustom = select.value === '${CUSTOM_OPTION_VALUE}';
        customInput.hidden = !isCustom;
        customInput.disabled = !isCustom;
        customInput.required = isCustom;
        wrapper.classList.toggle('has-custom', isCustom);
        if (isCustom) {
          const canvas = document.createElement('canvas');
          const context = canvas.getContext('2d');
          if (context) {
            context.font = getComputedStyle(select).font;
            const textWidth = context.measureText(select.selectedOptions[0].textContent).width;
            select.style.width = \`\${Math.ceil(textWidth + 42)}px\`;
          }
        } else {
          select.style.width = '';
        }
      };

      select.addEventListener('change', updateCustomInput);
      updateCustomInput();
    });

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (canRunPrompt) sendFormValues(true);
    });

    saveButton.addEventListener('click', () => sendFormValues(false));

    document.getElementById('cancel').addEventListener('click', () => {
      vscode.postMessage({ command: 'cancel' });
    });

    window.addEventListener('message', (event) => {
      if (event.data.command === 'validation-error') {
        saveButton.disabled = false;
        if (submitButton) submitButton.disabled = false;
        status.textContent = event.data.text;
      }
    });
  </script>
</body>
</html>`;
}

/** 生成固定在任务参数表单顶部的项目归属选择项。 */
function renderWorkProjectField(projects: readonly WorkProject[], selectedWorkProjectId: string, required: boolean): string {
  const options = [
    ...(!required ? [{ id: '0', name: '未归属项目', isScopeOption: true }] : []),
    ...projects.map((project) => ({ id: project.id, name: project.name, isScopeOption: false }))
  ];
  const nativeOptions = options.map((option) =>
    `<option value="${escapeHtml(option.id)}"${option.id === selectedWorkProjectId ? ' selected' : ''}>${escapeHtml(option.name)}</option>`
  ).join('');
  const pickerOptions = options.map((option) => {
    const isSelected = option.id === selectedWorkProjectId;
    const classes = ['project-picker-option'];
    if (option.isScopeOption) classes.push('is-scope-option');
    return `<button class="${classes.join(' ')}" type="button" role="option" data-value="${escapeHtml(option.id)}" aria-selected="${isSelected}">${escapeHtml(option.name)}</button>`;
  }).join('');
  const selectedOption = options.find((option) => option.id === selectedWorkProjectId) ?? options[0];
  return `<div class="field">
    <div class="field-heading"><span class="field-label" id="projectId-label">所属项目</span></div>
    <div class="project-picker" id="project-picker">
      <select id="projectId" name="projectId" hidden aria-hidden="true" tabindex="-1">${nativeOptions}</select>
      <button class="project-picker-trigger${selectedOption?.isScopeOption ? ' is-scope-option' : ''}" id="project-picker-trigger" type="button" aria-labelledby="projectId-label project-picker-label" aria-haspopup="listbox" aria-controls="project-picker-menu" aria-expanded="false">
        <span class="project-picker-label" id="project-picker-label">${escapeHtml(selectedOption?.name ?? '请选择项目')}</span>
        <span class="project-picker-chevron" aria-hidden="true"></span>
      </button>
      <div class="project-picker-menu" id="project-picker-menu" role="listbox" aria-labelledby="projectId-label" hidden>${pickerOptions}</div>
    </div>
  </div>`;
}

/** 转义内嵌脚本数据，避免用户文本结束脚本标签。 */
function serializeForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function renderField(
  field: FormField,
  initialValue: string,
  generatedContentTasks: readonly GeneratedContentTask[] = [],
  selectedProjectId = '0'
): string {
  const name = escapeHtml(field.name);
  const label = escapeHtml(field.label);
  const description = escapeHtml(field.description);
  const placeholder = field.placeholder ? ` placeholder="${escapeHtml(field.placeholder)}"` : '';
  const required = field.required ? ' required' : '';
  const numericAttributes = field.inputType === 'number'
    ? ` type="number" step="1" inputmode="numeric"${field.min === undefined ? '' : ` min="${field.min}"`}${field.max === undefined ? '' : ` max="${field.max}"`}`
    : '';
  const control = field.projectContentTask
    ? `<select id="${name}" name="${name}" data-project-content-task${required}>${[
      `<option value=""${initialValue === '' ? ' selected' : ''}>请选择创作任务</option>`,
      ...generatedContentTasks.map((task) => `<option value="${escapeHtml(task.id)}" data-project-id="${escapeHtml(task.projectId)}"${task.projectId !== selectedProjectId ? ' hidden' : ''}${task.id === initialValue ? ' selected' : ''}>${escapeHtml(task.taskName)}</option>`)
    ].join('')}</select>`
    : field.options
    ? `<div class="select-with-custom${field.customInputBelow ? ' custom-input-below' : ''}">
        <select id="${name}" name="${name}"${required}${field.allowCustom ? ` data-custom-input="${name}-custom"` : ''}>
          <option value=""${initialValue === '' ? ' selected' : ''}>请选择</option>
          ${field.options.map((option) => `<option value="${escapeHtml(option)}"${initialValue === option ? ' selected' : ''}>${escapeHtml(option)}</option>`).join('')}
          ${field.allowCustom ? `<option value="${CUSTOM_OPTION_VALUE}"${initialValue !== '' && !field.options?.includes(initialValue) ? ' selected' : ''}>其他</option>` : ''}
        </select>
        ${field.allowCustom ? `<input class="custom-option" id="${name}-custom" name="${name}__custom" type="text" placeholder="输入自定义内容" value="${initialValue !== '' && !field.options.includes(initialValue) ? escapeHtml(initialValue) : ''}" disabled hidden>` : ''}
      </div>`
    : field.inputType === 'number'
      ? `<input id="${name}" name="${name}"${numericAttributes}${placeholder}${required} value="${escapeHtml(initialValue)}">`
      : `<textarea id="${name}" name="${name}"${placeholder}${required} rows="1" spellcheck="true">${escapeHtml(initialValue)}</textarea>`;

  return `<div class="field">
        <div class="field-heading">
          <label for="${name}">${label}</label>
          <span class="field-description">${description}</span>
        </div>
        ${control}
      </div>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    };

    return entities[character];
  });
}

function createNonce(): string {
  const values = new Uint8Array(24);
  globalThis.crypto.getRandomValues(values);
  return Array.from(values, (value) => value.toString(16).padStart(2, '0')).join('');
}

/** 生成可嵌入记录列表添加对话框的工作流字段。 */
export function renderAddRecordFields(
  workflow: FormWorkflow,
  projects: readonly WorkProject[],
  initialValues: FormValues = {},
  generatedContentTasks: readonly GeneratedContentTask[] = []
): string {
  const projectOptions = [
    ...(workflow.requiresProject
      ? [`<option value=""${initialValues.projectId ? '' : ' selected'}>请选择所属项目</option>`]
      : []),
    ...(!workflow.requiresProject ? [`<option value="0"${(initialValues.projectId ?? '0') === '0' ? ' selected' : ''}>未归属项目</option>`] : []),
    ...projects.map((project) =>
      `<option value="${escapeHtml(project.id)}"${initialValues.projectId === project.id ? ' selected' : ''}>${escapeHtml(project.name)}</option>`
    )
  ].join('');
  const selectedProjectId = initialValues.projectId ?? (workflow.requiresProject ? '' : '0');
  const projectField = `<div class="field">
    <div class="field-heading"><label for="add-record-project">所属项目</label></div>
    <select id="add-record-project" name="projectId"${workflow.requiresProject ? ' required' : ''}>${projectOptions}</select>
  </div>`;
  const imageField = workflow.supportsImageAttachments
    ? `<section class="add-image-area" aria-label="图片附件">
        <h3>图片附件</h3>
        <div id="add-image-grid" class="image-grid"></div>
        <input id="add-image-file-input" type="file" accept="image/png,image/jpeg" multiple>
        <input id="add-image-value" name="${IMAGE_ATTACHMENTS_FIELD}" type="hidden" value="${escapeHtml(initialValues[IMAGE_ATTACHMENTS_FIELD] ?? '[]')}">
        <p id="add-image-status" role="status" aria-live="polite"></p>
      </section>`
    : '';
  function renderAddRecordField(field: FormField): string {
    const renderedField = renderField(field, initialValues[field.name] ?? field.defaultValue ?? '', generatedContentTasks, selectedProjectId);
    return field.name === 'taskName' ? renderedField + imageField : renderedField;
  }
  const projectContentTaskFields = workflow.fields.filter((field) => field.projectContentTask).map((field) =>
    renderAddRecordField(field)
  ).join('');
  const fields = workflow.fields.filter((field) => !field.projectContentTask).map((field) =>
    renderAddRecordField(field)
  ).join('');
  const trailingImageField = workflow.supportsImageAttachments &&
    !workflow.fields.some((field) => field.name === 'taskName') ? imageField : '';
  return `${projectField}${projectContentTaskFields}${fields}${trailingImageField}`;
}